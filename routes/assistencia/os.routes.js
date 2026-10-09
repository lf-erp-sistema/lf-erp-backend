'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { addDias } = require('../../utils/normalizadores');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 2/5 de assistencia.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// ordens de serviço (CRUD completo + ações de status/orçamento/entrega/garantia/eventos).
module.exports = function assistenciaOsRoutes({
  writeRateLimiter, pool,
  validarAcessoEmpresa, normalizarDecimal, normalizarInt, normalizarDataISO, hoje,
  criarParcelasContasReceber
}) {
  const router = express.Router();

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
        // valor_pago é input do usuário (normalizarDecimal); os.valor_total vem do banco (Number).
        const vlr = normalizarDecimal(valor_pago) || Number(os.valor_total || 0) || 0;
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
      const fimISO = addDias(inicio, Number(dias_garantia));

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

  return router;
};
