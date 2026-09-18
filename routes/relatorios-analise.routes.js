const express = require('express');

const {
  obterPeriodo,
  adicionarFiltroPeriodo,
  adicionarFiltroPeriodoRange
} = require('../utils/periodoUtils');

const { requirePermissao } = require('../utils/permissoes');
const { erro } = require('../utils/routeHelpers');

module.exports = function ({
  auth,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa,
  podeGerenciarFinanceiro
}) {
  const router = express.Router();



  function checkFinanceiro(req, res) {
    if (typeof podeGerenciarFinanceiro === 'function' && !podeGerenciarFinanceiro(req)) {
      erro(res, 403, 'Acesso restrito a administradores e gerentes');
      return false;
    }
    return true;
  }

  router.get('/financeiro/lucratividade/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
      const empresa = req.params.empresa;

      const empresaResolvida = await validarAcessoEmpresa(req, empresa, req.empresa_id);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [];

      let where = `
      WHERE 1=1
      ${adicionarFiltroEmpresaSaaS({
        alias: 'vi',
        params,
        empresaResolvida
      })}
    `;

      where += adicionarFiltroPeriodo({
        campo: 'v.data',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      const result = await pool.query(
        `
      SELECT
        vi.produto_id,
        vi.produto_nome,

        COALESCE(SUM(vi.quantidade), 0) AS quantidade_vendida,

        COALESCE(SUM(vi.total), 0) AS faturamento_total,

        COALESCE(MAX(p.custo_medio), 0) AS custo_medio,

        COALESCE(MAX(p.lucro_unitario), 0) AS lucro_unitario,

        COALESCE(MAX(p.margem_lucro), 0) AS margem_lucro,

        COALESCE(SUM(
          vi.quantidade * COALESCE(vi.custo_unitario, p.custo_medio, 0)
        ), 0) AS custo_total,

        COALESCE(SUM(
          vi.total - vi.quantidade * COALESCE(vi.custo_unitario, p.custo_medio, 0)
        ), 0) AS lucro_total,

        COALESCE(MAX(p.estoque), 0) AS estoque_atual,

        COALESCE(MAX(
          p.estoque * p.custo_medio
        ), 0) AS estoque_investido,

        COALESCE(MAX(
  p.estoque * p.lucro_unitario
), 0) AS lucro_potencial,

COALESCE(MAX(p.estoque), 0) AS estoque_parado,

-- capital_parado: inclui apenas produtos com vendas no período (limitação conhecida)
COALESCE(MAX(
  p.estoque * p.custo_medio
), 0) AS capital_parado,

MAX(v.data) AS ultima_venda

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

      LEFT JOIN produtos p
        ON p.id = vi.produto_id
        AND (
          p.empresa_id = vi.empresa_id
          OR (
            p.empresa_id IS NULL
            AND p.empresa = vi.empresa
          )
        )
        AND p.deletado_em IS NULL

      ${where}

      GROUP BY
        vi.produto_id,
        vi.produto_nome

      ORDER BY lucro_total DESC, faturamento_total DESC
      LIMIT 5000
      `,
        params
      );

      const linhas = result.rows.map((row) => ({
        produto_id: row.produto_id,
        produto_nome: row.produto_nome,

        quantidade_vendida: Number(row.quantidade_vendida || 0),

        faturamento_total: Number(row.faturamento_total || 0),

        custo_medio: Number(row.custo_medio || 0),

        lucro_unitario: Number(row.lucro_unitario || 0),

        margem_lucro: Number(row.margem_lucro || 0),

        custo_total: Number(row.custo_total || 0),

        lucro_total: Number(row.lucro_total || 0),

        estoque_atual: Number(row.estoque_atual || 0),

        estoque_investido: Number(row.estoque_investido || 0),

        lucro_potencial: Number(row.lucro_potencial || 0),

        estoque_parado: Number(row.estoque_parado || 0),

        capital_parado: Number(row.capital_parado || 0),

        ultima_venda: row.ultima_venda || null
      }));

      const totalLucroPositivo = linhas.reduce((acc, item) => acc + Math.max(0, Number(item.lucro_total || 0)), 0);

      let acumulado = 0;

      const linhasComAbc = linhas.map((item) => {
        const participacao =
          totalLucroPositivo > 0 ? (Math.max(0, Number(item.lucro_total || 0)) / totalLucroPositivo) * 100 : 0;

        acumulado += participacao;

        let classeAbc = 'C';

        if (acumulado <= 80) {
          classeAbc = 'A';
        } else if (acumulado <= 95) {
          classeAbc = 'B';
        }

        return {
          ...item,
          participacao_lucro: Number(participacao.toFixed(2)),
          participacao_acumulada: Number(acumulado.toFixed(2)),
          classe_abc: classeAbc
        };
      });

      return res.json({ sucesso: true, dados: linhasComAbc });
    } catch (error) {
      console.error('Erro real ao gerar relatório de lucratividade:', error);

      return erro(res, 500, 'Erro ao gerar relatório de lucratividade');
    }
  });

  // ── INADIMPLÊNCIA ─────────────────────────────────────────────────────────
  router.get('/inadimplencia/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      // Atualiza status antes de consultar
      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cr:', e.message); }

      const params = [];
      let whereBase = `
        WHERE 1=1
        ${adicionarFiltroEmpresaSaaS({ params, empresaResolvida })}
        AND data_vencimento IS NOT NULL
        AND LOWER(COALESCE(status, 'pendente')) NOT IN ('pago')
        AND data_vencimento::date < (NOW() AT TIME ZONE 'America/Fortaleza')::date
      `;

      const INADIMPLENCIA_LIMIT = 500;

      // ── Contagem total (para saber se há mais que o limite) ──────────────
      const countParams = [...params];
      const countResult = await pool.query(`
        SELECT COUNT(DISTINCT COALESCE(cliente_id::text, 'sem_cadastro')) AS total
        FROM contas_receber
        ${whereBase}
      `, countParams);
      const totalClientesInadimplentes = Number(countResult.rows[0]?.total || 0);

      // ── Por cliente ──────────────────────────────────────────────────────
      const limitIdx = params.length + 1;
      const clientesResult = await pool.query(`
        SELECT
          COALESCE(cliente_id::text, 'sem_cadastro') AS cliente_key,
          COALESCE(cliente_nome, 'Consumidor Final')  AS cliente_nome,
          COUNT(*)                                    AS total_titulos,
          COALESCE(SUM(valor), 0)                     AS valor_total,
          MAX((NOW() AT TIME ZONE 'America/Fortaleza')::date - data_vencimento::date)   AS max_dias_atraso,
          COALESCE(SUM(CASE WHEN (NOW() AT TIME ZONE 'America/Fortaleza')::date - data_vencimento::date BETWEEN 1  AND 30  THEN valor ELSE 0 END), 0) AS faixa_1_30,
          COALESCE(SUM(CASE WHEN (NOW() AT TIME ZONE 'America/Fortaleza')::date - data_vencimento::date BETWEEN 31 AND 60  THEN valor ELSE 0 END), 0) AS faixa_31_60,
          COALESCE(SUM(CASE WHEN (NOW() AT TIME ZONE 'America/Fortaleza')::date - data_vencimento::date BETWEEN 61 AND 90  THEN valor ELSE 0 END), 0) AS faixa_61_90,
          COALESCE(SUM(CASE WHEN (NOW() AT TIME ZONE 'America/Fortaleza')::date - data_vencimento::date > 90              THEN valor ELSE 0 END), 0) AS faixa_90plus
        FROM contas_receber
        ${whereBase}
        GROUP BY cliente_key, cliente_nome
        ORDER BY valor_total DESC
        LIMIT $${limitIdx}
      `, [...params, INADIMPLENCIA_LIMIT]);

      const clientes = clientesResult.rows.map((r) => ({
        cliente_key:       r.cliente_key,
        cliente_nome:      r.cliente_nome,
        total_titulos:     Number(r.total_titulos   || 0),
        valor_total:       Number(r.valor_total      || 0),
        max_dias_atraso:   Number(r.max_dias_atraso  || 0),
        faixa_1_30:        Number(r.faixa_1_30       || 0),
        faixa_31_60:       Number(r.faixa_31_60      || 0),
        faixa_61_90:       Number(r.faixa_61_90      || 0),
        faixa_90plus:      Number(r.faixa_90plus     || 0)
      }));

      // ── Totais ──────────────────────────────────────────────────────────
      const totValor    = clientes.reduce((s, c) => s + c.valor_total,  0);
      const totTitulos  = clientes.reduce((s, c) => s + c.total_titulos, 0);
      const aging = {
        faixa_1_30:  clientes.reduce((s, c) => s + c.faixa_1_30,  0),
        faixa_31_60: clientes.reduce((s, c) => s + c.faixa_31_60, 0),
        faixa_61_90: clientes.reduce((s, c) => s + c.faixa_61_90, 0),
        faixa_90plus: clientes.reduce((s, c) => s + c.faixa_90plus, 0)
      };

      return res.json({
        sucesso: true,
        total_clientes:            clientes.length,
        total_clientes_base:       totalClientesInadimplentes,
        truncado:                  totalClientesInadimplentes > INADIMPLENCIA_LIMIT,
        total_titulos:             totTitulos,
        total_valor:               +totValor.toFixed(2),
        aging,
        clientes
      });
    } catch (error) {
      console.error('Erro real ao gerar relatório de inadimplência:', error);
      return erro(res, 500, 'Erro ao gerar relatório de inadimplência');
    }
  });

  // ── DRE — DEMONSTRATIVO DE RESULTADO DO EXERCÍCIO ────────────────────────
  router.get('/dre/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const eId   = empresaResolvida.id;
      const eNome = empresaResolvida.nome;

      // ── 1. Vendas + CMV por mês ──────────────────────────────────────────
      const vendaParams = [eId, eNome];
      let vendaWhere = `WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))`;
      vendaWhere += adicionarFiltroPeriodo({ campo: 'v.data', params: vendaParams, dataInicial, dataFinal, castDate: false });

      const vendasResult = await pool.query(`
        SELECT
          TO_CHAR(v.data::date, 'YYYY-MM')        AS periodo,
          COALESCE(SUM(v.total), 0)               AS receita,
          COALESCE(SUM(vi_cmv.cmv), 0)            AS cmv
        FROM vendas v
        LEFT JOIN (
          SELECT vi2.venda_id,
                 SUM(vi2.quantidade * COALESCE(vi2.custo_unitario, p2.custo_medio, 0)) AS cmv
          FROM venda_itens vi2
          LEFT JOIN produtos p2 ON p2.id = vi2.produto_id
            AND (p2.empresa_id = $1 OR (p2.empresa_id IS NULL AND p2.empresa = $2))
            AND p2.deletado_em IS NULL
          WHERE vi2.empresa_id = $1 OR (vi2.empresa_id IS NULL AND vi2.empresa = $2)
          GROUP BY vi2.venda_id
        ) vi_cmv ON vi_cmv.venda_id = v.id
        ${vendaWhere}
        GROUP BY TO_CHAR(v.data::date, 'YYYY-MM')
        ORDER BY 1
      `, vendaParams);

      // ── 2. Despesas de lançamentos por mês ───────────────────────────────
      const lancParams = [eId, eNome];
      let lancWhere = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND LOWER(tipo) = 'despesa' AND LOWER(COALESCE(status, 'pendente')) = 'pago'`;
      lancWhere += adicionarFiltroPeriodo({
        campo: `COALESCE(pagamento_data, vencimento)`,
        params: lancParams, dataInicial, dataFinal, castDate: false
      });

      const lancResult = await pool.query(`
        SELECT
          TO_CHAR(COALESCE(pagamento_data, vencimento)::date, 'YYYY-MM') AS periodo,
          COALESCE(SUM(valor), 0) AS despesas
        FROM lancamentos_financeiros
        ${lancWhere}
        GROUP BY 1
        ORDER BY 1
      `, lancParams);

      // ── 3. Contas a pagar pagas por mês ──────────────────────────────────
      const cpParams = [eId, eNome];
      let cpWhere = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
                      AND LOWER(COALESCE(status,'pendente')) = 'pago' AND data_pagamento IS NOT NULL
                      AND compra_id IS NULL`;
      cpWhere += adicionarFiltroPeriodo({ campo: 'data_pagamento', params: cpParams, dataInicial, dataFinal, castDate: false });

      const cpResult = await pool.query(`
        SELECT
          TO_CHAR(data_pagamento::date, 'YYYY-MM') AS periodo,
          COALESCE(SUM(valor), 0) AS despesas
        FROM contas_pagar
        ${cpWhere}
        GROUP BY 1
        ORDER BY 1
      `, cpParams);

      // ── 4. Receitas de lançamentos financeiros por mês ───────────────────
      const lancReceitaParams = [eId, eNome];
      let lancReceitaWhere = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND LOWER(tipo) = 'receita' AND LOWER(COALESCE(status, 'pendente')) = 'pago'`;
      lancReceitaWhere += adicionarFiltroPeriodo({
        campo: `COALESCE(pagamento_data, vencimento)`,
        params: lancReceitaParams, dataInicial, dataFinal, castDate: false
      });
      const lancReceitaResult = await pool.query(`
        SELECT
          TO_CHAR(COALESCE(pagamento_data, vencimento)::date, 'YYYY-MM') AS periodo,
          COALESCE(SUM(valor), 0) AS receitas
        FROM lancamentos_financeiros
        ${lancReceitaWhere}
        GROUP BY 1
        ORDER BY 1
      `, lancReceitaParams);

      // ── Merge mensal ─────────────────────────────────────────────────────
      const periodos = new Set([
        ...vendasResult.rows.map(r => r.periodo),
        ...lancResult.rows.map(r => r.periodo),
        ...cpResult.rows.map(r => r.periodo),
        ...lancReceitaResult.rows.map(r => r.periodo)
      ]);

      const lancMap        = Object.fromEntries(lancResult.rows.map(r => [r.periodo, Number(r.despesas)]));
      const cpMap          = Object.fromEntries(cpResult.rows.map(r => [r.periodo, Number(r.despesas)]));
      const lancReceitaMap = Object.fromEntries(lancReceitaResult.rows.map(r => [r.periodo, Number(r.receitas)]));

      const mensal = Array.from(periodos).sort().map(p => {
        const vRow = vendasResult.rows.find(r => r.periodo === p) || { receita: 0, cmv: 0 };
        const receita   = Number(vRow.receita || 0) + Number(lancReceitaMap[p] || 0);
        const cmv       = Number(vRow.cmv     || 0);
        const despesas  = Number(lancMap[p] || 0) + Number(cpMap[p] || 0);
        const lucro_bruto     = receita - cmv;
        const resultado       = lucro_bruto - despesas;
        const margem_bruta    = receita > 0 ? +((lucro_bruto / receita) * 100).toFixed(2) : 0;
        const margem_oper     = receita > 0 ? +((resultado   / receita) * 100).toFixed(2) : 0;
        const [ano, mes]      = p.split('-');
        const nomesMes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        const label = `${nomesMes[Number(mes) - 1]}/${ano}`;
        return { periodo: p, label, receita, cmv, lucro_bruto, despesas, resultado, margem_bruta, margem_oper };
      });

      // ── Totais do período ────────────────────────────────────────────────
      const totReceita  = mensal.reduce((s, m) => s + m.receita,    0);
      const totCmv      = mensal.reduce((s, m) => s + m.cmv,        0);
      const totDespesas = mensal.reduce((s, m) => s + m.despesas,    0);
      const totLucro    = totReceita - totCmv;
      const totResult   = totLucro - totDespesas;

      return res.json({
        sucesso: true,
        periodo_inicio: dataInicial,
        periodo_fim:    dataFinal,
        receita_bruta:          +totReceita.toFixed(2),
        cmv:                    +totCmv.toFixed(2),
        lucro_bruto:            +totLucro.toFixed(2),
        margem_bruta:           totReceita > 0 ? +((totLucro  / totReceita) * 100).toFixed(2) : 0,
        despesas_operacionais:  +totDespesas.toFixed(2),
        resultado_operacional:  +totResult.toFixed(2),
        margem_operacional:     totReceita > 0 ? +((totResult / totReceita) * 100).toFixed(2) : 0,
        mensal
      });
    } catch (error) {
      console.error('Erro real ao gerar DRE:', error);
      return erro(res, 500, 'Erro ao gerar DRE');
    }
  });

  // ── VENDAS POR VARIAÇÃO DE GRADE ─────────────────────────────────────────
  router.get('/vendas/por-grade/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa, req.empresa_id);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [];

      let where = `
        WHERE vi.grade_id IS NOT NULL
        ${adicionarFiltroEmpresaSaaS({ alias: 'vi', params, empresaResolvida })}
      `;

      where += adicionarFiltroPeriodo({
        campo: 'v.data',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      const result = await pool.query(
        `
        SELECT
          vi.produto_id,
          vi.produto_nome,
          vi.grade_id,
          pg.atributo1,
          pg.atributo2,
          COALESCE(SUM(vi.quantidade), 0)                                             AS quantidade_vendida,
          COALESCE(SUM(vi.total), 0)                                                  AS faturamento_total,
          COALESCE(MAX(pg.preco), MAX(p.preco), 0)                                    AS preco_atual,
          COALESCE(MAX(pg.custo), MAX(p.custo_medio), 0)                              AS custo_atual,
          COALESCE(SUM(vi.quantidade * COALESCE(vi.custo_unitario, pg.custo, p.custo_medio, 0)), 0)      AS custo_total,
          COALESCE(SUM(vi.total), 0)
            - COALESCE(SUM(vi.quantidade * COALESCE(vi.custo_unitario, pg.custo, p.custo_medio, 0)), 0) AS lucro_total,
          COALESCE(MAX(pg.estoque), 0)                                                AS estoque_atual,
          MAX(v.data)                                                                 AS ultima_venda
        FROM venda_itens vi
        JOIN vendas v
          ON v.id = vi.venda_id
          AND (v.empresa_id = vi.empresa_id OR (vi.empresa_id IS NULL AND v.empresa = vi.empresa))
        LEFT JOIN produtos p
          ON p.id = vi.produto_id
          AND (p.empresa_id = $1 OR (p.empresa_id IS NULL AND p.empresa = $2))
        LEFT JOIN produto_grades pg
          ON pg.id = vi.grade_id
          AND (pg.empresa_id = $1 OR (pg.empresa_id IS NULL AND pg.empresa = $2))
        ${where}
        GROUP BY vi.produto_id, vi.produto_nome, vi.grade_id, pg.atributo1, pg.atributo2
        ORDER BY faturamento_total DESC, vi.produto_nome ASC
        LIMIT 5000
        `,
        params
      );

      return res.json({ sucesso: true, dados: result.rows.map((row) => ({
        produto_id: row.produto_id,
        produto_nome: row.produto_nome,
        grade_id: row.grade_id,
        atributo1: row.atributo1 || '',
        atributo2: row.atributo2 || '',
        variacao: row.atributo2
          ? `${row.atributo1} / ${row.atributo2}`
          : row.atributo1 || `Grade #${row.grade_id}`,
        quantidade_vendida: Number(row.quantidade_vendida || 0),
        faturamento_total: Number(row.faturamento_total || 0),
        preco_atual: Number(row.preco_atual || 0),
        custo_atual: Number(row.custo_atual || 0),
        custo_total: Number(row.custo_total || 0),
        lucro_total: Number(row.lucro_total || 0),
        estoque_atual: Number(row.estoque_atual || 0),
        ultima_venda: row.ultima_venda || null
      })) });
    } catch (error) {
      console.error('Erro real ao gerar relatório por grade:', error);
      return erro(res, 500, 'Erro ao gerar relatório por variação');
    }
  });

  return router;
};