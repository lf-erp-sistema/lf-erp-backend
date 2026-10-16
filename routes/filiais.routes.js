/**
 * Multi-filial — LF ERP
 * Pontos de venda independentes com relatórios consolidados.
 *
 * GET    /filiais                          — listar filiais
 * POST   /filiais                          — criar filial
 * PUT    /filiais/:id                      — editar filial
 * PATCH  /filiais/:id/ativo                — ativar/desativar
 * DELETE /filiais/:id                      — excluir (sem movimentos)
 *
 * GET    /filiais/comparativo              — dashboard comparativo entre filiais
 * GET    /filiais/:id/dashboard            — KPIs de uma filial específica
 * GET    /filiais/:id/vendas               — vendas da filial
 * GET    /filiais/:id/compras              — compras da filial
 */

const { erro, ok } = require('../utils/routeHelpers');
const { requirePermissao } = require('../utils/permissoes');

const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, hoje }) {
  const router = require('express').Router();


  async function emp(req)               { return validarAcessoEmpresa(req, null, req.empresa_id); }

  // ── Dashboard comparativo ─────────────────────────────────────────────────

  router.get('/comparativo', auth, requirePermissao(pool, 'filiais', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { dataInicial, dataFinal } = obterPeriodo(req);

      // Filiais ativas + a sede (NULL filial_id)
      const filiaisResult = await pool.query(
        `SELECT id, nome, principal FROM filiais WHERE empresa_id = $1 AND ativo = true ORDER BY principal DESC, nome`,
        [e.id]
      );
      const filiais = filiaisResult.rows;

      // KPIs por filial
      const filiaisIds = filiais.map((f) => f.id);

      const params = [e.id, e.nome];
      let dataCond = '';
      if (dataInicial) { params.push(dataInicial); dataCond += ` AND data >= $${params.length}`; }
      if (dataFinal)   { params.push(dataFinal);   dataCond += ` AND data <= $${params.length}`; }

      // Vendas por filial (inclui NULL = sede)
      const vendasResult = await pool.query(
        `SELECT filial_id, COUNT(*) AS qtd_vendas, COALESCE(SUM(total),0) AS total_vendas
         FROM vendas
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
           ${dataCond}
         GROUP BY filial_id`,
        params
      );

      const comprasResult = await pool.query(
        `SELECT filial_id, COUNT(*) AS qtd_compras, COALESCE(SUM(total),0) AS total_compras
         FROM compras
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
           ${dataCond}
         GROUP BY filial_id`,
        params
      );

      const vendasMap  = {};
      const comprasMap = {};
      for (const r of vendasResult.rows)  vendasMap[r.filial_id  ?? 'sede'] = r;
      for (const r of comprasResult.rows) comprasMap[r.filial_id ?? 'sede'] = r;

      // Monta resultado: uma linha por filial + sede
      const sedeKey = 'sede';
      const todasFiliais = [
        { id: null, nome: 'Sede Principal', principal: true },
        ...filiais
      ];

      const comparativo = todasFiliais.map((f) => {
        const key   = f.id ?? sedeKey;
        const venda = vendasMap[key]  || { qtd_vendas: 0,  total_vendas: 0 };
        const compra = comprasMap[key] || { qtd_compras: 0, total_compras: 0 };
        return {
          filial_id:     f.id,
          nome:          f.nome,
          principal:     Boolean(f.principal),
          qtd_vendas:    Number(venda.qtd_vendas),
          total_vendas:  Number(venda.total_vendas),
          qtd_compras:   Number(compra.qtd_compras),
          total_compras: Number(compra.total_compras)
        };
      });

      // Totais consolidados
      const totais = comparativo.reduce((acc, f) => ({
        qtd_vendas:    acc.qtd_vendas    + f.qtd_vendas,
        total_vendas:  acc.total_vendas  + f.total_vendas,
        qtd_compras:   acc.qtd_compras   + f.qtd_compras,
        total_compras: acc.total_compras + f.total_compras
      }), { qtd_vendas: 0, total_vendas: 0, qtd_compras: 0, total_compras: 0 });

      return ok(res, { comparativo, totais, periodo: { dataInicial, dataFinal } });
    } catch (err) {
      console.error('[filiais] comparativo:', err.message);
      return erro(res, 500, 'Erro ao gerar comparativo');
    }
  });

  // ── Dashboard por filial ──────────────────────────────────────────────────

  router.get('/:id/dashboard', auth, requirePermissao(pool, 'filiais', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const filialId = req.params.id === 'sede' ? null : Number(req.params.id);
      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [e.id, e.nome];
      let cond = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;
      cond += filialId ? ` AND filial_id = $3` : ` AND filial_id IS NULL`;
      if (filialId) params.push(filialId);

      const pv = [...params];
      let dv = '';
      if (dataInicial) { pv.push(dataInicial); dv += ` AND data >= $${pv.length}`; }
      if (dataFinal)   { pv.push(dataFinal);   dv += ` AND data <= $${pv.length}`; }

      const [vendasRes, comprasRes, caixaRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS qtd, COALESCE(SUM(total),0) AS total FROM vendas ${cond}${dv}`, pv),
        pool.query(`SELECT COUNT(*) AS qtd, COALESCE(SUM(total),0) AS total FROM compras ${cond}${dv}`, pv),
        pool.query(
          `SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor ELSE 0 END),0) AS entradas,
                  COALESCE(SUM(CASE WHEN tipo='saida'   THEN valor ELSE 0 END),0) AS saidas
           FROM caixa_movimentos
           WHERE (empresa_id = $1) ${filialId ? `AND filial_id = $3` : `AND filial_id IS NULL`}
             ${dv.replace(/data/g,'data_movimento')}`,
          pv
        )
      ]);

      return ok(res, {
        vendas:  { qtd: Number(vendasRes.rows[0].qtd),  total: Number(vendasRes.rows[0].total) },
        compras: { qtd: Number(comprasRes.rows[0].qtd), total: Number(comprasRes.rows[0].total) },
        caixa:   { entradas: Number(caixaRes.rows[0].entradas), saidas: Number(caixaRes.rows[0].saidas) }
      });
    } catch (err) {
      console.error('[filiais] dashboard:', err.message);
      return erro(res, 500, 'Erro ao carregar dashboard');
    }
  });

  // ── CRUD filiais ──────────────────────────────────────────────────────────

  router.get('/', auth, requirePermissao(pool, 'filiais', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT f.*,
                (SELECT COUNT(*) FROM vendas  WHERE filial_id = f.id AND empresa_id = f.empresa_id) AS total_vendas,
                (SELECT COUNT(*) FROM compras WHERE filial_id = f.id AND empresa_id = f.empresa_id) AS total_compras
         FROM filiais f WHERE f.empresa_id = $1 ORDER BY f.principal DESC, f.nome`,
        [e.id]
      );
      return ok(res, { filiais: result.rows });
    } catch (err) { return erro(res, 500, 'Erro ao listar filiais'); }
  });

  router.post('/', auth, requirePermissao(pool, 'filiais', 'criar'), writeRateLimiter, async (req, res) => {
    const e = await emp(req);
    if (!e) return erro(res, 403, 'Sem acesso');

    const { nome, cnpj, telefone, endereco, cidade, uf, responsavel, principal } = req.body;
    if (!nome?.trim()) return erro(res, 400, 'Nome é obrigatório');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (principal) {
        await client.query(`UPDATE filiais SET principal = false WHERE empresa_id = $1`, [e.id]);
      }
      const result = await client.query(
        `INSERT INTO filiais (empresa_id, nome, cnpj, telefone, endereco, cidade, uf, responsavel, principal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [e.id, nome.trim(), cnpj?.trim()||null, telefone?.trim()||null, endereco?.trim()||null, cidade?.trim()||null, uf?.trim()||null, responsavel?.trim()||null, Boolean(principal)]
      );
      await client.query('COMMIT');
      return res.status(201).json({ sucesso: true, filial: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return erro(res, 409, 'Já existe uma filial com este nome');
      return erro(res, 500, 'Erro interno');
    } finally {
      client.release();
    }
  });

  router.put('/:id', auth, requirePermissao(pool, 'filiais', 'editar'), writeRateLimiter, async (req, res) => {
    const e = await emp(req);
    if (!e) return erro(res, 403, 'Sem acesso');

    const { nome, cnpj, telefone, endereco, cidade, uf, responsavel, principal } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (principal) {
        await client.query(`UPDATE filiais SET principal = false WHERE empresa_id = $1 AND id != $2`, [e.id, Number(req.params.id)]);
      }
      const r = await client.query(
        `UPDATE filiais SET
           nome        = COALESCE(NULLIF($1,''), nome),
           cnpj        = COALESCE($2, cnpj),
           telefone    = COALESCE($3, telefone),
           endereco    = COALESCE($4, endereco),
           cidade      = COALESCE($5, cidade),
           uf          = COALESCE($6, uf),
           responsavel = COALESCE($7, responsavel),
           principal   = COALESCE($8, principal),
           atualizado_em = NOW()
         WHERE id = $9 AND empresa_id = $10 RETURNING *`,
        [nome?.trim()||null, cnpj?.trim()||null, telefone?.trim()||null, endereco?.trim()||null,
         cidade?.trim()||null, uf?.trim()||null, responsavel?.trim()||null,
         principal != null ? Boolean(principal) : null,
         Number(req.params.id), e.id]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Filial não encontrada');
      }
      await client.query('COMMIT');
      return ok(res, { filial: r.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      return erro(res, 500, 'Erro interno');
    } finally {
      client.release();
    }
  });

  router.patch('/:id/ativo', auth, requirePermissao(pool, 'filiais', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const r = await pool.query(
        `UPDATE filiais SET ativo = $1, atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3 RETURNING nome, ativo`,
        [Boolean(req.body.ativo), Number(req.params.id), e.id]
      );
      if (r.rowCount === 0) return erro(res, 404, 'Filial não encontrada');
      return ok(res, { filial: r.rows[0] });
    } catch (err) { return erro(res, 500, 'Erro interno'); }
  });

  router.delete('/:id', auth, requirePermissao(pool, 'filiais', 'deletar'), writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const id = Number(req.params.id);

      // Verifica se há movimentos vinculados
      const [v, c] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM vendas  WHERE filial_id = $1 AND empresa_id = $2`, [id, e.id]),
        pool.query(`SELECT COUNT(*) FROM compras WHERE filial_id = $1 AND empresa_id = $2`, [id, e.id])
      ]);

      const totalMovs = Number(v.rows[0].count) + Number(c.rows[0].count);
      if (totalMovs > 0) return erro(res, 400, `Não é possível excluir: ${totalMovs} transação(ões) vinculada(s). Desative a filial em vez disso.`);

      const r = await pool.query(`DELETE FROM filiais WHERE id = $1 AND empresa_id = $2`, [id, e.id]);
      if (r.rowCount === 0) return erro(res, 404, 'Filial não encontrada');
      return ok(res, { mensagem: 'Filial excluída' });
    } catch (err) { return erro(res, 500, 'Erro interno'); }
  });

  // ── Vendas da filial ──────────────────────────────────────────────────────

  router.get('/:id/vendas', auth, requirePermissao(pool, 'filiais', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const filialId = req.params.id === 'sede' ? null : Number(req.params.id);
      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [e.id, e.nome];
      const cond = filialId ? `AND filial_id = $${params.push(filialId) && params.length}` : `AND filial_id IS NULL`;
      let dataCond = '';
      if (dataInicial) { params.push(dataInicial); dataCond += ` AND data >= $${params.length}`; }
      if (dataFinal)   { params.push(dataFinal);   dataCond += ` AND data <= $${params.length}`; }

      const result = await pool.query(
        `SELECT id, data, cliente_nome, total, pagamento, status_pagamento
         FROM vendas
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
         ${cond} ${dataCond}
         ORDER BY data DESC, id DESC LIMIT 500`,
        params
      );
      return ok(res, { vendas: result.rows });
    } catch (err) { return erro(res, 500, 'Erro ao buscar vendas da filial'); }
  });

  return router;
};
