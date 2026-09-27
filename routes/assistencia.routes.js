'use strict';

/**
 * Rotas do Módulo de Assistência Técnica — LF ERP
 *
 * ISOLAMENTO: Todas as rotas exigem:
 *   1. auth — usuário autenticado (JWT)
 *   2. requireFeatureHabilitada — empresa_id do token deve ter 'assistencia_tecnica' = TRUE em empresa_features
 *   3. requirePermissao — permissão granular sobre o recurso
 *   4. validarAcessoEmpresa — empresa_id do token coincide com os dados solicitados
 *
 * HTTP 403 para qualquer empresa que não tenha o feature habilitado.
 */

const { requirePermissao } = require('../utils/permissoes');
const { erro, ok } = require('../utils/routeHelpers');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  normalizarInt,
  normalizarDataISO,
  hoje,
  registrarMovimentacaoEstoque,
  criarParcelasContasReceber,
}) => {
  const router = require('express').Router();

  // ── Middleware: valida feature 'assistencia_tecnica' pelo empresa_id do token ──
  async function requireFeatureHabilitada(req, res, next) {
    try {
      if (req.user?.is_saas_owner) return next();
      const empresaId = req.user?.empresa_id;
      if (!empresaId) return erro(res, 403, 'Empresa não identificada');

      const r = await pool.query(
        `SELECT habilitado FROM empresa_features WHERE empresa_id = $1 AND feature = $2`,
        [empresaId, 'assistencia_tecnica']
      );
      if (!r.rows[0]?.habilitado) {
        return erro(res, 403, 'Módulo de Assistência Técnica não habilitado para esta empresa');
      }
      next();
    } catch (e) {
      console.error('[assistencia] requireFeatureHabilitada:', e);
      return erro(res, 500, 'Erro ao verificar acesso ao módulo');
    }
  }

  // Aplica o middleware de feature em todas as rotas deste router
  router.use(auth, requireFeatureHabilitada);

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPRESA FEATURES — endpoint público (auth apenas, sem feature gate)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Helpers internos ────────────────────────────────────────────────────────

  async function gerarNumeroOS(empresaId, empresaNome) {
    const r = await pool.query(
      `SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(numero, '[^0-9]', '', 'g') AS INTEGER)), 0) + 1 AS prox
       FROM ordens_servico
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`,
      [empresaId, empresaNome]
    );
    return `OS-${String(r.rows[0].prox).padStart(5, '0')}`;
  }

  async function recalcularTotaisOS(client, osId) {
    await client.query(
      `UPDATE ordens_servico
       SET valor_pecas = COALESCE((SELECT SUM(valor_total) FROM ordens_servico_itens WHERE os_id = $1), 0),
           valor_total = valor_mao_obra + COALESCE((SELECT SUM(valor_total) FROM ordens_servico_itens WHERE os_id = $1), 0),
           atualizado_em = NOW()
       WHERE id = $1`,
      [osId]
    );
  }

  async function registrarEvento(client, { osId, empresaId, tipo, descricao, usuarioId, usuarioNome }) {
    await client.query(
      `INSERT INTO at_eventos (os_id, empresa_id, tipo, descricao, usuario_id, usuario_nome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [osId, empresaId, tipo, descricao, usuarioId || null, usuarioNome || null]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════

  router.get('/dashboard', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');
      const eid = empresaResolvida.id;
      const en  = empresaResolvida.nome;
      const filtro = `(empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;

      const [status, faturamento] = await Promise.all([
        pool.query(
          `SELECT status, COUNT(*) AS qtd FROM ordens_servico
           WHERE ${filtro} GROUP BY status`,
          [eid, en]
        ),
        pool.query(
          `SELECT
             COALESCE(SUM(valor_total),0)     AS faturamento,
             COALESCE(SUM(valor_mao_obra),0)  AS receita_servico,
             COALESCE(SUM(valor_pecas),0)     AS receita_pecas,
             COUNT(*)                          AS total,
             COALESCE(AVG(valor_total),0)      AS ticket_medio
           FROM ordens_servico
           WHERE ${filtro}
             AND status NOT IN ('cancelada','reprovada')
             AND data_entrada >= NOW() - INTERVAL '30 days'`,
          [eid, en]
        ),
      ]);

      const qtd = {};
      status.rows.forEach(r => { qtd[r.status] = Number(r.qtd); });

      const fat = faturamento.rows[0];
      const totalOS = status.rows.reduce((s, r) => s + Number(r.qtd), 0);
      const aprovadas = (qtd.aprovada || 0) + (qtd.em_execucao || 0) + (qtd.pronto || 0) + (qtd.entregue || 0);
      const enviadas  = aprovadas + (qtd.orcamento_enviado || 0) + (qtd.aguardando_aprovacao || 0) + (qtd.reprovada || 0);
      const taxaAprovacao = enviadas > 0 ? Math.round((aprovadas / enviadas) * 100) : null;

      return ok(res, {
        kpis: {
          os_abertas:           qtd.aberta || 0,
          em_diagnostico:       qtd.diagnostico || 0,
          aguardando_orcamento: qtd.orcamento_enviado || 0,
          aguardando_aprovacao: qtd.aguardando_aprovacao || 0,
          em_manutencao:        qtd.em_execucao || 0,
          aguardando_peca:      qtd.aguardando_peca || 0,
          prontas:              qtd.pronto || 0,
          entregues_30d:        qtd.entregue || 0,
          faturamento_30d:      Number(fat.faturamento),
          ticket_medio:         Number(fat.ticket_medio),
          taxa_aprovacao:       taxaAprovacao,
          total:                totalOS,
        },
        por_status: status.rows,
      });
    } catch (e) {
      console.error('[assistencia] GET /dashboard:', e);
      return erro(res, 500, 'Erro ao carregar dashboard');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ORDENS DE SERVIÇO (AT — vista completa)
  // ═══════════════════════════════════════════════════════════════════════════

  router.get('/os', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const { empresa, status, busca, cliente_id, limit = 50, offset = 0 } = req.query;
      const er = await validarAcessoEmpresa(req, empresa);
      if (!er) return erro(res, 403, 'Sem acesso');

      const params = [er.id, er.nome];
      const conds  = [`(os.empresa_id = $1 OR (os.empresa_id IS NULL AND os.empresa = $2))`];
      let p = 3;

      if (status) { conds.push(`os.status = $${p++}`); params.push(status); }
      if (cliente_id) { conds.push(`os.cliente_id = $${p++}`); params.push(Number(cliente_id)); }
      if (busca) {
        conds.push(`(os.numero ILIKE $${p} OR os.equipamento_marca ILIKE $${p} OR os.equipamento_modelo ILIKE $${p} OR c.nome ILIKE $${p} OR os.equipamento_imei1 ILIKE $${p} OR c.telefone ILIKE $${p})`);
        params.push(`%${busca}%`); p++;
      }

      params.push(Number(limit), Number(offset));

      const sql = `
        SELECT os.id, os.numero, os.status, os.orcamento_status,
               os.equipamento_tipo, os.equipamento_marca, os.equipamento_modelo,
               os.equipamento_imei1, os.equipamento_cor,
               os.tecnico, os.valor_mao_obra, os.valor_pecas, os.valor_total,
               os.data_entrada, os.data_prevista, os.data_conclusao,
               os.defeito_cliente, os.problema_relatado, os.criado_em, os.aparelho_id,
               c.id AS cliente_id, c.nome AS cliente_nome, c.telefone AS cliente_telefone,
               (SELECT COUNT(*) FROM at_garantias g WHERE g.os_id = os.id AND g.data_fim >= CURRENT_DATE) > 0 AS tem_garantia_ativa
        FROM ordens_servico os
        LEFT JOIN clientes c ON c.id = os.cliente_id
        WHERE ${conds.join(' AND ')}
        ORDER BY os.criado_em DESC
        LIMIT $${p++} OFFSET $${p++}`;

      const countSql = `
        SELECT COUNT(*) AS total FROM ordens_servico os
        LEFT JOIN clientes c ON c.id = os.cliente_id
        WHERE ${conds.join(' AND ')}`;

      const [rows, cnt] = await Promise.all([
        pool.query(sql, params),
        pool.query(countSql, params.slice(0, -2)),
      ]);

      return ok(res, { ordens: rows.rows, total: Number(cnt.rows[0].total) });
    } catch (e) {
      console.error('[assistencia] GET /os:', e);
      return erro(res, 500, 'Erro ao listar ordens');
    }
  });

  router.post('/os', writeRateLimiter, requirePermissao(pool, 'assistencia_tecnica', 'criar'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const er = await validarAcessoEmpresa(req, req.body.empresa);
      if (!er) { await client.query('ROLLBACK'); return erro(res, 403, 'Sem acesso'); }

      const {
        cliente_id, equipamento_tipo, equipamento_marca, equipamento_modelo,
        equipamento_serie, equipamento_imei1, equipamento_imei2, equipamento_cor,
        equipamento_capacidade, equipamento_so, acessorios_entregues,
        defeito_cliente, problema_relatado, diagnostico, causa_provavel,
        procedimento_recomendado, tecnico, valor_mao_obra, data_prevista,
        observacoes, itens = [], checklist = [], aparelho_id,
      } = req.body;

      const numero  = await gerarNumeroOS(er.id, er.nome);
      const maoObra = normalizarDecimal(valor_mao_obra) || 0;

      const osRes = await client.query(
        `INSERT INTO ordens_servico (
           numero, empresa, empresa_id, cliente_id, status,
           equipamento_tipo, equipamento_marca, equipamento_modelo, equipamento_serie,
           equipamento_imei1, equipamento_imei2, equipamento_cor,
           equipamento_capacidade, equipamento_so, acessorios_entregues,
           defeito_cliente, problema_relatado, diagnostico, causa_provavel,
           procedimento_recomendado, tecnico, valor_mao_obra,
           data_prevista, observacoes, aparelho_id, data_entrada, criado_em, atualizado_em
         ) VALUES (
           $1,$2,$3,$4,'aberta',
           $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
           NOW(),NOW(),NOW()
         ) RETURNING id`,
        [
          numero, er.nome, er.id, normalizarInt(cliente_id) || null,
          equipamento_tipo || null, equipamento_marca || null, equipamento_modelo || null, equipamento_serie || null,
          equipamento_imei1 || null, equipamento_imei2 || null, equipamento_cor || null,
          equipamento_capacidade || null, equipamento_so || null, acessorios_entregues || null,
          defeito_cliente || null, problema_relatado || null, diagnostico || null,
          causa_provavel || null, procedimento_recomendado || null, tecnico || null,
          maoObra, normalizarDataISO(data_prevista) || null,
          observacoes || null, normalizarInt(aparelho_id) || null,
        ]
      );
      const osId = osRes.rows[0].id;

      // Insere itens (peças)
      for (const item of itens) {
        const qty  = normalizarDecimal(item.quantidade) || 1;
        const vUnit = normalizarDecimal(item.valor_unitario) || 0;
        const custo = normalizarDecimal(item.custo_unitario) || 0;
        await client.query(
          `INSERT INTO ordens_servico_itens (os_id, produto_id, descricao, quantidade, valor_unitario, valor_total, custo_unitario)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [osId, normalizarInt(item.produto_id) || null, item.descricao, qty, vUnit, qty * vUnit, custo]
        );
      }

      // Salva checklist
      for (const item of checklist) {
        await client.query(
          `INSERT INTO at_checklist (os_id, empresa_id, item_key, item_tipo, item_label, resultado, observacao)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (os_id, item_key) DO UPDATE SET resultado=$6, observacao=$7`,
          [osId, er.id, item.key, item.tipo, item.label, item.resultado || 'nao_testado', item.observacao || null]
        );
      }

      await recalcularTotaisOS(client, osId);

      // Evento de criação
      await registrarEvento(client, {
        osId, empresaId: er.id, tipo: 'criacao',
        descricao: `OS ${numero} criada`,
        usuarioId: req.user?.id, usuarioNome: req.user?.nome || req.user?.usuario,
      });

      await client.query('COMMIT');

      const final = await pool.query(
        `SELECT os.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone
         FROM ordens_servico os LEFT JOIN clientes c ON c.id = os.cliente_id WHERE os.id = $1`,
        [osId]
      );
      return ok(res, { ordem: final.rows[0] }, 201);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[assistencia] POST /os:', e);
      return erro(res, 500, 'Erro ao criar OS');
    } finally { client.release(); }
  });

  router.get('/os/:id', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const id = normalizarInt(req.params.id);
      if (!id) return erro(res, 400, 'ID inválido');
      const er = await validarAcessoEmpresa(req, req.query.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');

      const [osRes, itensRes, checkRes, eventosRes, garantiaRes] = await Promise.all([
        pool.query(
          `SELECT os.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone,
                  c.cpf AS cliente_cpf, c.endereco AS cliente_endereco, c.email AS cliente_email
           FROM ordens_servico os LEFT JOIN clientes c ON c.id = os.cliente_id
           WHERE os.id = $1 AND (os.empresa_id = $2 OR (os.empresa_id IS NULL AND os.empresa = $3))`,
          [id, er.id, er.nome]
        ),
        pool.query(
          `SELECT osi.*, p.nome AS produto_nome, p.estoque_atual AS produto_estoque
           FROM ordens_servico_itens osi
           LEFT JOIN produtos p ON p.id = osi.produto_id
           WHERE osi.os_id = $1 ORDER BY osi.id`,
          [id]
        ),
        pool.query(`SELECT * FROM at_checklist WHERE os_id = $1 ORDER BY id`, [id]),
        pool.query(`SELECT * FROM at_eventos WHERE os_id = $1 ORDER BY criado_em DESC`, [id]),
        pool.query(`SELECT * FROM at_garantias WHERE os_id = $1 ORDER BY criado_em DESC LIMIT 1`, [id]),
      ]);

      if (!osRes.rows[0]) return erro(res, 404, 'OS não encontrada');

      return ok(res, {
        ordem: osRes.rows[0],
        itens: itensRes.rows,
        checklist: checkRes.rows,
        eventos: eventosRes.rows,
        garantia: garantiaRes.rows[0] || null,
      });
    } catch (e) {
      console.error('[assistencia] GET /os/:id:', e);
      return erro(res, 500, 'Erro ao buscar OS');
    }
  });

  router.put('/os/:id', writeRateLimiter, requirePermissao(pool, 'assistencia_tecnica', 'editar'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = normalizarInt(req.params.id);
      if (!id) { await client.query('ROLLBACK'); return erro(res, 400, 'ID inválido'); }
      const er = await validarAcessoEmpresa(req, req.body.empresa);
      if (!er) { await client.query('ROLLBACK'); return erro(res, 403, 'Sem acesso'); }

      const check = await client.query(
        `SELECT id FROM ordens_servico WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, er.id, er.nome]
      );
      if (!check.rows[0]) { await client.query('ROLLBACK'); return erro(res, 404, 'OS não encontrada'); }

      const {
        cliente_id, equipamento_tipo, equipamento_marca, equipamento_modelo, equipamento_serie,
        equipamento_imei1, equipamento_imei2, equipamento_cor, equipamento_capacidade, equipamento_so,
        acessorios_entregues, defeito_cliente, problema_relatado, diagnostico, causa_provavel,
        procedimento_recomendado, tecnico, valor_mao_obra, data_prevista, data_conclusao,
        observacoes, itens = [], checklist = [], aparelho_id,
      } = req.body;

      await client.query(
        `UPDATE ordens_servico SET
           cliente_id=$1, equipamento_tipo=$2, equipamento_marca=$3, equipamento_modelo=$4,
           equipamento_serie=$5, equipamento_imei1=$6, equipamento_imei2=$7, equipamento_cor=$8,
           equipamento_capacidade=$9, equipamento_so=$10, acessorios_entregues=$11,
           defeito_cliente=$12, problema_relatado=$13, diagnostico=$14,
           causa_provavel=$15, procedimento_recomendado=$16, tecnico=$17,
           valor_mao_obra=$18, data_prevista=$19, data_conclusao=$20,
           observacoes=$21, aparelho_id=$22, atualizado_em=NOW()
         WHERE id=$23`,
        [
          normalizarInt(cliente_id) || null, equipamento_tipo || null, equipamento_marca || null,
          equipamento_modelo || null, equipamento_serie || null,
          equipamento_imei1 || null, equipamento_imei2 || null, equipamento_cor || null,
          equipamento_capacidade || null, equipamento_so || null, acessorios_entregues || null,
          defeito_cliente || null, problema_relatado || null, diagnostico || null,
          causa_provavel || null, procedimento_recomendado || null, tecnico || null,
          normalizarDecimal(valor_mao_obra) || 0,
          normalizarDataISO(data_prevista) || null,
          normalizarDataISO(data_conclusao) || null,
          observacoes || null, normalizarInt(aparelho_id) || null, id,
        ]
      );

      await client.query(`DELETE FROM ordens_servico_itens WHERE os_id = $1`, [id]);
      for (const item of itens) {
        const qty   = normalizarDecimal(item.quantidade) || 1;
        const vUnit = normalizarDecimal(item.valor_unitario) || 0;
        const custo = normalizarDecimal(item.custo_unitario) || 0;
        await client.query(
          `INSERT INTO ordens_servico_itens (os_id, produto_id, descricao, quantidade, valor_unitario, valor_total, custo_unitario)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, normalizarInt(item.produto_id) || null, item.descricao, qty, vUnit, qty * vUnit, custo]
        );
      }

      for (const item of checklist) {
        await client.query(
          `INSERT INTO at_checklist (os_id, empresa_id, item_key, item_tipo, item_label, resultado, observacao)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (os_id, item_key) DO UPDATE SET resultado=$6, observacao=$7`,
          [id, er.id, item.key, item.tipo, item.label, item.resultado || 'nao_testado', item.observacao || null]
        );
      }

      await recalcularTotaisOS(client, id);

      await registrarEvento(client, {
        osId: id, empresaId: er.id, tipo: 'edicao',
        descricao: 'OS atualizada',
        usuarioId: req.user?.id, usuarioNome: req.user?.nome || req.user?.usuario,
      });

      await client.query('COMMIT');
      return ok(res, { mensagem: 'OS atualizada com sucesso' });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[assistencia] PUT /os/:id:', e);
      return erro(res, 500, 'Erro ao atualizar OS');
    } finally { client.release(); }
  });

  // ── PATCH /assistencia/os/:id/status ─────────────────────────────────────────
  router.patch('/os/:id/status', writeRateLimiter, requirePermissao(pool, 'assistencia_tecnica', 'editar'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = normalizarInt(req.params.id);
      if (!id) { await client.query('ROLLBACK'); return erro(res, 400, 'ID inválido'); }

      const { status, empresa, observacao } = req.body;
      const statusValidos = ['aberta','diagnostico','orcamento_enviado','aguardando_aprovacao',
                             'aprovada','em_execucao','aguardando_peca','pronto','entregue','cancelada','reprovada'];
      if (!statusValidos.includes(status)) { await client.query('ROLLBACK'); return erro(res, 400, 'Status inválido'); }

      const er = await validarAcessoEmpresa(req, empresa);
      if (!er) { await client.query('ROLLBACK'); return erro(res, 403, 'Sem acesso'); }

      const extra = (status === 'entregue' || status === 'pronto') ? ', data_conclusao = NOW()' : '';
      const result = await client.query(
        `UPDATE ordens_servico SET status=$1${extra}, atualizado_em=NOW()
         WHERE id=$2 AND (empresa_id=$3 OR (empresa_id IS NULL AND empresa=$4))
         RETURNING id, numero, status`,
        [status, id, er.id, er.nome]
      );
      if (!result.rows[0]) { await client.query('ROLLBACK'); return erro(res, 404, 'OS não encontrada'); }

      const labels = {
        aberta:'Recebida', diagnostico:'Em Diagnóstico', orcamento_enviado:'Orçamento Enviado',
        aguardando_aprovacao:'Aguardando Aprovação', aprovada:'Aprovada', em_execucao:'Em Manutenção',
        aguardando_peca:'Aguardando Peça', pronto:'Pronto p/ Retirada', entregue:'Entregue',
        cancelada:'Cancelada', reprovada:'Reprovada',
      };
      const desc = observacao
        ? `Status alterado para ${labels[status] || status}: ${observacao}`
        : `Status alterado para ${labels[status] || status}`;

      await registrarEvento(client, {
        osId: id, empresaId: er.id, tipo: 'status',
        descricao: desc,
        usuarioId: req.user?.id, usuarioNome: req.user?.nome || req.user?.usuario,
      });

      await client.query('COMMIT');
      return ok(res, { mensagem: 'Status atualizado', status });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[assistencia] PATCH /os/:id/status:', e);
      return erro(res, 500, 'Erro ao atualizar status');
    } finally { client.release(); }
  });

  // ── POST /assistencia/os/:id/orcamento/aprovar ────────────────────────────────
  router.post('/os/:id/orcamento/aprovar', writeRateLimiter, requirePermissao(pool, 'assistencia_tecnica', 'editar'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = normalizarInt(req.params.id);
      if (!id) { await client.query('ROLLBACK'); return erro(res, 400, 'ID inválido'); }

      const { aprovado, empresa, observacao } = req.body;
      const er = await validarAcessoEmpresa(req, empresa);
      if (!er) { await client.query('ROLLBACK'); return erro(res, 403, 'Sem acesso'); }

      const novoOrcStatus  = aprovado ? 'aprovado'  : 'reprovado';
      const novoOSStatus   = aprovado ? 'aprovada'  : 'reprovada';

      await client.query(
        `UPDATE ordens_servico SET orcamento_status=$1, status=$2, atualizado_em=NOW()
         WHERE id=$3 AND (empresa_id=$4 OR (empresa_id IS NULL AND empresa=$5))`,
        [novoOrcStatus, novoOSStatus, id, er.id, er.nome]
      );

      const desc = aprovado
        ? `Orçamento APROVADO${observacao ? ': ' + observacao : ''}`
        : `Orçamento REPROVADO${observacao ? ': ' + observacao : ''}`;

      await registrarEvento(client, {
        osId: id, empresaId: er.id, tipo: aprovado ? 'aprovacao' : 'reprovacao',
        descricao: desc,
        usuarioId: req.user?.id, usuarioNome: req.user?.nome || req.user?.usuario,
      });

      await client.query('COMMIT');
      return ok(res, { mensagem: aprovado ? 'Orçamento aprovado' : 'Orçamento reprovado' });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[assistencia] POST /os/:id/orcamento/aprovar:', e);
      return erro(res, 500, 'Erro ao processar aprovação');
    } finally { client.release(); }
  });

  // ── POST /assistencia/os/:id/entregar ─────────────────────────────────────────
  router.post('/os/:id/entregar', writeRateLimiter, requirePermissao(pool, 'assistencia_tecnica', 'editar'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = normalizarInt(req.params.id);
      if (!id) { await client.query('ROLLBACK'); return erro(res, 400, 'ID inválido'); }

      const { empresa, pagamento, valor_pago, observacoes, gerar_conta_receber,
              vencimento, forma_pagamento } = req.body;
      const er = await validarAcessoEmpresa(req, empresa);
      if (!er) { await client.query('ROLLBACK'); return erro(res, 403, 'Sem acesso'); }

      const osRes = await client.query(
        `SELECT id, numero, valor_total, cliente_id FROM ordens_servico
         WHERE id=$1 AND (empresa_id=$2 OR (empresa_id IS NULL AND empresa=$3))`,
        [id, er.id, er.nome]
      );
      if (!osRes.rows[0]) { await client.query('ROLLBACK'); return erro(res, 404, 'OS não encontrada'); }
      const os = osRes.rows[0];

      await client.query(
        `UPDATE ordens_servico SET status='entregue', data_conclusao=NOW(),
           entregue_por=$1, entregue_pagamento=$2, entregue_observacoes=$3, atualizado_em=NOW()
         WHERE id=$4`,
        [req.user?.nome || req.user?.usuario || null, pagamento || null, observacoes || null, id]
      );

      let contaReceberID = null;
      if (gerar_conta_receber && os.cliente_id && criarParcelasContasReceber) {
        const vlr = normalizarDecimal(valor_pago) || normalizarDecimal(os.valor_total) || 0;
        if (vlr > 0) {
          const contas = await criarParcelasContasReceber(client, {
            empresaId: er.id, empresa: er.nome,
            clienteId: os.cliente_id, descricao: `Serviço AT — ${os.numero}`,
            valor: vlr, parcelas: 1,
            dataVencimento: normalizarDataISO(vencimento) || hoje(),
            formaPagamento: forma_pagamento || null,
            origemTipo: 'assistencia', origemId: id,
          });
          if (contas?.length) contaReceberID = contas[0].id;
        }
      }

      if (contaReceberID) {
        await client.query(`UPDATE ordens_servico SET conta_receber_id=$1 WHERE id=$2`, [contaReceberID, id]);
      }

      await registrarEvento(client, {
        osId: id, empresaId: er.id, tipo: 'entrega',
        descricao: `Aparelho entregue — ${pagamento || 'sem info de pagamento'}`,
        usuarioId: req.user?.id, usuarioNome: req.user?.nome || req.user?.usuario,
      });

      await client.query('COMMIT');
      return ok(res, { mensagem: 'Entrega registrada', conta_receber_id: contaReceberID });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[assistencia] POST /os/:id/entregar:', e);
      return erro(res, 500, 'Erro ao registrar entrega');
    } finally { client.release(); }
  });

  // ── POST /assistencia/os/:id/garantia ─────────────────────────────────────────
  router.post('/os/:id/garantia', writeRateLimiter, requirePermissao(pool, 'assistencia_tecnica', 'editar'), async (req, res) => {
    try {
      const id = normalizarInt(req.params.id);
      if (!id) return erro(res, 400, 'ID inválido');
      const er = await validarAcessoEmpresa(req, req.body.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');

      const { dias_garantia = 90, data_inicio, condicoes, observacoes } = req.body;
      const inicio = normalizarDataISO(data_inicio) || hoje();
      const fim    = new Date(inicio);
      fim.setDate(fim.getDate() + Number(dias_garantia));
      const fimISO = fim.toISOString().slice(0, 10);

      await pool.query(
        `INSERT INTO at_garantias (os_id, empresa_id, dias_garantia, data_inicio, data_fim, condicoes, observacoes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [id, er.id, Number(dias_garantia), inicio, fimISO, condicoes || null, observacoes || null]
      );

      return ok(res, { mensagem: 'Garantia registrada', data_inicio: inicio, data_fim: fimISO });
    } catch (e) {
      console.error('[assistencia] POST /os/:id/garantia:', e);
      return erro(res, 500, 'Erro ao registrar garantia');
    }
  });

  // ── POST /assistencia/os/:id/eventos ─────────────────────────────────────────
  router.post('/os/:id/eventos', writeRateLimiter, requirePermissao(pool, 'assistencia_tecnica', 'criar'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = normalizarInt(req.params.id);
      if (!id) { await client.query('ROLLBACK'); return erro(res, 400, 'ID inválido'); }
      const er = await validarAcessoEmpresa(req, req.body.empresa);
      if (!er) { await client.query('ROLLBACK'); return erro(res, 403, 'Sem acesso'); }

      const { descricao } = req.body;
      if (!descricao?.trim()) { await client.query('ROLLBACK'); return erro(res, 400, 'Descrição obrigatória'); }

      await registrarEvento(client, {
        osId: id, empresaId: er.id, tipo: 'observacao',
        descricao: descricao.trim(),
        usuarioId: req.user?.id, usuarioNome: req.user?.nome || req.user?.usuario,
      });

      await client.query('COMMIT');
      return ok(res, { mensagem: 'Evento registrado' });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[assistencia] POST /os/:id/eventos:', e);
      return erro(res, 500, 'Erro ao registrar evento');
    } finally { client.release(); }
  });

  // ── DELETE /assistencia/os/:id ────────────────────────────────────────────────
  router.delete('/os/:id', writeRateLimiter, requirePermissao(pool, 'assistencia_tecnica', 'deletar'), async (req, res) => {
    try {
      const id = normalizarInt(req.params.id);
      if (!id) return erro(res, 400, 'ID inválido');
      const er = await validarAcessoEmpresa(req, req.query.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');

      const r = await pool.query(
        `DELETE FROM ordens_servico WHERE id=$1 AND (empresa_id=$2 OR (empresa_id IS NULL AND empresa=$3)) RETURNING id`,
        [id, er.id, er.nome]
      );
      if (!r.rows[0]) return erro(res, 404, 'OS não encontrada');
      return ok(res, { mensagem: 'OS excluída' });
    } catch (e) {
      console.error('[assistencia] DELETE /os/:id:', e);
      return erro(res, 500, 'Erro ao excluir OS');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // APARELHOS
  // ═══════════════════════════════════════════════════════════════════════════

  router.get('/aparelhos', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const er = await validarAcessoEmpresa(req, req.query.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');
      const { busca, limit = 50, offset = 0 } = req.query;

      let params = [er.id];
      let conds  = [`a.empresa_id = $1`];
      let p = 2;

      if (busca) {
        conds.push(`(a.imei1 ILIKE $${p} OR a.modelo ILIKE $${p} OR a.marca ILIKE $${p} OR c.nome ILIKE $${p})`);
        params.push(`%${busca}%`); p++;
      }

      params.push(Number(limit), Number(offset));
      const rows = await pool.query(
        `SELECT a.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone,
                COUNT(os.id) AS total_os
         FROM at_aparelhos a
         LEFT JOIN clientes c ON c.id = a.cliente_id
         LEFT JOIN ordens_servico os ON os.aparelho_id = a.id
         WHERE ${conds.join(' AND ')}
         GROUP BY a.id, c.nome, c.telefone
         ORDER BY a.criado_em DESC
         LIMIT $${p++} OFFSET $${p++}`,
        params
      );
      return ok(res, { aparelhos: rows.rows });
    } catch (e) {
      console.error('[assistencia] GET /aparelhos:', e);
      return erro(res, 500, 'Erro ao listar aparelhos');
    }
  });

  router.post('/aparelhos', writeRateLimiter, requirePermissao(pool, 'assistencia_tecnica', 'criar'), async (req, res) => {
    try {
      const er = await validarAcessoEmpresa(req, req.body.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');

      const { cliente_id, tipo, marca, modelo, imei1, imei2, serie, cor, capacidade, so, observacoes } = req.body;

      const r = await pool.query(
        `INSERT INTO at_aparelhos (empresa_id, cliente_id, tipo, marca, modelo, imei1, imei2, serie, cor, capacidade, so, observacoes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [er.id, normalizarInt(cliente_id) || null, tipo || 'Smartphone', marca || null, modelo || null,
         imei1 || null, imei2 || null, serie || null, cor || null, capacidade || null, so || null, observacoes || null]
      );
      return ok(res, { aparelho: r.rows[0] }, 201);
    } catch (e) {
      console.error('[assistencia] POST /aparelhos:', e);
      return erro(res, 500, 'Erro ao criar aparelho');
    }
  });

  router.get('/aparelhos/:id', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const id = normalizarInt(req.params.id);
      if (!id) return erro(res, 400, 'ID inválido');
      const er = await validarAcessoEmpresa(req, req.query.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');

      const [apRes, osRes] = await Promise.all([
        pool.query(
          `SELECT a.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone
           FROM at_aparelhos a LEFT JOIN clientes c ON c.id = a.cliente_id
           WHERE a.id=$1 AND a.empresa_id=$2`,
          [id, er.id]
        ),
        pool.query(
          `SELECT os.id, os.numero, os.status, os.defeito_cliente, os.diagnostico,
                  os.valor_total, os.data_entrada, os.data_conclusao,
                  c.nome AS cliente_nome
           FROM ordens_servico os
           LEFT JOIN clientes c ON c.id = os.cliente_id
           WHERE os.aparelho_id=$1 AND (os.empresa_id=$2 OR (os.empresa_id IS NULL AND os.empresa=$3))
           ORDER BY os.criado_em DESC`,
          [id, er.id, er.nome]
        ),
      ]);

      if (!apRes.rows[0]) return erro(res, 404, 'Aparelho não encontrado');
      return ok(res, { aparelho: apRes.rows[0], historico_os: osRes.rows });
    } catch (e) {
      console.error('[assistencia] GET /aparelhos/:id:', e);
      return erro(res, 500, 'Erro ao buscar aparelho');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GARANTIAS
  // ═══════════════════════════════════════════════════════════════════════════

  router.get('/garantias', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const er = await validarAcessoEmpresa(req, req.query.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');
      const { status_garantia } = req.query;

      let cond = status_garantia === 'ativa' ? `AND g.data_fim >= CURRENT_DATE`
               : status_garantia === 'vencida' ? `AND g.data_fim < CURRENT_DATE`
               : '';

      const rows = await pool.query(
        `SELECT g.*, os.numero AS os_numero, os.equipamento_marca, os.equipamento_modelo,
                c.nome AS cliente_nome, c.telefone AS cliente_telefone,
                g.data_fim >= CURRENT_DATE AS ativa
         FROM at_garantias g
         JOIN ordens_servico os ON os.id = g.os_id
         LEFT JOIN clientes c ON c.id = os.cliente_id
         WHERE g.empresa_id=$1 ${cond}
         ORDER BY g.data_fim DESC`,
        [er.id]
      );
      return ok(res, { garantias: rows.rows });
    } catch (e) {
      console.error('[assistencia] GET /garantias:', e);
      return erro(res, 500, 'Erro ao listar garantias');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RELATÓRIOS AT
  // ═══════════════════════════════════════════════════════════════════════════

  router.get('/relatorios/resumo', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const er = await validarAcessoEmpresa(req, req.query.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');

      const { data_inicial, data_final } = req.query;
      const di = data_inicial || new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
      const df = data_final   || new Date().toISOString().slice(0, 10);

      const filtro = `(os.empresa_id=$1 OR (os.empresa_id IS NULL AND os.empresa=$2)) AND os.data_entrada::date BETWEEN $3 AND $4`;

      const [totais, marcas, servicos] = await Promise.all([
        pool.query(
          `SELECT status, COUNT(*) qtd, COALESCE(SUM(valor_total),0) valor
           FROM ordens_servico os WHERE ${filtro} GROUP BY status`,
          [er.id, er.nome, di, df]
        ),
        pool.query(
          `SELECT COALESCE(equipamento_marca,'Sem marca') AS marca,
                  COUNT(*) qtd, COALESCE(SUM(valor_total),0) valor
           FROM ordens_servico os WHERE ${filtro}
           GROUP BY 1 ORDER BY qtd DESC LIMIT 10`,
          [er.id, er.nome, di, df]
        ),
        pool.query(
          `SELECT osi.descricao, COUNT(*) qtd, COALESCE(SUM(osi.valor_total),0) valor
           FROM ordens_servico_itens osi
           JOIN ordens_servico os ON os.id = osi.os_id
           WHERE ${filtro}
           GROUP BY 1 ORDER BY qtd DESC LIMIT 10`,
          [er.id, er.nome, di, df]
        ),
      ]);

      return ok(res, {
        periodo: { data_inicial: di, data_final: df },
        por_status: totais.rows,
        por_marca: marcas.rows,
        top_servicos: servicos.rows,
      });
    } catch (e) {
      console.error('[assistencia] GET /relatorios/resumo:', e);
      return erro(res, 500, 'Erro ao gerar relatório');
    }
  });

  return router;
};
