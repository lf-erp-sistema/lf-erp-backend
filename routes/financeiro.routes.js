const express = require('express');

const { requirePermissao } = require('../utils/permissoes');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');

const { normalizarFormaPagamentoFluxo } = require('../utils/financeiroUtils');
const { erro } = require('../utils/routeHelpers');

module.exports = function ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa
}) {
  const router = express.Router();


  // ================= FLUXO DE CAIXA =================

  router.get('/fluxo-caixa/:empresa', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[fluxo-caixa] status-cr:', e.message); }
      try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[fluxo-caixa] status-cp:', e.message); }

      const { dataInicial, dataFinal } = obterPeriodo(req);

      const paramsReceber = [];
      const paramsPagar = [];
      const paramsLanc = [];
      const paramsInvest = [];
      const paramsVendas = [];
      const paramsCompras = [];

      let whereReceber = `
        WHERE 1=1
        ${adicionarFiltroEmpresaSaaS({
          params: paramsReceber,
          empresaResolvida
        })}
        AND LOWER(COALESCE(status,'pendente')) = 'pago'
        AND data_pagamento IS NOT NULL
      `;

      let wherePagar = `
        WHERE 1=1
        ${adicionarFiltroEmpresaSaaS({
          params: paramsPagar,
          empresaResolvida
        })}
        AND LOWER(COALESCE(status,'pendente')) = 'pago'
        AND data_pagamento IS NOT NULL
      `;

      let whereLanc = `
        WHERE 1=1
        ${adicionarFiltroEmpresaSaaS({
          params: paramsLanc,
          empresaResolvida
        })}
        AND LOWER(COALESCE(status,'pendente')) = 'pago'
        AND pagamento_data IS NOT NULL
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
          SELECT 1 FROM contas_receber cr
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
        AND LOWER(COALESCE(c.status,'finalizada')) = 'finalizada'
        AND NOT EXISTS (
          SELECT 1 FROM contas_pagar cp
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

      const FLUXO_LIMIT = 1000;

      const [movReceber, movPagar, movLanc, movInvest, movVendas, movCompras] = await Promise.all([
        pool.query(
          `SELECT id,'conta_receber' origem,'entrada' tipo,
          COALESCE(cliente_nome,'Cliente') descricao,
          valor,data_pagamento data_movimento,forma_pagamento,
          venda_id referencia_id,observacao
          FROM contas_receber ${whereReceber}
          ORDER BY data_pagamento DESC LIMIT $${paramsReceber.length + 1}`,
          [...paramsReceber, FLUXO_LIMIT]
        ),

        pool.query(
          `SELECT id,'conta_pagar' origem,'saida' tipo,
          COALESCE(descricao,fornecedor_nome,'Conta') descricao,
          valor,data_pagamento data_movimento,forma_pagamento,
          compra_id referencia_id,observacao
          FROM contas_pagar ${wherePagar}
          ORDER BY data_pagamento DESC LIMIT $${paramsPagar.length + 1}`,
          [...paramsPagar, FLUXO_LIMIT]
        ),

        pool.query(
          `SELECT id,'lancamento_financeiro' origem,
          CASE WHEN tipo='receita' THEN 'entrada' ELSE 'saida' END tipo,
          descricao,valor,pagamento_data data_movimento,
          NULL forma_pagamento,NULL referencia_id,observacao
          FROM lancamentos_financeiros ${whereLanc}
          ORDER BY pagamento_data DESC LIMIT $${paramsLanc.length + 1}`,
          [...paramsLanc, FLUXO_LIMIT]
        ),

        pool.query(
          `SELECT id,'investimento' origem,'saida' tipo,
          descricao,valor,data data_movimento,
          NULL forma_pagamento,NULL referencia_id,observacao
          FROM investimentos ${whereInvest}
          ORDER BY data DESC LIMIT $${paramsInvest.length + 1}`,
          [...paramsInvest, FLUXO_LIMIT]
        ),

        pool.query(
          `SELECT v.id,'venda_direta' origem,'entrada' tipo,
          COALESCE(v.cliente_nome,'Venda') descricao,
          v.total valor,v.data data_movimento,
          v.pagamento forma_pagamento,
          v.id referencia_id,NULL observacao
          FROM vendas v ${whereVendas}
          ORDER BY v.data DESC LIMIT $${paramsVendas.length + 1}`,
          [...paramsVendas, FLUXO_LIMIT]
        ),

        pool.query(
          `SELECT c.id,'compra_direta' origem,'saida' tipo,
          COALESCE(f.nome,'Compra') descricao,
          c.total valor,c.data data_movimento,
          c.pagamento forma_pagamento,
          c.id referencia_id,c.observacao
          FROM compras c
          LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
          ${whereCompras}
          ORDER BY c.data DESC LIMIT $${paramsCompras.length + 1}`,
          [...paramsCompras, FLUXO_LIMIT]
        )
      ]);

      const truncado = [movReceber, movPagar, movLanc, movInvest, movVendas, movCompras]
        .some(r => r.rowCount >= FLUXO_LIMIT);

      const movimentos = [
        ...movReceber.rows,
        ...movPagar.rows,
        ...movLanc.rows,
        ...movInvest.rows,
        ...movVendas.rows,
        ...movCompras.rows
      ].map((m) => ({
        ...m,
        valor: Number(m.valor || 0),
        forma_pagamento: normalizarFormaPagamentoFluxo(m.forma_pagamento)
      }));

      const entradas = movimentos
        .filter((m) => m.tipo === 'entrada')
        .reduce((acc, m) => acc + m.valor, 0);

      const saidas = movimentos
        .filter((m) => m.tipo === 'saida')
        .reduce((acc, m) => acc + m.valor, 0);

      // F-A2: construir resumo por forma de pagamento via agregação em JS
      const resumoFormasPagamento = movimentos.reduce((acc, m) => {
        const k = m.forma_pagamento || 'nao_informado';
        if (!acc[k]) acc[k] = { entradas: 0, saidas: 0 };
        if (m.tipo === 'entrada') acc[k].entradas = Number((acc[k].entradas + m.valor).toFixed(2));
        else acc[k].saidas = Number((acc[k].saidas + m.valor).toFixed(2));
        return acc;
      }, {});

      return res.json({
        sucesso: true,
        truncado,
        entradas,
        saidas,
        saldo: entradas - saidas,
        movimentos,
        resumo_formas_pagamento: resumoFormasPagamento
      });
    } catch (error) {
      console.error('Erro real no fluxo de caixa:', error);
      return erro(res, 500, 'Erro no fluxo de caixa');
    }
  });

  // ── Cashflow futuro ───────────────────────────────────────────────────────────
  // GET /financeiro/cashflow-futuro?dias=30|60|90
  router.get('/cashflow-futuro', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);

      await Promise.all([
        atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id).catch(e => console.error('[cashflow-futuro] status-cr:', e.message)),
        atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id).catch(e => console.error('[cashflow-futuro] status-cp:', e.message))
      ]);

      // Datas em Fortaleza — usar UTC noon para evitar off-by-one no servidor em UTC
      const fmtISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' });
      const hojeISO   = fmtISO.format(new Date());
      const limiteData = new Date(hojeISO + 'T12:00:00Z');
      limiteData.setUTCDate(limiteData.getUTCDate() + dias);
      const limiteISO = limiteData.toISOString().substring(0, 10);

      const [receberResult, pagarResult] = await Promise.all([
        pool.query(
          `SELECT
             data_vencimento AS data,
             SUM(COALESCE(valor_atualizado, valor)) AS valor,
             COUNT(*) AS qtd
           FROM contas_receber
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
             AND COALESCE(status,'pendente') NOT IN ('pago', 'cancelado', 'estornado')
             AND data_vencimento IS NOT NULL
             AND data_vencimento >= $3
             AND data_vencimento <= $4
           GROUP BY data_vencimento
           ORDER BY data_vencimento`,
          [empresaResolvida.id, empresaResolvida.nome, hojeISO, limiteISO]
        ),
        pool.query(
          `SELECT
             data_vencimento AS data,
             SUM(COALESCE(valor_atualizado, valor)) AS valor,
             COUNT(*) AS qtd
           FROM contas_pagar
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
             AND COALESCE(status,'pendente') NOT IN ('pago', 'cancelado', 'estornado')
             AND data_vencimento IS NOT NULL
             AND data_vencimento >= $3
             AND data_vencimento <= $4
           GROUP BY data_vencimento
           ORDER BY data_vencimento`,
          [empresaResolvida.id, empresaResolvida.nome, hojeISO, limiteISO]
        )
      ]);

      // Monta mapa de dias com entradas e saídas
      const mapaEntradas = {};
      const mapaSaidas   = {};
      let totalEntradas  = 0;
      let totalSaidas    = 0;

      for (const row of receberResult.rows) {
        mapaEntradas[row.data] = Number(row.valor || 0);
        totalEntradas += Number(row.valor || 0);
      }
      for (const row of pagarResult.rows) {
        mapaSaidas[row.data] = Number(row.valor || 0);
        totalSaidas += Number(row.valor || 0);
      }

      // Cria array de dias com saldo acumulado
      const fmtFortaleza = fmtISO;
      const hoje = new Date(hojeISO + 'T12:00:00Z');
      let saldoAcum = 0;
      const projecao = [];

      for (let i = 0; i <= dias; i++) {
        const d = new Date(hoje);
        d.setUTCDate(d.getUTCDate() + i);
        const key = fmtFortaleza.format(d);
        const entrada = mapaEntradas[key] || 0;
        const saida   = mapaSaidas[key]   || 0;

        if (entrada > 0 || saida > 0) {
          saldoAcum += entrada - saida;
          projecao.push({ data: key, entrada, saida, saldo_acumulado: Number(saldoAcum.toFixed(2)) });
        }
      }

      return res.json({
        sucesso: true,
        dias,
        total_entradas:  Number(totalEntradas.toFixed(2)),
        total_saidas:    Number(totalSaidas.toFixed(2)),
        saldo_projetado: Number((totalEntradas - totalSaidas).toFixed(2)),
        projecao
      });
    } catch (err) {
      console.error('[financeiro] cashflow-futuro:', err.message, err.stack);
      return erro(res, 500, 'Erro ao calcular cashflow futuro');
    }
  });

  return router;
};
