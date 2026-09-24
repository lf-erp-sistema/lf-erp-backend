'use strict';
const express = require('express');
const { obterPeriodo, adicionarFiltroPeriodo, adicionarFiltroPeriodoRange } = require('../utils/periodoUtils');
const { requirePermissao } = require('../utils/permissoes');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function dashboardRoutes({
  auth, pool,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa,
}) {
  const router = express.Router();
router.get('/dashboard', auth, requirePermissao(pool, 'dashboard', 'ver'), async (req, res) => {
  try {
    const empresaInformada = req.query.empresa || null;
    const empresaResolvida = await validarAcessoEmpresa(req, empresaInformada);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    await Promise.all([
      atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id).catch(e => console.error('[dashboard] status-cr:', e.message)),
      atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id).catch(e => console.error('[dashboard] status-cp:', e.message))
    ]);

    const { dataInicial, dataFinal } = obterPeriodo(req);

    // Período anterior (mesma duração, imediatamente antes)
    let prevInicial = null, prevFinal = null;
    if (dataInicial && dataFinal) {
      const ini = new Date(dataInicial);
      const fim = new Date(dataFinal);
      const dias = Math.round((fim - ini) / 86400000);
      const pFim = new Date(ini);
      pFim.setDate(pFim.getDate() - 1);
      const pIni = new Date(pFim);
      pIni.setDate(pIni.getDate() - dias);
      const _fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' });
      prevInicial = _fmtDate.format(pIni);
      prevFinal   = _fmtDate.format(pFim);
    }

    const vendasParams = [];
    const comprasParams = [];
    const receberParams = [];
    const pagarParams = [];
    const clientesParams = [];
    const produtosParams = [];
    const lancamentosParams = [empresaResolvida.nome, empresaResolvida.id];

    let vendasWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: vendasParams, empresaResolvida })}
`;

    let comprasWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: comprasParams, empresaResolvida })}
`;

    let receberWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: receberParams, empresaResolvida })}
  AND status IN ('pendente', 'atrasado', 'parcial', 'parcial_atrasado')
`;

    let pagarWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: pagarParams, empresaResolvida })}
  AND status IN ('pendente', 'atrasado', 'parcial', 'parcial_atrasado')
`;

    let clientesWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: clientesParams, empresaResolvida })}
  AND deletado_em IS NULL
`;

    let produtosWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: produtosParams, empresaResolvida })}
  AND deletado_em IS NULL
`;

    let lancamentosWhere = `
  WHERE (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $1))
  AND LOWER(COALESCE(status, 'pendente')) = 'pago'
  AND pagamento_data IS NOT NULL
`;

    vendasWhere += adicionarFiltroPeriodo({
      campo: 'data',
      params: vendasParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    comprasWhere += adicionarFiltroPeriodo({
      campo: 'data',
      params: comprasParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    receberWhere += adicionarFiltroPeriodo({
      campo: 'data_vencimento',
      params: receberParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    pagarWhere += adicionarFiltroPeriodo({
      campo: 'data_vencimento',
      params: pagarParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    // clientesWhere não filtra por período: o card exibe total de clientes na base,
    // não novos no período (consistente com produtosWhere que também não filtra)

    lancamentosWhere += adicionarFiltroPeriodo({
      campo: 'pagamento_data',
      params: lancamentosParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const topProdutosParams = [];
    const estoqueBaixoParams = [];
    const indicadoresFinanceirosParams = [];
    const abcParams = [];

    let topProdutosJoinAndWhere = `
  FROM venda_itens vi
  INNER JOIN vendas v
    ON v.id = vi.venda_id
    AND (
      v.empresa_id = vi.empresa_id
      OR (
        vi.empresa_id IS NULL
        AND v.empresa = vi.empresa
      )
    )
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    alias: 'vi',
    params: topProdutosParams,
    empresaResolvida
  })}
`;

    if (dataInicial) {
      topProdutosParams.push(dataInicial);
      topProdutosJoinAndWhere += ` AND v.data >= $${topProdutosParams.length}`;
    }

    if (dataFinal) {
      topProdutosParams.push(dataFinal);
      topProdutosJoinAndWhere += ` AND v.data <= $${topProdutosParams.length}`;
    }

    // Queries do período anterior (faturamento, vendas, clientes)
    const vAntParams = [];
    const cAntParams = [];
    let vAntWhere = `WHERE 1=1 ${adicionarFiltroEmpresaSaaS({ params: vAntParams, empresaResolvida })}`;
    // cAntWhere conta clientes ativos até o final do período anterior (snapshot cumulativo)
    let cAntWhere = `WHERE 1=1 ${adicionarFiltroEmpresaSaaS({ params: cAntParams, empresaResolvida })} AND deletado_em IS NULL`;
    if (prevInicial) {
      vAntParams.push(prevInicial); vAntWhere += ` AND data >= $${vAntParams.length}`;
    }
    if (prevFinal) {
      vAntParams.push(prevFinal); vAntWhere += ` AND data <= $${vAntParams.length}`;
      cAntParams.push(prevFinal); cAntWhere += ` AND criado_em::date <= $${cAntParams.length}`;
    }

    const [
      vendasResult,
      comprasResult,
      receberResult,
      pagarResult,
      produtosResult,
      clientesResult,
      topProdutosResult,
      estoqueBaixoResult,
      indicadoresFinanceirosResult,
      abcResult,
      lancamentosFinanceirosResult,
      vendasAntResult,
      clientesAntResult
    ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total_vendas, COALESCE(SUM(total), 0) AS faturamento FROM vendas ${vendasWhere}`,
        vendasParams
      ),
      pool.query(
        `SELECT COUNT(*) AS total_compras, COALESCE(SUM(total), 0) AS total_compras_valor FROM compras ${comprasWhere}`,
        comprasParams
      ),
      pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS contas_receber FROM contas_receber ${receberWhere}`,
        receberParams
      ),
      pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS contas_pagar FROM contas_pagar ${pagarWhere}`,
        pagarParams
      ),
      pool.query(
        `SELECT COUNT(*) AS total_produtos, COALESCE(SUM(estoque), 0) AS total_estoque FROM produtos ${produtosWhere}`,
        produtosParams
      ),
      pool.query(
        `SELECT COUNT(*) AS total_clientes FROM clientes ${clientesWhere}`,
        clientesParams
      ),
      pool.query(
        `
          SELECT
            vi.produto_nome AS nome,
            COALESCE(SUM(vi.quantidade), 0) AS quantidade
          ${topProdutosJoinAndWhere}
          GROUP BY vi.produto_nome
          ORDER BY quantidade DESC, nome ASC
          LIMIT 5
          `,
        topProdutosParams
      ),
      pool.query(
        `
  SELECT COUNT(*) AS total
  FROM produtos
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: estoqueBaixoParams,
    empresaResolvida
  })}
    AND estoque <= estoque_minimo
    AND estoque_minimo > 0
    AND deletado_em IS NULL
  `,
        estoqueBaixoParams
      ),

      pool.query(
        `
  SELECT
    COALESCE(SUM(estoque * custo_medio), 0) AS estoque_investido,
    COALESCE(SUM(estoque * lucro_unitario), 0) AS lucro_potencial,
    COALESCE(AVG(margem_lucro), 0) AS margem_media,
    COUNT(*) FILTER (
      WHERE promocao_ativa = TRUE
    ) AS produtos_promocao,
    COUNT(*) FILTER (
      WHERE lucro_unitario < 0
    ) AS produtos_prejuizo
  FROM produtos
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: indicadoresFinanceirosParams,
    empresaResolvida
  })}
  AND deletado_em IS NULL
  `,
        indicadoresFinanceirosParams
      ),
      pool.query(
        `
  WITH base AS (
    SELECT
      id,
      nome,
      COALESCE(lucro_unitario, 0) * COALESCE(estoque, 0) AS lucro_total
    FROM produtos
    WHERE 1=1
    ${adicionarFiltroEmpresaSaaS({
      params: abcParams,
      empresaResolvida
    })}
    AND deletado_em IS NULL
  ),
  ordenado AS (
    SELECT
      *,
      SUM(lucro_total) OVER () AS lucro_geral
    FROM base
  ),
  acumulado AS (
    SELECT
      *,
      CASE
        WHEN lucro_geral <= 0 THEN 0
        ELSE (
          SUM(lucro_total) OVER (
            ORDER BY lucro_total DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) / lucro_geral
        ) * 100
      END AS acumulado_percentual
    FROM ordenado
  )
  SELECT
    COUNT(*) FILTER (
      WHERE acumulado_percentual <= 80
    ) AS classe_a,
    COUNT(*) FILTER (
      WHERE acumulado_percentual > 80
      AND acumulado_percentual <= 95
    ) AS classe_b,
    COUNT(*) FILTER (
      WHERE acumulado_percentual > 95
    ) AS classe_c
  FROM acumulado
  `,
        abcParams
      ),

      pool.query(
        `
  SELECT
    tipo,
    COALESCE(SUM(valor), 0) AS total
  FROM lancamentos_financeiros
  ${lancamentosWhere}
  GROUP BY tipo
  `,
        lancamentosParams
      ),

      // Período anterior
      pool.query(
        `SELECT COUNT(*) AS total_vendas, COALESCE(SUM(total), 0) AS faturamento FROM vendas ${vAntWhere}`,
        vAntParams
      ),
      pool.query(
        `SELECT COUNT(*) AS total_clientes FROM clientes ${cAntWhere}`,
        cAntParams
      )
    ]);

    const vendasRow = vendasResult.rows[0];
    const comprasRow = comprasResult.rows[0];
    const receberRow = receberResult.rows[0];
    const pagarRow = pagarResult.rows[0];
    const produtosRow = produtosResult.rows[0];
    const clientesRow = clientesResult.rows[0];
    const indicadoresFinanceirosRow = indicadoresFinanceirosResult.rows[0];
    const abcRow = abcResult.rows[0];
    const lancamentosFinanceirosResumo = lancamentosFinanceirosResult.rows.reduce(
      (acc, row) => {
        const tipo = String(row.tipo || '').toLowerCase();
        const valor = Number(row.total || 0);

        if (tipo === 'receita') acc.receitas += valor;
        if (tipo === 'despesa') acc.despesas += valor;

        return acc;
      },
      { receitas: 0, despesas: 0 }
    );

    const alertas = [];
    if (Number(estoqueBaixoResult.rows[0].total || 0) > 0) {
      alertas.push({
        tipo: 'warning',
        texto: `${Number(estoqueBaixoResult.rows[0].total || 0)} produto(s) com estoque baixo`
      });
    }

    if (Number(pagarRow.contas_pagar || 0) > 0) {
      alertas.push({
        tipo: 'danger',
        texto: `Há ${Number(pagarRow.contas_pagar || 0).toLocaleString('pt-BR', {
          style: 'currency',
          currency: 'BRL'
        })} em contas a pagar`
      });
    }

    if (Number(receberRow.contas_receber || 0) > 0) {
      alertas.push({
        tipo: 'info',
        texto: `Há ${Number(receberRow.contas_receber || 0).toLocaleString('pt-BR', {
          style: 'currency',
          currency: 'BRL'
        })} em contas a receber`
      });
    }

    res.json({
      faturamento: Number(vendasRow.faturamento || 0),
      receitas_realizadas: Number(lancamentosFinanceirosResumo.receitas || 0),
      despesas_realizadas: Number(lancamentosFinanceirosResumo.despesas || 0),
      saldo_financeiro_realizado: Number(
        (
          Number(lancamentosFinanceirosResumo.receitas || 0) -
          Number(lancamentosFinanceirosResumo.despesas || 0)
        ).toFixed(2)
      ),
      vendas: Number(vendasRow.total_vendas || 0),
      contas_receber: Number(receberRow.contas_receber || 0),
      contas_pagar: Number(pagarRow.contas_pagar || 0),
      estoque: Number(produtosRow.total_estoque || 0),
      clientes: Number(clientesRow.total_clientes || 0),
      total_produtos: Number(produtosRow.total_produtos || 0),
      total_compras: Number(comprasRow.total_compras || 0),
      total_compras_valor: Number(comprasRow.total_compras_valor || 0),
      estoque_investido: Number(indicadoresFinanceirosRow.estoque_investido || 0),

      lucro_potencial: Number(indicadoresFinanceirosRow.lucro_potencial || 0),

      margem_media: Number(indicadoresFinanceirosRow.margem_media || 0),

      produtos_promocao: Number(indicadoresFinanceirosRow.produtos_promocao || 0),

      produtos_prejuizo: Number(indicadoresFinanceirosRow.produtos_prejuizo || 0),
      classe_a: Number(abcRow.classe_a || 0),

      classe_b: Number(abcRow.classe_b || 0),

      classe_c: Number(abcRow.classe_c || 0),

      recomendacoes: [
        ...(Number(indicadoresFinanceirosRow.produtos_prejuizo || 0) > 0
          ? [
              {
                tipo: 'danger',
                texto: `${Number(indicadoresFinanceirosRow.produtos_prejuizo)} produto(s) operando com prejuízo`
              }
            ]
          : []),

        ...(Number(indicadoresFinanceirosRow.margem_media || 0) < 15
          ? [
              {
                tipo: 'warning',
                texto: 'Margem média da operação está baixa'
              }
            ]
          : []),

        ...(Number(abcRow.classe_c || 0) > Number(abcRow.classe_a || 0)
          ? [
              {
                tipo: 'warning',
                texto: 'Quantidade elevada de produtos Classe C'
              }
            ]
          : []),

        ...(Number(indicadoresFinanceirosRow.produtos_promocao || 0) > 0
          ? [
              {
                tipo: 'info',
                texto: `${Number(indicadoresFinanceirosRow.produtos_promocao)} produto(s) em promoção ativa`
              }
            ]
          : [])
      ],

      top_produtos: topProdutosResult.rows.map((row) => ({
        nome: row.nome,
        quantidade: Number(row.quantidade || 0)
      })),
      alertas,

      comparativo: prevInicial ? {
        faturamento: Number(vendasAntResult.rows[0]?.faturamento  || 0),
        vendas:      Number(vendasAntResult.rows[0]?.total_vendas || 0),
        clientes:    Number(clientesAntResult.rows[0]?.total_clientes || 0)
      } : null
    });
  } catch (error) {
    console.error('Erro real ao carregar dashboard:', error);
    jsonErro(res, 500, 'Erro ao carregar dashboard');
  }
});


router.get('/dashboard/grafico', auth, requirePermissao(pool, 'dashboard', 'ver'), async (req, res) => {
  try {
    const empresaInformada = req.query.empresa || null;
    const empresaResolvida = await validarAcessoEmpresa(req, empresaInformada);

    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { dataInicial, dataFinal } = obterPeriodo(req);

    const vendasDiaParams = [];
    const formaParams = [];

    let vendasDiaWhere = `WHERE 1=1 ${adicionarFiltroEmpresaSaaS({ params: vendasDiaParams, empresaResolvida })}`;
    let formaWhere = `WHERE 1=1 ${adicionarFiltroEmpresaSaaS({ params: formaParams, empresaResolvida })}`;

    vendasDiaWhere += adicionarFiltroPeriodo({ campo: 'data', params: vendasDiaParams, dataInicial, dataFinal, castDate: false });
    formaWhere    += adicionarFiltroPeriodo({ campo: 'data', params: formaParams,    dataInicial, dataFinal, castDate: false });

    const [vendasDiaResult, formaResult] = await Promise.all([
      pool.query(
        `SELECT
           data::date AS dia,
           COALESCE(SUM(total), 0)  AS total,
           COUNT(*)                 AS quantidade
         FROM vendas
         ${vendasDiaWhere}
         GROUP BY dia
         ORDER BY dia`,
        vendasDiaParams
      ),
      pool.query(
        `SELECT
           COALESCE(NULLIF(TRIM(pagamento), ''), 'Outros') AS forma,
           COUNT(*)                                              AS quantidade,
           COALESCE(SUM(total), 0)                              AS total
         FROM vendas
         ${formaWhere}
         GROUP BY forma
         ORDER BY total DESC`,
        formaParams
      )
    ]);

    res.json({
      vendas_por_dia: vendasDiaResult.rows.map((r) => ({
        data:       r.dia,
        total:      Number(r.total),
        quantidade: Number(r.quantidade)
      })),
      forma_pagamento: formaResult.rows.map((r) => ({
        forma:      r.forma,
        quantidade: Number(r.quantidade),
        total:      Number(r.total)
      }))
    });
  } catch (error) {
    console.error('Erro ao carregar gráfico do dashboard:', error);
    jsonErro(res, 500, 'Erro ao carregar gráfico');
  }
});

  return router;
};
