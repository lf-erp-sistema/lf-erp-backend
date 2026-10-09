'use strict';
const express = require('express');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../../utils/periodoUtils');
const { requirePermissao } = require('../../utils/permissoes');
const { erro } = require('../../utils/routeHelpers');
const { checkFinanceiro } = require('./helpers');

// Parte 3/3 de relatorios.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// relatórios detalhados de contas a receber e contas a pagar.
module.exports = function relatoriosContasRoutes({
  auth, pool, validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  atualizarStatusContasReceberPorEmpresa, atualizarStatusContasPagarPorEmpresa,
  podeGerenciarFinanceiro
}) {
  const router = express.Router();

  router.get('/financeiro/contas-receber/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res, podeGerenciarFinanceiro)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa, req.empresa_id);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cr:', e.message); }

      const STATUS_CR_VALIDOS = new Set(['pendente', 'atrasado', 'pago', 'parcial', 'parcial_atrasado']);
      const status = (req.query.status || '').trim().toLowerCase();
      if (status && !STATUS_CR_VALIDOS.has(status)) return erro(res, 400, 'Status inválido');
      const busca = (req.query.busca || '').trim().toLowerCase();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [];

      let sql = `
  SELECT *
  FROM contas_receber
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params,
    empresaResolvida
  })}
`;

      let idx = params.length + 1;

      if (status) {
        sql += ` AND LOWER(COALESCE(status, 'pendente')) = $${idx}`;
        params.push(status);
        idx++;
      }

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        sql += `
          AND (
            LOWER(COALESCE(cliente_nome, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(observacao, '')) LIKE $${idx} ESCAPE '\\'
            OR CAST(id AS TEXT) LIKE $${idx} ESCAPE '\\'
          )
        `;
        params.push(`%${buscaEsc}%`);
        idx++;
      }

      sql += adicionarFiltroPeriodo({
        campo: 'data_vencimento',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      const limite = Math.min(Math.max(Number(req.query.limite) || 100, 1), 1000);
      const pagina = Math.max(Number(req.query.pagina) || 1, 1);
      const offset = (pagina - 1) * limite;
      const limIdx = params.length + 1;
      const offIdx = params.length + 2;
      sql += ` ORDER BY data_vencimento ASC NULLS LAST, id DESC LIMIT $${limIdx} OFFSET $${offIdx}`;

      const result = await pool.query(sql, [...params, limite, offset]);
      const truncado = result.rows.length === limite;

      return res.json({ sucesso: true, truncado, dados: result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0),
        parcela: Number(row.parcela || 1),
        total_parcelas: Number(row.total_parcelas || 1)
      })) });
    } catch (error) {
      console.error('Erro real ao gerar relatório de contas a receber:', error);
      return erro(res, 500, 'Erro ao gerar relatório de contas a receber');
    }
  });

  router.get('/financeiro/contas-pagar/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res, podeGerenciarFinanceiro)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa, req.empresa_id);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cp:', e.message); }

      const STATUS_CP_VALIDOS = new Set(['pendente', 'atrasado', 'pago', 'parcial', 'parcial_atrasado']);
      const status = (req.query.status || '').trim().toLowerCase();
      if (status && !STATUS_CP_VALIDOS.has(status)) return erro(res, 400, 'Status inválido');
      const busca = (req.query.busca || '').trim().toLowerCase();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [];

      let sql = `
  SELECT *
  FROM contas_pagar
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params,
    empresaResolvida
  })}
`;

      let idx = params.length + 1;

      if (status) {
        sql += ` AND LOWER(COALESCE(status, 'pendente')) = $${idx}`;
        params.push(status);
        idx++;
      }

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        sql += `
          AND (
            LOWER(COALESCE(fornecedor_nome, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(descricao, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(observacao, '')) LIKE $${idx} ESCAPE '\\'
            OR CAST(id AS TEXT) LIKE $${idx} ESCAPE '\\'
          )
        `;
        params.push(`%${buscaEsc}%`);
        idx++;
      }

      sql += adicionarFiltroPeriodo({
        campo: 'data_vencimento',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      const limite = Math.min(Math.max(Number(req.query.limite) || 100, 1), 1000);
      const pagina = Math.max(Number(req.query.pagina) || 1, 1);
      const offset = (pagina - 1) * limite;
      const limIdx = params.length + 1;
      const offIdx = params.length + 2;
      sql += ` ORDER BY data_vencimento ASC NULLS LAST, id DESC LIMIT $${limIdx} OFFSET $${offIdx}`;

      const result = await pool.query(sql, [...params, limite, offset]);
      const truncado = result.rows.length === limite;

      return res.json({ sucesso: true, truncado, dados: result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0),
        parcela: Number(row.parcela || 1),
        total_parcelas: Number(row.total_parcelas || 1)
      })) });
    } catch (error) {
      console.error('Erro real ao gerar relatório de contas a pagar:', error);
      return erro(res, 500, 'Erro ao gerar relatório de contas a pagar');
    }
  });

  return router;
};
