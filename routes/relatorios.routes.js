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

  router.get('/financeiro/resumo/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;

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

  router.get('/financeiro/fluxo-caixa/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
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

  router.get('/financeiro/contas-receber/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
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
      if (!checkFinanceiro(req, res)) return;
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