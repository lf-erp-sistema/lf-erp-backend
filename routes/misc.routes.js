'use strict';
const express = require('express');
const { requirePermissao }   = require('../utils/permissoes');
const { normalizarDecimal, normalizarInt, normalizarDataISO, hoje, addDias } = require('../utils/normalizadores');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function miscRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  podeGerenciarFinanceiro, podeGerenciarCompras,
  atualizarStatusContasPagarPorEmpresa,
}) {
  const router = express.Router();
// ================= COMPRAS =================

router.get('/compras/:empresa', auth, requirePermissao(pool, 'compras', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const busca = (req.query.busca || '').trim().toLowerCase();
    const fornecedorId = normalizarInt(req.query.fornecedor_id || 0);
    const { dataInicial, dataFinal } = obterPeriodo(req);

    const params = [];
    let sql = `
        SELECT
          c.*,
          f.nome AS fornecedor_nome
        FROM compras c
        LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
        WHERE 1=1
      `;
    sql += adicionarFiltroEmpresaSaaS({ alias: 'c', params, empresaResolvida });
    let idx = params.length + 1;

    if (fornecedorId > 0) {
      sql += ` AND c.fornecedor_id = $${idx} `;
      params.push(fornecedorId);
      idx++;
    }

    if (busca) {
      const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
      sql += `
          AND (
            LOWER(COALESCE(f.nome, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(c.observacao, '')) LIKE $${idx} ESCAPE '\\'
            OR CAST(c.id AS TEXT) LIKE $${idx} ESCAPE '\\'
          )
        `;
      params.push(`%${buscaEsc}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodo({
      campo: 'c.data',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const paginaC = Math.max(1, normalizarInt(req.query.page || 1));
    const limiteC = Math.min(normalizarInt(req.query.limit) || 100, 500);
    const offsetC = (paginaC - 1) * limiteC;
    sql += ` ORDER BY c.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limiteC, offsetC);

    const result = await pool.query(sql, params);
    res.json(
      result.rows.map((row) => ({
        ...row,
        total: Number(row.total || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar compras:', error);
    jsonErro(res, 500, 'Erro ao buscar compras');
  }
});

router.delete('/compras/:id', auth, writeRateLimiter, requirePermissao(pool, 'compras', 'deletar'), async (req, res) => {
  if (!podeGerenciarCompras(req)) {
    return jsonErro(res, 403, 'Sem permissÃ£o para excluir compras');
  }

  const id = Number(req.params.id);
  if (!id) return jsonErro(res, 400, 'Compra invÃ¡lida');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const empresa = req.query.empresa || req.body.empresa || null;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      await client.query('ROLLBACK');
      return jsonErro(res, 403, 'Sem acesso');
    }

    const compraResult = await client.query(
      `SELECT * FROM compras
       WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
       FOR UPDATE`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    if (compraResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return jsonErro(res, 404, 'Compra nÃ£o encontrada');
    }

    const itensResult = await client.query(
      `
      SELECT *
      FROM compra_itens
      WHERE compra_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      ORDER BY id ASC
      FOR UPDATE
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    for (const item of itensResult.rows) {
      await client.query(
        `UPDATE produtos SET estoque = GREATEST(0, estoque - $1), atualizado_em = NOW()
         WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))`,
        [normalizarInt(item.quantidade), item.produto_id, empresaResolvida.id, empresaResolvida.nome]
      );
    }

    await client.query(
      `
      DELETE FROM movimentacoes_estoque
      WHERE referencia_tipo = 'compra'
        AND referencia_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM contas_pagar
      WHERE compra_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM compra_itens
      WHERE compra_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM compras
      WHERE id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query('COMMIT');
    try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[del-compra] status-cp:', e.message); }

    res.json({ sucesso: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro real ao excluir compra:', error);
    jsonErro(res, 500, 'Erro ao excluir compra');
  } finally {
    client.release();
  }
});

router.get('/compras-detalhe/:id', auth, requirePermissao(pool, 'compras', 'ver'), async (req, res) => {
  try {
    const id = Number(req.params.id);

    const empresaResolvida = await validarAcessoEmpresa(req, req.user.empresa || null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const compraResult = await pool.query(
      `
      SELECT
        c.*,
        f.nome AS fornecedor_nome
      FROM compras c
      LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
      WHERE c.id = $1
        AND (c.empresa_id = $2 OR (c.empresa_id IS NULL AND c.empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    if (compraResult.rowCount === 0) {
      return jsonErro(res, 404, 'Compra nÃ£o encontrada');
    }

    const compra = compraResult.rows[0];

    const itensResult = await pool.query(
      `SELECT * FROM compra_itens WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) ORDER BY id ASC`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    const contasPagarResult = await pool.query(
      `SELECT * FROM contas_pagar WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) ORDER BY parcela ASC, id ASC`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    res.json({
      ...compra,
      total: Number(compra.total || 0),
      parcelas: Number(contasPagarResult.rows[0]?.total_parcelas || 1),
      itens: itensResult.rows.map((item) => ({
        ...item,
        quantidade: Number(item.quantidade || 0),
        custo_unitario: Number(item.custo_unitario || 0),
        subtotal: Number(item.subtotal || 0)
      })),
      contas_pagar: contasPagarResult.rows.map((cp) => ({
        ...cp,
        parcela: Number(cp.parcela || 1),
        total_parcelas: Number(cp.total_parcelas || 1),
        valor: Number(cp.valor || 0)
      }))
    });
  } catch (error) {
    console.error('Erro real ao buscar compra:', error);
    jsonErro(res, 500, 'Erro ao buscar compra');
  }
});

// ================= LISTAGENS OPERACIONAIS AUXILIARES =================
router.get('/estoque/resumo/:empresa', auth, requirePermissao(pool, 'estoque', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const params = [];
    const filtro = adicionarFiltroEmpresaSaaS({ params, empresaResolvida });

    const result = await pool.query(
      `
        SELECT
          COUNT(*) AS total_produtos,
          COALESCE(SUM(estoque), 0) AS total_unidades,
          COALESCE(SUM(estoque * custo), 0) AS valor_total_estoque,
          COALESCE(SUM(CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN 1 ELSE 0 END), 0) AS produtos_alerta
        FROM produtos
        WHERE deletado_em IS NULL
        ${filtro}
        `,
      params
    );

    res.json({
      total_produtos: Number(result.rows[0].total_produtos || 0),
      total_unidades: Number(result.rows[0].total_unidades || 0),
      valor_total_estoque: Number(result.rows[0].valor_total_estoque || 0),
      produtos_alerta: Number(result.rows[0].produtos_alerta || 0)
    });
  } catch (error) {
    console.error('Erro ao buscar resumo de estoque:', error);
    jsonErro(res, 500, 'Erro ao buscar resumo de estoque');
  }
});

router.get('/compras-fornecedores/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          f.id,
          f.nome,
          COUNT(c.id) AS total_compras,
          COALESCE(SUM(c.total), 0) AS valor_total
        FROM fornecedores f
        LEFT JOIN compras c ON c.fornecedor_id = f.id AND (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))
        WHERE (f.empresa_id = $1 OR (f.empresa_id IS NULL AND f.empresa = $2))
        GROUP BY f.id, f.nome
        ORDER BY valor_total DESC, f.nome ASC
        `,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json(
      result.rows.map((row) => ({
        ...row,
        total_compras: Number(row.total_compras || 0),
        valor_total: Number(row.valor_total || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar resumo de compras por fornecedor:', error);
    jsonErro(res, 500, 'Erro ao buscar resumo de compras por fornecedor');
  }
});

router.get('/vendas-clientes/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          COALESCE(cliente_nome, 'Sem cliente') AS cliente,
          COUNT(*) AS total_vendas,
          COALESCE(SUM(total), 0) AS valor_total
        FROM vendas
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
        GROUP BY COALESCE(cliente_nome, 'Sem cliente')
        ORDER BY valor_total DESC, cliente ASC
        `,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json(
      result.rows.map((row) => ({
        ...row,
        total_vendas: Number(row.total_vendas || 0),
        valor_total: Number(row.valor_total || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar resumo de vendas por cliente:', error);
    jsonErro(res, 500, 'Erro ao buscar resumo de vendas por cliente');
  }
});





  return router;
};