'use strict';
const express = require('express');
const { obterPeriodo, adicionarFiltroPeriodo, adicionarFiltroPeriodoRange } = require('../../utils/periodoUtils');
const { requirePermissao } = require('../../utils/permissoes');
const { erro } = require('../../utils/routeHelpers');
const { checkFinanceiro } = require('./helpers');

// Parte 1/3 de relatorios.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): resumo financeiro.
module.exports = function relatoriosResumoRoutes({
  auth, pool, validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  atualizarStatusContasReceberPorEmpresa, atualizarStatusContasPagarPorEmpresa,
  podeGerenciarFinanceiro
}) {
  const router = express.Router();

  router.get('/financeiro/resumo/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
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

      const paramsReceber = [];
      const paramsPagar = [];
      const paramsLanc = [];
      const paramsFluxoReceber = [];
      const paramsFluxoPagar = [];
      const paramsInvest = [];
      const paramsVendas = [];
      const paramsCompras = [];

      let whereReceber = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsReceber,
    empresaResolvida
  })}
`;

      let wherePagar = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsPagar,
    empresaResolvida
  })}
`;

      let whereLanc = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsLanc,
    empresaResolvida
  })}
`;

      let whereFluxoReceber = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsFluxoReceber,
    empresaResolvida
  })}
  AND LOWER(COALESCE(status, 'pendente')) = 'pago'
  AND data_pagamento IS NOT NULL
`;

      let whereFluxoPagar = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsFluxoPagar,
    empresaResolvida
  })}
  AND LOWER(COALESCE(status, 'pendente')) = 'pago'
  AND data_pagamento IS NOT NULL
`;

      let whereInvest = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsInvest,
    empresaResolvida
  })}
`;
      let whereVendas = `
  WHERE 1=1
    ${adicionarFiltroEmpresaSaaS({
      alias: 'v',
      params: paramsVendas,
      empresaResolvida
    })}
    AND NOT EXISTS (
      SELECT 1
      FROM contas_receber cr
      WHERE cr.venda_id = v.id
        AND (
          cr.empresa_id = v.empresa_id
          OR (
            cr.empresa_id IS NULL
            AND cr.empresa = v.empresa
          )
        )
    )
`;

      let whereCompras = `
  WHERE 1=1
    ${adicionarFiltroEmpresaSaaS({
      alias: 'c',
      params: paramsCompras,
      empresaResolvida
    })}
    AND LOWER(COALESCE(c.status, 'finalizada')) = 'finalizada'
    AND NOT EXISTS (
      SELECT 1
      FROM contas_pagar cp
      WHERE cp.compra_id = c.id
        AND (
          cp.empresa_id = c.empresa_id
          OR (
            cp.empresa_id IS NULL
            AND cp.empresa = c.empresa
          )
        )
    )
`;

      whereReceber += adicionarFiltroPeriodo({
        campo: 'data_vencimento',
        params: paramsReceber,
        dataInicial,
        dataFinal,
        castDate: false
      });
      wherePagar += adicionarFiltroPeriodo({
        campo: 'data_vencimento',
        params: paramsPagar,
        dataInicial,
        dataFinal,
        castDate: false
      });
      whereLanc += adicionarFiltroPeriodoRange({
        campoInicial: 'vencimento',
        campoFinal: 'pagamento_data',
        params: paramsLanc,
        dataInicial,
        dataFinal,
        castDate: false
      });
      whereFluxoReceber += adicionarFiltroPeriodo({
        campo: 'data_pagamento',
        params: paramsFluxoReceber,
        dataInicial,
        dataFinal,
        castDate: false
      });
      whereFluxoPagar += adicionarFiltroPeriodo({
        campo: 'data_pagamento',
        params: paramsFluxoPagar,
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

      const tag = q => n => { throw Object.assign(n, { _resumoQuery: q }); };
      const [
        receberResult,
        pagarResult,
        lancResult,
        fluxoReceberResult,
        fluxoPagarResult,
        investimentosResult,
        vendasDiretasResult,
        comprasDiretasResult
      ] = await Promise.all([
        pool.query(
          `
          SELECT
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN valor ELSE 0 END),0) AS pago,
            COALESCE(SUM(CASE
              WHEN LOWER(COALESCE(status, 'pendente')) NOT IN ('pago')
                AND (data_vencimento IS NULL OR data_vencimento >= (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::text)
              THEN COALESCE(valor_atualizado, valor) ELSE 0 END),0) AS pendente,
            COALESCE(SUM(CASE
              WHEN LOWER(COALESCE(status, 'pendente')) NOT IN ('pago')
                AND data_vencimento IS NOT NULL
                AND data_vencimento < (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::text
              THEN COALESCE(valor_atualizado, valor) ELSE 0 END),0) AS atrasado
          FROM contas_receber
          ${whereReceber}
        `,
          paramsReceber
        ).catch(tag('contas_receber')),

        pool.query(
          `
          SELECT
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN valor ELSE 0 END),0) AS pago,
            COALESCE(SUM(CASE
              WHEN LOWER(COALESCE(status, 'pendente')) NOT IN ('pago')
                AND (data_vencimento IS NULL OR data_vencimento >= (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::text)
              THEN valor ELSE 0 END),0) AS pendente,
            COALESCE(SUM(CASE
              WHEN LOWER(COALESCE(status, 'pendente')) NOT IN ('pago')
                AND data_vencimento IS NOT NULL
                AND data_vencimento < (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::text
              THEN valor ELSE 0 END),0) AS atrasado
          FROM contas_pagar
          ${wherePagar}
        `,
          paramsPagar
        ).catch(tag('contas_pagar')),

        pool.query(
          `
          SELECT
            COALESCE(SUM(CASE WHEN LOWER(tipo) = 'receita' THEN valor ELSE 0 END),0) AS receitas,
            COALESCE(SUM(CASE WHEN LOWER(tipo) = 'despesa' THEN valor ELSE 0 END),0) AS despesas,
            COALESCE(SUM(CASE WHEN LOWER(tipo) = 'receita' AND LOWER(COALESCE(status, 'pendente')) = 'pago' THEN valor ELSE 0 END),0) AS receitas_pagas,
            COALESCE(SUM(CASE WHEN LOWER(tipo) = 'despesa' AND LOWER(COALESCE(status, 'pendente')) = 'pago' THEN valor ELSE 0 END),0) AS despesas_pagas
          FROM lancamentos_financeiros
          ${whereLanc}
        `,
          paramsLanc
        ).catch(tag('lancamentos_financeiros')),

        pool.query(
          `SELECT COALESCE(SUM(valor),0) AS total FROM contas_receber ${whereFluxoReceber}`,
          paramsFluxoReceber
        ).catch(tag('fluxo_receber')),
        pool.query(
          `SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar ${whereFluxoPagar}`,
          paramsFluxoPagar
        ).catch(tag('fluxo_pagar')),
        pool.query(
          `SELECT COALESCE(SUM(valor),0) AS total FROM investimentos ${whereInvest}`,
          paramsInvest
        ).catch(tag('investimentos')),
        pool.query(
          `SELECT COALESCE(SUM(v.total),0) AS total FROM vendas v ${whereVendas}`,
          paramsVendas
        ).catch(tag('vendas_diretas')),
        pool.query(
          `SELECT COALESCE(SUM(c.total),0) AS total FROM compras c ${whereCompras}`,
          paramsCompras
        ).catch(tag('compras_diretas'))
      ]);

      const receber = receberResult.rows[0];
      const pagar = pagarResult.rows[0];
      const lanc = lancResult.rows[0];

      const entradas =
        Number(fluxoReceberResult.rows[0].total || 0) +
        Number(vendasDiretasResult.rows[0].total || 0) +
        Number(lanc.receitas_pagas || 0);

      const saidas =
        Number(fluxoPagarResult.rows[0].total || 0) +
        Number(comprasDiretasResult.rows[0].total || 0) +
        Number(lanc.despesas_pagas || 0) +
        Number(investimentosResult.rows[0].total || 0);

      return res.json({
        sucesso: true,
        contas_receber: {
          pago: Number(receber.pago || 0),
          pendente: Number(receber.pendente || 0),
          atrasado: Number(receber.atrasado || 0)
        },
        contas_pagar: {
          pago: Number(pagar.pago || 0),
          pendente: Number(pagar.pendente || 0),
          atrasado: Number(pagar.atrasado || 0)
        },
        lancamentos: {
          receitas: Number(lanc.receitas || 0),
          despesas: Number(lanc.despesas || 0),
          receitas_pagas: Number(lanc.receitas_pagas || 0),
          despesas_pagas: Number(lanc.despesas_pagas || 0)
        },
        fluxo: {
          entradas: Number(entradas.toFixed(2)),
          saidas: Number(saidas.toFixed(2)),
          saldo: Number((entradas - saidas).toFixed(2))
        }
      });
    } catch (error) {
      console.error('Erro real ao gerar resumo financeiro [query=%s]:', error._resumoQuery || 'desconhecida', error);
      return erro(res, 500, 'Erro ao gerar resumo financeiro');
    }
  });

  return router;
};
