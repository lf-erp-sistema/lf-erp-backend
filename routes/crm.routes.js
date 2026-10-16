/**
 * CRM — LF ERP
 * Pipeline de oportunidades de venda com atividades e KPIs.
 *
 * Rotas:
 *   GET    /crm/dashboard                              — KPIs do pipeline
 *   GET    /crm/oportunidades                          — listar (filtros: estagio, responsavel)
 *   POST   /crm/oportunidades                          — criar
 *   GET    /crm/oportunidades/:id                      — detalhe + atividades
 *   PUT    /crm/oportunidades/:id                      — editar
 *   PATCH  /crm/oportunidades/:id/estagio              — mover de estágio
 *   DELETE /crm/oportunidades/:id                      — excluir
 *   POST   /crm/oportunidades/:id/converter            — converte em orçamento
 *   POST   /crm/oportunidades/:id/atividades           — adicionar atividade
 *   DELETE /crm/oportunidades/:id/atividades/:atId     — remover atividade
 */

const ESTAGIOS = ['lead', 'qualificado', 'proposta', 'negociacao', 'ganho', 'perdido'];

const { requirePermissao } = require('../utils/permissoes');
const { erro, ok } = require('../utils/routeHelpers');

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, normalizarDataISO, hoje }) {
  const router = require('express').Router();



  function normOp(row) {
    return {
      ...row,
      valor_estimado:  Number(row.valor_estimado  || 0),
      probabilidade:   Number(row.probabilidade   || 0),
      total_atividades: Number(row.total_atividades || 0)
    };
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  router.get('/dashboard', auth, requirePermissao(pool, 'vendas', 'ver'), async (req, res) => {
    try {
      const emp = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const [estagiosResult, mesResult] = await Promise.all([
        pool.query(
          `SELECT estagio,
                  COUNT(*) AS total,
                  COALESCE(SUM(valor_estimado), 0) AS valor_total
           FROM crm_oportunidades
           WHERE empresa_id = $1
           GROUP BY estagio`,
          [emp.id]
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE estagio = 'ganho' AND DATE_TRUNC('month', atualizado_em AT TIME ZONE 'America/Fortaleza') = DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Fortaleza')) AS ganhas_mes,
             COALESCE(SUM(valor_estimado) FILTER (WHERE estagio = 'ganho' AND DATE_TRUNC('month', atualizado_em AT TIME ZONE 'America/Fortaleza') = DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Fortaleza')), 0) AS valor_ganho_mes,
             COUNT(*) FILTER (WHERE estagio NOT IN ('ganho','perdido')) AS em_aberto,
             COALESCE(SUM(valor_estimado) FILTER (WHERE estagio NOT IN ('ganho','perdido')), 0) AS valor_pipeline
           FROM crm_oportunidades
           WHERE empresa_id = $1`,
          [emp.id]
        )
      ]);

      const por_estagio = {};
      for (const e of ESTAGIOS) por_estagio[e] = { total: 0, valor_total: 0 };
      for (const row of estagiosResult.rows) {
        por_estagio[row.estagio] = { total: Number(row.total), valor_total: Number(row.valor_total) };
      }

      const stats = mesResult.rows[0];

      return ok(res, {
        por_estagio,
        ganhas_mes:      Number(stats.ganhas_mes      || 0),
        valor_ganho_mes: Number(stats.valor_ganho_mes || 0),
        em_aberto:       Number(stats.em_aberto       || 0),
        valor_pipeline:  Number(stats.valor_pipeline  || 0)
      });
    } catch (err) {
      console.error('[crm] GET dashboard:', err.message);
      return erro(res, 500, 'Erro ao carregar dashboard CRM');
    }
  });

  // ── Listar oportunidades ──────────────────────────────────────────────────

  router.get('/oportunidades', auth, requirePermissao(pool, 'vendas', 'ver'), async (req, res) => {
    try {
      const emp = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { estagio, responsavel_id, busca } = req.query;

      const params = [emp.id];
      let where = 'WHERE o.empresa_id = $1';

      if (estagio && ESTAGIOS.includes(estagio)) {
        params.push(estagio);
        where += ` AND o.estagio = $${params.length}`;
      }
      if (responsavel_id) {
        params.push(Number(responsavel_id));
        where += ` AND o.responsavel_id = $${params.length}`;
      }
      if (busca) {
        params.push(`%${busca}%`);
        where += ` AND (o.titulo ILIKE $${params.length} OR o.cliente_nome ILIKE $${params.length})`;
      }

      const result = await pool.query(
        `SELECT o.*,
                COUNT(a.id) AS total_atividades,
                MAX(a.criado_em) AS ultima_atividade
         FROM crm_oportunidades o
         LEFT JOIN crm_atividades a ON a.oportunidade_id = o.id
         ${where}
         GROUP BY o.id
         ORDER BY o.atualizado_em DESC
         LIMIT 500`,
        params
      );

      return ok(res, { oportunidades: result.rows.map(normOp) });
    } catch (err) {
      console.error('[crm] GET oportunidades:', err.message);
      return erro(res, 500, 'Erro ao listar oportunidades');
    }
  });

  // ── Criar oportunidade ────────────────────────────────────────────────────

  router.post('/oportunidades', auth, requirePermissao(pool, 'vendas', 'criar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { titulo, cliente_id, cliente_nome, valor_estimado, estagio, probabilidade, responsavel_id, responsavel_nome, data_prev_fechamento, origem, observacoes } = req.body;

      if (!titulo?.trim()) return erro(res, 400, 'Título é obrigatório');

      // cliente_id não era validado contra a empresa antes do INSERT (achado
      // F2-SEC-007) — mesmo padrão já usado em orcamentos/pedidos.
      if (cliente_id) {
        const clienteCheck = await pool.query(
          `SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2`,
          [Number(cliente_id), emp.id]
        );
        if (clienteCheck.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');
      }

      const estagioFinal = ESTAGIOS.includes(estagio) ? estagio : 'lead';

      const result = await pool.query(
        `INSERT INTO crm_oportunidades
           (empresa_id, titulo, cliente_id, cliente_nome, valor_estimado, estagio, probabilidade,
            responsavel_id, responsavel_nome, data_prev_fechamento, origem, observacoes, criado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          emp.id,
          titulo.trim(),
          cliente_id   ? Number(cliente_id)   : null,
          cliente_nome?.trim() || null,
          normalizarDecimal(valor_estimado),
          estagioFinal,
          Math.min(100, Math.max(0, normalizarInt(probabilidade) ?? 50)),
          responsavel_id ? Number(responsavel_id) : null,
          responsavel_nome?.trim() || null,
          normalizarDataISO(data_prev_fechamento) || null,
          origem?.trim() || null,
          observacoes?.trim() || null,
          req.user.id
        ]
      );

      return res.status(201).json({ sucesso: true, oportunidade: normOp(result.rows[0]) });
    } catch (err) {
      console.error('[crm] POST oportunidade:', err.message);
      return erro(res, 500, 'Erro ao criar oportunidade');
    }
  });

  // ── Detalhe ───────────────────────────────────────────────────────────────

  router.get('/oportunidades/:id', auth, requirePermissao(pool, 'vendas', 'ver'), async (req, res) => {
    try {
      const id  = Number(req.params.id);
      const emp = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const [opResult, atResult] = await Promise.all([
        pool.query(
          `SELECT o.*, c.telefone AS cliente_telefone, c.email AS cliente_email
           FROM crm_oportunidades o
           LEFT JOIN clientes c ON c.id = o.cliente_id AND (c.empresa_id = $2 OR (c.empresa_id IS NULL AND c.empresa = $3))
           WHERE o.id = $1 AND o.empresa_id = $2`,
          [id, emp.id, emp.nome]
        ),
        pool.query(
          `SELECT * FROM crm_atividades WHERE oportunidade_id = $1 AND empresa_id = $2 ORDER BY data DESC, criado_em DESC`,
          [id, emp.id]
        )
      ]);

      if (opResult.rowCount === 0) return erro(res, 404, 'Oportunidade não encontrada');

      return ok(res, {
        oportunidade: normOp(opResult.rows[0]),
        atividades: atResult.rows
      });
    } catch (err) {
      console.error('[crm] GET oportunidade/:id:', err.message);
      return erro(res, 500, 'Erro ao buscar oportunidade');
    }
  });

  // ── Editar oportunidade ───────────────────────────────────────────────────

  router.put('/oportunidades/:id', auth, requirePermissao(pool, 'vendas', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const id  = Number(req.params.id);
      const emp = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { titulo, cliente_id, cliente_nome, valor_estimado, estagio, probabilidade, responsavel_id, responsavel_nome, data_prev_fechamento, origem, observacoes } = req.body;

      // cliente_id não era validado contra a empresa antes do UPDATE (achado
      // F2-SEC-007) — mesmo padrão já usado em orcamentos/pedidos.
      if (cliente_id) {
        const clienteCheck = await pool.query(
          `SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2`,
          [Number(cliente_id), emp.id]
        );
        if (clienteCheck.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');
      }

      const result = await pool.query(
        `UPDATE crm_oportunidades SET
           titulo               = COALESCE(NULLIF($1,''), titulo),
           cliente_id           = COALESCE($2, cliente_id),
           cliente_nome         = COALESCE(NULLIF($3,''), cliente_nome),
           valor_estimado       = COALESCE($4, valor_estimado),
           estagio              = COALESCE($5, estagio),
           probabilidade        = COALESCE($6, probabilidade),
           responsavel_id       = COALESCE($7, responsavel_id),
           responsavel_nome     = COALESCE(NULLIF($8,''), responsavel_nome),
           data_prev_fechamento = COALESCE($9, data_prev_fechamento),
           origem               = COALESCE(NULLIF($10,''), origem),
           observacoes          = COALESCE(NULLIF($11,''), observacoes),
           atualizado_em        = NOW() AT TIME ZONE 'America/Fortaleza'
         WHERE id = $12 AND empresa_id = $13
         RETURNING *`,
        [
          titulo?.trim() || null,
          cliente_id   ? Number(cliente_id)   : null,
          cliente_nome?.trim() || null,
          valor_estimado  != null ? normalizarDecimal(valor_estimado)  : null,
          estagio && ESTAGIOS.includes(estagio) ? estagio : null,
          probabilidade   != null ? Math.min(100, Math.max(0, normalizarInt(probabilidade) ?? 0)) : null,
          responsavel_id  ? Number(responsavel_id)  : null,
          responsavel_nome?.trim() || null,
          normalizarDataISO(data_prev_fechamento) || null,
          origem?.trim() || null,
          observacoes?.trim() || null,
          id, emp.id
        ]
      );

      if (result.rowCount === 0) return erro(res, 404, 'Oportunidade não encontrada');
      return ok(res, { oportunidade: normOp(result.rows[0]) });
    } catch (err) {
      console.error('[crm] PUT oportunidade:', err.message);
      return erro(res, 500, 'Erro ao editar oportunidade');
    }
  });

  // ── Mover de estágio (PATCH) ──────────────────────────────────────────────

  router.patch('/oportunidades/:id/estagio', auth, requirePermissao(pool, 'vendas', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const id  = Number(req.params.id);
      const emp = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { estagio } = req.body;
      if (!ESTAGIOS.includes(estagio)) return erro(res, 400, `Estágio inválido. Use: ${ESTAGIOS.join(', ')}`);

      const result = await pool.query(
        `UPDATE crm_oportunidades SET estagio = $1, atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
         WHERE id = $2 AND empresa_id = $3 RETURNING *`,
        [estagio, id, emp.id]
      );

      if (result.rowCount === 0) return erro(res, 404, 'Oportunidade não encontrada');
      return ok(res, { oportunidade: normOp(result.rows[0]) });
    } catch (err) {
      console.error('[crm] PATCH estagio:', err.message);
      return erro(res, 500, 'Erro ao mover oportunidade');
    }
  });

  // ── Excluir ───────────────────────────────────────────────────────────────

  router.delete('/oportunidades/:id', auth, requirePermissao(pool, 'vendas', 'deletar'), writeRateLimiter, async (req, res) => {
    try {
      const id  = Number(req.params.id);
      const emp = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const r = await pool.query(
        `DELETE FROM crm_oportunidades WHERE id = $1 AND empresa_id = $2`,
        [id, emp.id]
      );

      if (r.rowCount === 0) return erro(res, 404, 'Oportunidade não encontrada');
      return ok(res, { mensagem: 'Oportunidade excluída' });
    } catch (err) {
      console.error('[crm] DELETE oportunidade:', err.message);
      return erro(res, 500, 'Erro ao excluir oportunidade');
    }
  });

  // ── Converter em orçamento ────────────────────────────────────────────────

  router.post('/oportunidades/:id/converter', auth, requirePermissao(pool, 'vendas', 'criar'), writeRateLimiter, async (req, res) => {
    let client;
    try {
      const id  = Number(req.params.id);
      const emp = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!emp) return erro(res, 403, 'Sem acesso');

      client = await pool.connect();
      await client.query('BEGIN');

      const opResult = await client.query(
        `SELECT * FROM crm_oportunidades WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
        [id, emp.id]
      );
      if (opResult.rowCount === 0) { await client.query('ROLLBACK'); return erro(res, 404, 'Oportunidade não encontrada'); }

      const op = opResult.rows[0];

      // Cria rascunho de orçamento
      const orcResult = await client.query(
        `INSERT INTO orcamentos
           (empresa_id, cliente_id, cliente_nome, total, status, observacao, validade_dias, criado_por, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,'rascunho',$5,30,$6,NOW() AT TIME ZONE 'America/Fortaleza',NOW() AT TIME ZONE 'America/Fortaleza')
         RETURNING id`,
        [
          emp.id,
          op.cliente_id || null,
          op.cliente_nome || 'Sem cliente',
          op.valor_estimado,
          `Gerado a partir da oportunidade: ${op.titulo}`,
          req.user.id
        ]
      );

      const orcamentoId = orcResult.rows[0].id;

      // Marca oportunidade como "em proposta" se ainda não avançou
      if (!['proposta', 'negociacao', 'ganho'].includes(op.estagio)) {
        await client.query(
          `UPDATE crm_oportunidades SET estagio = 'proposta', atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza' WHERE id = $1 AND empresa_id = $2`,
          [id, emp.id]
        );
      }

      await client.query('COMMIT');
      return ok(res, { orcamento_id: orcamentoId, mensagem: 'Orçamento criado com sucesso' });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[crm] POST converter:', err.message);
      return erro(res, 500, 'Erro ao converter oportunidade');
    } finally {
      if (client) client.release();
    }
  });

  // ── Atividades ────────────────────────────────────────────────────────────

  router.post('/oportunidades/:id/atividades', auth, requirePermissao(pool, 'vendas', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const oportunidadeId = Number(req.params.id);
      const emp = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!emp) return erro(res, 403, 'Sem acesso');

      // Confirma que a oportunidade pertence à empresa
      const check = await pool.query(
        `SELECT id FROM crm_oportunidades WHERE id = $1 AND empresa_id = $2`,
        [oportunidadeId, emp.id]
      );
      if (check.rowCount === 0) return erro(res, 404, 'Oportunidade não encontrada');

      const { tipo, descricao, data } = req.body;
      const tiposValidos = ['ligacao', 'email', 'reuniao', 'nota'];
      if (!descricao?.trim()) return erro(res, 400, 'Descrição é obrigatória');

      const result = await pool.query(
        `INSERT INTO crm_atividades (empresa_id, oportunidade_id, tipo, descricao, data, criado_por)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          emp.id, oportunidadeId,
          tiposValidos.includes(tipo) ? tipo : 'nota',
          descricao.trim(),
          normalizarDataISO(data) || hoje(),
          req.user.id
        ]
      );

      return res.status(201).json({ sucesso: true, atividade: result.rows[0] });
    } catch (err) {
      console.error('[crm] POST atividade:', err.message);
      return erro(res, 500, 'Erro ao adicionar atividade');
    }
  });

  router.delete('/oportunidades/:id/atividades/:atId', auth, requirePermissao(pool, 'vendas', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const r = await pool.query(
        `DELETE FROM crm_atividades WHERE id = $1 AND empresa_id = $2 AND oportunidade_id = $3`,
        [Number(req.params.atId), emp.id, Number(req.params.id)]
      );

      if (r.rowCount === 0) return erro(res, 404, 'Atividade não encontrada');
      return ok(res, { mensagem: 'Atividade removida' });
    } catch (err) {
      console.error('[crm] DELETE atividade:', err.message);
      return erro(res, 500, 'Erro ao remover atividade');
    }
  });

  return router;
};
