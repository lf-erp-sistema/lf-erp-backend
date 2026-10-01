'use strict';
const express = require('express');
const { normalizarDecimal, normalizarDataISO, hoje } = require('../utils/normalizadores');
const { obterPeriodo, adicionarFiltroPeriodo, adicionarFiltroPeriodoRange } = require('../utils/periodoUtils');
const { requirePermissao } = require('../utils/permissoes');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function fluxoCaixaRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  podeGerenciarFinanceiro,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa,
}) {
  const router = express.Router();
router.post('/investimentos', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const { empresa, tipo_investimento, descricao, valor, data, forma_pagamento, observacao } =
      req.body;

    if (!empresa || !tipo_investimento || !descricao || !data) {
      return jsonErro(res, 400, 'Dados do investimento incompletos');
    }

    const TIPOS_INVESTIMENTO_VALIDOS = [
      'CDB', 'LCI', 'LCA', 'Tesouro Direto', 'Ações', 'FII', 'Poupança', 'Outro'
    ];
    if (!TIPOS_INVESTIMENTO_VALIDOS.includes(tipo_investimento)) {
      return jsonErro(res, 400, 'tipo_investimento inválido');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const valorN = normalizarDecimal(valor);
    if (!valorN || valorN <= 0) return jsonErro(res, 400, 'Valor do investimento deve ser positivo');

    const result = await pool.query(
      `INSERT INTO investimentos
        (empresa, empresa_id, tipo_investimento, descricao, valor, data, forma_pagamento, observacao, criado_por, criado_em, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
        RETURNING *`,
      [
        empresaResolvida.nome,
        empresaResolvida.id,
        tipo_investimento,
        descricao,
        valorN,
        normalizarDataISO(data) || data,
        forma_pagamento || '',
        observacao || '',
        req.user.id
      ]
    );

    res.json({
      sucesso: true,
      item: {
        ...result.rows[0],
        valor: Number(result.rows[0].valor || 0)
      }
    });
  } catch (error) {
    console.error('Erro ao cadastrar investimento:', error);
    jsonErro(res, 500, 'Erro ao cadastrar investimento');
  }
});

router.get('/investimentos/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');

    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const tipo = (req.query.tipo_investimento || '').trim();
    const busca = (req.query.busca || '').trim().toLowerCase();
    const { dataInicial, dataFinal } = obterPeriodo(req);

    const params = [];
    let sql = `SELECT * FROM investimentos WHERE 1=1`;
    sql += adicionarFiltroEmpresaSaaS({ params, empresaResolvida });
    let idx = params.length + 1;

    if (tipo) {
      sql += ` AND tipo_investimento = $${idx}`;
      params.push(tipo);
      idx++;
    }

    if (busca) {
      const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
      sql += `
          AND (
            LOWER(COALESCE(descricao, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(tipo_investimento, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(observacao, '')) LIKE $${idx} ESCAPE '\\'
          )
        `;
      params.push(`%${buscaEsc}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodo({
      campo: 'data',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    sql += ` ORDER BY id DESC LIMIT 500`;

    const result = await pool.query(sql, params);

    res.json(
      result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar investimentos:', error);
    jsonErro(res, 500, 'Erro ao buscar investimentos');
  }
});

// GET /financeiro/auditoria — histórico de operações financeiras da empresa
router.get('/financeiro/auditoria', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');

    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const { tipo, entidade, busca } = req.query;

    const params = [empresaResolvida.id, empresaResolvida.nome];
    let where = `WHERE (fl.empresa_id = $1 OR (fl.empresa_id IS NULL AND fl.empresa = $2))`;

    if (tipo)    { params.push(tipo);    where += ` AND fl.tipo = $${params.length}`; }
    if (entidade){ params.push(entidade); where += ` AND fl.entidade = $${params.length}`; }
    if (busca)   { const buscaEsc = busca.replace(/[%_\\]/g, '\\$&'); params.push(`%${buscaEsc}%`); where += ` AND fl.descricao ILIKE $${params.length} ESCAPE '\\'`; }

    where += adicionarFiltroPeriodo({ campo: 'fl.criado_em', params, dataInicial, dataFinal });

    const result = await pool.query(
      `SELECT
         fl.id,
         fl.tipo,
         fl.entidade,
         fl.entidade_id,
         fl.descricao,
         fl.valor,
         fl.criado_em,
         COALESCE(u.nome_completo, u.usuario, 'Sistema') AS usuario_nome
       FROM financeiro_logs fl
       LEFT JOIN usuarios u ON u.id = fl.usuario_id
       ${where}
       ORDER BY fl.criado_em DESC
       LIMIT 500`,
      params
    );

    const total = result.rowCount;
    const truncado = total >= 500;

    res.json({ sucesso: true, logs: result.rows, total, truncado });
  } catch (err) {
    console.error('[auditoria financeira]', err.message);
    jsonErro(res, 500, 'Erro ao buscar auditoria financeira');
  }
});

// Endpoint /financeiro/fluxo-caixa/:empresa removido daqui: era duplicata morta
// (sombreada por financeiro.routes.js, que serve o mesmo path e é registrado antes).
// Endpoint de debug removido da produção (expunha schema do banco)


  return router;
};
