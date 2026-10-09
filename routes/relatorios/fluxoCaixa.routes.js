'use strict';
const express = require('express');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../../utils/periodoUtils');
const { requirePermissao } = require('../../utils/permissoes');
const { erro } = require('../../utils/routeHelpers');
const { checkFinanceiro } = require('./helpers');

// Parte 2/3 de relatorios.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): fluxo de caixa detalhado.
module.exports = function relatoriosFluxoCaixaRoutes({
  auth, pool, validarAcessoEmpresa,
  atualizarStatusContasReceberPorEmpresa, atualizarStatusContasPagarPorEmpresa,
  podeGerenciarFinanceiro
}) {
  const router = express.Router();

  router.get('/financeiro/fluxo-caixa/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res, podeGerenciarFinanceiro)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa, req.empresa_id);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cr:', e.message); }
      try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cp:', e.message); }

      const { dataInicial, dataFinal } = obterPeriodo(req);

      const paramsReceber = [empresaResolvida.id, empresaResolvida.nome];
      const paramsPagar = [empresaResolvida.id, empresaResolvida.nome];
      const paramsLanc = [empresaResolvida.id, empresaResolvida.nome];
      const paramsInvest = [empresaResolvida.id, empresaResolvida.nome];
      const paramsVendas = [empresaResolvida.id, empresaResolvida.nome];
      const paramsCompras = [empresaResolvida.id, empresaResolvida.nome];

      let whereReceber = `
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
          AND LOWER(COALESCE(status, 'pendente')) = 'pago'
          AND data_pagamento IS NOT NULL
      `;

      let wherePagar = `
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
          AND LOWER(COALESCE(status, 'pendente')) = 'pago'
          AND data_pagamento IS NOT NULL
      `;

      let whereLanc = `
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
          AND LOWER(COALESCE(status, 'pendente')) = 'pago'
          AND pagamento_data IS NOT NULL
      `;

      let whereInvest = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;

      let whereVendas = `
        WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))
          AND NOT EXISTS (
            SELECT 1
            FROM contas_receber cr
            WHERE cr.venda_id = v.id
              AND (cr.empresa_id = v.empresa_id OR (cr.empresa_id IS NULL AND cr.empresa = v.empresa))
          )
      `;

      let whereCompras = `
        WHERE (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))
          AND LOWER(COALESCE(c.status, 'finalizada')) = 'finalizada'
          AND NOT EXISTS (
            SELECT 1
            FROM contas_pagar cp
            WHERE cp.compra_id = c.id
              AND (cp.empresa_id = c.empresa_id OR (cp.empresa_id IS NULL AND cp.empresa = c.empresa))
          )
      `;

      whereReceber += adicionarFiltroPeriodo({
        campo: 'data_pagamento',
        params: paramsReceber,
        dataInicial,
        dataFinal,
        castDate: false
      });
      wherePagar += adicionarFiltroPeriodo({
        campo: 'data_pagamento',
        params: paramsPagar,
        dataInicial,
        dataFinal,
        castDate: false
      });
      whereLanc += adicionarFiltroPeriodo({
        campo: 'pagamento_data',
        params: paramsLanc,
        dataInicial,
        dataFinal,
        castDate: false
      });
      whereInvest += adicionarFiltroPeriodo({
        campo: 'data',
        params: paramsInvest,
        dataInicial,
        dataFinal,
        castDate: false
      });
      whereVendas += adicionarFiltroPeriodo({
        campo: 'v.data',
        params: paramsVendas,
        dataInicial,
        dataFinal,
        castDate: false
      });
      whereCompras += adicionarFiltroPeriodo({
        campo: 'c.data',
        params: paramsCompras,
        dataInicial,
        dataFinal,
        castDate: false
      });

      const [
        movimentosReceberResult,
        movimentosPagarResult,
        movimentosLancamentosResult,
        movimentosInvestimentosResult,
        movimentosVendasResult,
        movimentosComprasResult
      ] = await Promise.all([
        pool.query(
          `
          SELECT
            id,
            'conta_receber' AS origem,
            'entrada' AS tipo,
            COALESCE(cliente_nome, 'Cliente não informado') AS descricao,
            COALESCE(valor_atualizado, valor) AS valor,
            data_pagamento AS data_movimento,
            forma_pagamento,
            venda_id AS referencia_id,
            observacao
          FROM contas_receber
          ${whereReceber}
          LIMIT 5000
        `,
          paramsReceber
        ),

        pool.query(
          `
          SELECT
            id,
            'conta_pagar' AS origem,
            'saida' AS tipo,
            COALESCE(descricao, fornecedor_nome, 'Conta a pagar') AS descricao,
            valor,
            data_pagamento AS data_movimento,
            forma_pagamento,
            compra_id AS referencia_id,
            observacao
          FROM contas_pagar
          ${wherePagar}
          LIMIT 5000
        `,
          paramsPagar
        ),

        pool.query(
          `
          SELECT
            id,
            'lancamento_financeiro' AS origem,
            CASE WHEN LOWER(tipo) = 'receita' THEN 'entrada' ELSE 'saida' END AS tipo,
            COALESCE(descricao, categoria, 'Lançamento financeiro') AS descricao,
            valor,
            pagamento_data AS data_movimento,
            NULL AS forma_pagamento,
            NULL AS referencia_id,
            observacao
          FROM lancamentos_financeiros
          ${whereLanc}
          LIMIT 5000
        `,
          paramsLanc
        ),

        pool.query(
          `
          SELECT
            id,
            'investimento' AS origem,
            'saida' AS tipo,
            COALESCE(descricao, tipo_investimento, 'Investimento') AS descricao,
            valor,
            data AS data_movimento,
            NULL AS forma_pagamento,
            NULL AS referencia_id,
            observacao
          FROM investimentos
          ${whereInvest}
          LIMIT 5000
        `,
          paramsInvest
        ),

        pool.query(
          `
          SELECT
            v.id,
            'venda_direta' AS origem,
            'entrada' AS tipo,
            COALESCE(v.cliente_nome, 'Venda direta') AS descricao,
            v.total AS valor,
            v.data AS data_movimento,
            v.pagamento AS forma_pagamento,
            v.id AS referencia_id,
            NULL AS observacao
          FROM vendas v
          ${whereVendas}
          LIMIT 5000
        `,
          paramsVendas
        ),

        pool.query(
          `
          SELECT
            c.id,
            'compra_direta' AS origem,
            'saida' AS tipo,
            COALESCE(f.nome, 'Compra direta') AS descricao,
            c.total AS valor,
            c.data AS data_movimento,
            c.pagamento AS forma_pagamento,
            c.id AS referencia_id,
            c.observacao
          FROM compras c
          LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
            AND (f.empresa_id = $1 OR (f.empresa_id IS NULL AND f.empresa = $2))
          ${whereCompras}
          LIMIT 5000
        `,
          paramsCompras
        )
      ]);

      const movimentos = [
        ...movimentosReceberResult.rows,
        ...movimentosPagarResult.rows,
        ...movimentosLancamentosResult.rows,
        ...movimentosInvestimentosResult.rows,
        ...movimentosVendasResult.rows,
        ...movimentosComprasResult.rows
      ]
        .map((row) => ({
          ...row,
          valor: Number(row.valor || 0)
        }))
        .sort((a, b) => {
          const da = a.data_movimento ? new Date(a.data_movimento).getTime() : 0;
          const db = b.data_movimento ? new Date(b.data_movimento).getTime() : 0;
          return db - da;
        });

      return res.json({ sucesso: true, dados: movimentos });
    } catch (error) {
      console.error('Erro real ao gerar relatório de fluxo de caixa:', error);
      return erro(res, 500, 'Erro ao gerar relatório de fluxo de caixa');
    }
  });

  return router;
};
