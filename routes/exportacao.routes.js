/**
 * Exportação Contábil — LF ERP
 * Gera arquivos CSV e EFD (SPED) para entrega ao contador.
 *
 * Rotas (todas requerem autenticação JWT):
 *   GET /exportacao/vendas          — Resumo de vendas (CSV)
 *   GET /exportacao/compras         — Resumo de compras (CSV)
 *   GET /exportacao/contas-receber  — Títulos a receber (CSV)
 *   GET /exportacao/contas-pagar    — Títulos a pagar (CSV)
 *   GET /exportacao/lancamentos     — Lançamentos financeiros (CSV)
 *   GET /exportacao/dre             — DRE simplificada (CSV)
 *   GET /exportacao/efd             — Arquivo EFD/SPED rascunho (TXT)
 *
 * Parâmetros comuns: ?inicio=YYYY-MM-DD&fim=YYYY-MM-DD
 */

const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');

module.exports = function ({ auth, pool, validarAcessoEmpresa, normalizarDecimal, hoje }) {
  const router = require('express').Router();
  const { requirePermissao } = require('../utils/permissoes');

  // ── Helpers ───────────────────────────────────────────────────────────────

  function csvVal(v) {
    if (v == null) return '';
    let s = String(v).replace(/"/g, '""');
    // Previne CSV injection: fórmulas Excel/Calc começam com =, +, -, @, tab, CR
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[;"\n]/.test(s) ? `"${s}"` : s;
  }

  function csvRow(cols) {
    return cols.map(csvVal).join(';');
  }

  function brlNum(v) {
    return Number(v || 0).toFixed(2).replace('.', ',');
  }

  function dataBR(d) {
    if (!d) return '';
    const s = String(d).substring(0, 10);
    const [y, m, dia] = s.split('-');
    return `${dia}/${m}/${y}`;
  }

  function sendCSV(res, filename, rows) {
    const bom = '﻿';
    const body = bom + rows.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }

  function sendTXT(res, filename, content) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }

  async function resolveEmpresa(req) {
    return validarAcessoEmpresa(req, null, req.empresa_id);
  }

  // ── GET /exportacao/vendas ────────────────────────────────────────────────

  router.get('/vendas', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [emp.id, emp.nome];
      let where = `WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))`;
      where += adicionarFiltroPeriodo({ campo: 'v.data', params, dataInicial, dataFinal, castDate: false });

      const result = await pool.query(
        `SELECT v.id, v.data, v.cliente_nome, v.subtotal, v.desconto, v.acrescimo, v.total,
                v.pagamento, v.status_pagamento, v.parcelas, v.observacao,
                COUNT(vi.id) AS qtd_itens
         FROM vendas v
         LEFT JOIN venda_itens vi ON vi.venda_id = v.id
         ${where}
         GROUP BY v.id
         ORDER BY v.data, v.id`,
        params
      );

      const header = csvRow(['ID','Data','Cliente','Subtotal','Desconto','Acréscimo','Total','Forma Pagamento','Status','Parcelas','Qtd Itens','Observação']);
      const linhas = result.rows.map((r) => csvRow([
        r.id, dataBR(r.data), r.cliente_nome,
        brlNum(r.subtotal), brlNum(r.desconto), brlNum(r.acrescimo), brlNum(r.total),
        r.pagamento, r.status_pagamento, r.parcelas, r.qtd_itens, r.observacao
      ]));

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `vendas_${ini}.csv`, [header, ...linhas]);
    } catch (err) {
      console.error('[exportacao] vendas:', err.message);
      res.status(500).json({ sucesso: false, erro: "Erro interno" });
    }
  });

  // ── GET /exportacao/compras ───────────────────────────────────────────────

  router.get('/compras', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [emp.id, emp.nome];
      let where = `WHERE (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))`;
      where += adicionarFiltroPeriodo({ campo: 'c.data', params, dataInicial, dataFinal, castDate: false });

      const result = await pool.query(
        `SELECT c.id, c.data, f.nome AS fornecedor_nome, c.total,
                c.status, c.observacao,
                COUNT(ci.id) AS qtd_itens
         FROM compras c
         LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
         LEFT JOIN compra_itens ci ON ci.compra_id = c.id
         ${where}
         GROUP BY c.id, f.nome
         ORDER BY c.data, c.id`,
        params
      );

      const header = csvRow(['ID','Data','Fornecedor','Total','Status','Qtd Itens','Observação']);
      const linhas = result.rows.map((r) => csvRow([
        r.id, dataBR(r.data), r.fornecedor_nome,
        brlNum(r.total),
        r.status, r.qtd_itens, r.observacao
      ]));

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `compras_${ini}.csv`, [header, ...linhas]);
    } catch (err) {
      console.error('[exportacao] compras:', err.message);
      res.status(500).json({ sucesso: false, erro: "Erro interno" });
    }
  });

  // ── GET /exportacao/contas-receber ────────────────────────────────────────

  router.get('/contas-receber', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [emp.id, emp.nome];
      let where = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;
      where += adicionarFiltroPeriodo({ campo: 'data_vencimento', params, dataInicial, dataFinal, castDate: false });

      const result = await pool.query(
        `SELECT id, data_vencimento, data_pagamento, cliente_nome,
                parcela, total_parcelas, valor,
                CASE WHEN data_pagamento IS NOT NULL THEN valor ELSE 0 END AS valor_pago,
                status, forma_pagamento, observacao
         FROM contas_receber
         ${where}
         ORDER BY data_vencimento, id`,
        params
      );

      const header = csvRow(['ID','Vencimento','Pagamento','Cliente','Parcela','Total Parcelas','Valor','Valor Pago','Status','Forma Pagamento','Observação']);
      const linhas = result.rows.map((r) => csvRow([
        r.id, dataBR(r.data_vencimento), dataBR(r.data_pagamento),
        r.cliente_nome, r.parcela, r.total_parcelas,
        brlNum(r.valor), brlNum(r.valor_pago), r.status, r.forma_pagamento, r.observacao
      ]));

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `contas_receber_${ini}.csv`, [header, ...linhas]);
    } catch (err) {
      console.error('[exportacao] contas-receber:', err.message);
      res.status(500).json({ sucesso: false, erro: "Erro interno" });
    }
  });

  // ── GET /exportacao/contas-pagar ──────────────────────────────────────────

  router.get('/contas-pagar', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [emp.id, emp.nome];
      let where = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;
      where += adicionarFiltroPeriodo({ campo: 'data_vencimento', params, dataInicial, dataFinal, castDate: false });

      const result = await pool.query(
        `SELECT id, data_vencimento, data_pagamento, fornecedor_nome, descricao,
                parcela, total_parcelas, valor,
                CASE WHEN data_pagamento IS NOT NULL THEN valor ELSE 0 END AS valor_pago,
                status, forma_pagamento, categoria, observacao
         FROM contas_pagar
         ${where}
         ORDER BY data_vencimento, id`,
        params
      );

      const header = csvRow(['ID','Vencimento','Pagamento','Fornecedor','Descrição','Parcela','Total Parcelas','Valor','Valor Pago','Status','Forma Pagamento','Categoria','Observação']);
      const linhas = result.rows.map((r) => csvRow([
        r.id, dataBR(r.data_vencimento), dataBR(r.data_pagamento),
        r.fornecedor_nome, r.descricao, r.parcela, r.total_parcelas,
        brlNum(r.valor), brlNum(r.valor_pago), r.status, r.forma_pagamento, r.categoria, r.observacao
      ]));

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `contas_pagar_${ini}.csv`, [header, ...linhas]);
    } catch (err) {
      console.error('[exportacao] contas-pagar:', err.message);
      res.status(500).json({ sucesso: false, erro: "Erro interno" });
    }
  });

  // ── GET /exportacao/lancamentos ───────────────────────────────────────────

  router.get('/lancamentos', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [emp.id, emp.nome];
      let where = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;
      where += adicionarFiltroPeriodo({
        campo: `COALESCE(pagamento_data, vencimento)`,
        params, dataInicial, dataFinal, castDate: false
      });

      const result = await pool.query(
        `SELECT id, tipo, categoria, descricao, valor, vencimento, pagamento_data,
                status, forma_pagamento, observacao
         FROM lancamentos_financeiros
         ${where}
         ORDER BY COALESCE(pagamento_data, vencimento), id`,
        params
      );

      const header = csvRow(['ID','Tipo','Categoria','Descrição','Valor','Vencimento','Data Pagamento','Status','Forma Pagamento','Observação']);
      const linhas = result.rows.map((r) => csvRow([
        r.id, r.tipo, r.categoria, r.descricao,
        brlNum(r.valor), dataBR(r.vencimento), dataBR(r.pagamento_data),
        r.status, r.forma_pagamento, r.observacao
      ]));

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `lancamentos_${ini}.csv`, [header, ...linhas]);
    } catch (err) {
      console.error('[exportacao] lancamentos:', err.message);
      res.status(500).json({ sucesso: false, erro: "Erro interno" });
    }
  });

  // ── GET /exportacao/dre ───────────────────────────────────────────────────

  router.get('/dre', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const eId = emp.id; const eNome = emp.nome;

      // Monta params/where para cada grupo de queries
      const vparam  = [eId, eNome]; let vwhere  = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;
      const cmvparam= [eId, eNome];
      const dparam  = [eId, eNome]; let dwhere  = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND LOWER(tipo) = 'despesa'`;
      const cpparam = [eId, eNome]; let cpwhere = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND LOWER(COALESCE(status,'pendente')) = 'pago'`;
      const rparam  = [eId, eNome]; let rwhere  = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND LOWER(tipo) = 'receita'`;
      vwhere  += adicionarFiltroPeriodo({ campo: 'data',                              params: vparam,   dataInicial, dataFinal, castDate: false });
      dwhere  += adicionarFiltroPeriodo({ campo: `COALESCE(pagamento_data,vencimento)`,params: dparam,   dataInicial, dataFinal, castDate: false });
      cpwhere += adicionarFiltroPeriodo({ campo: 'data_pagamento',                    params: cpparam,  dataInicial, dataFinal, castDate: false });
      rwhere  += adicionarFiltroPeriodo({ campo: `COALESCE(pagamento_data,vencimento)`,params: rparam,   dataInicial, dataFinal, castDate: false });

      // 5 queries em paralelo — reduz latência de 5 round-trips para 1
      const [vr, cmvr, dr, cpr, rr] = await Promise.all([
        pool.query(`SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(desconto),0) AS desconto FROM vendas ${vwhere}`, vparam),
        pool.query(
          `SELECT COALESCE(SUM(vi.quantidade * COALESCE(vi.custo_unitario,0)),0) AS cmv
           FROM venda_itens vi JOIN vendas v ON v.id = vi.venda_id
           WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))
           ${adicionarFiltroPeriodo({ campo: 'v.data', params: cmvparam, dataInicial, dataFinal, castDate: false })}`,
          cmvparam
        ),
        pool.query(`SELECT COALESCE(SUM(valor),0) AS total FROM lancamentos_financeiros ${dwhere}`, dparam),
        pool.query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar ${cpwhere}`, cpparam),
        pool.query(`SELECT COALESCE(SUM(valor),0) AS total FROM lancamentos_financeiros ${rwhere}`, rparam)
      ]);

      // valores vêm de SUM()/COALESCE do Postgres (string decimal) — nunca normalizarDecimal()
      // aqui, que trata "." como separador de milhar BR e corromperia o valor (ver auditoria FIN-01)
      const receitaBruta   = Number(vr.rows[0].total);
      const descontoVendas = Number(vr.rows[0].desconto);
      const receitaLiquida = receitaBruta - descontoVendas;
      const cmv            = Number(cmvr.rows[0].cmv);
      const lucroBruto     = receitaLiquida - cmv;
      const despesasLanc   = Number(dr.rows[0].total);
      const despesasCP     = Number(cpr.rows[0].total);
      const totalDespesas  = despesasLanc + despesasCP;
      const receitaExtra   = Number(rr.rows[0].total);
      const resultadoOp    = lucroBruto - totalDespesas + receitaExtra;

      const periodo = `${dataBR(dataInicial || hoje())} a ${dataBR(dataFinal || hoje())}`;

      const linhas = [
        csvRow(['DRE Simplificada', emp.nome]),
        csvRow(['Período', periodo]),
        csvRow(['', '']),
        csvRow(['DESCRIÇÃO', 'VALOR (R$)']),
        csvRow(['(+) Receita Bruta de Vendas', brlNum(receitaBruta)]),
        csvRow(['(-) Descontos Concedidos', brlNum(descontoVendas)]),
        csvRow(['(=) Receita Líquida', brlNum(receitaLiquida)]),
        csvRow(['(-) CMV (Custo das Mercadorias Vendidas)', brlNum(cmv)]),
        csvRow(['(=) Lucro Bruto', brlNum(lucroBruto)]),
        csvRow(['(-) Despesas Operacionais (lançamentos)', brlNum(despesasLanc)]),
        csvRow(['(-) Contas a Pagar Liquidadas', brlNum(despesasCP)]),
        csvRow(['(+) Receitas Extras / Financeiras', brlNum(receitaExtra)]),
        csvRow(['(=) RESULTADO OPERACIONAL', brlNum(resultadoOp)])
      ];

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `dre_${ini}.csv`, linhas);
    } catch (err) {
      console.error('[exportacao] dre:', err.message);
      res.status(500).json({ sucesso: false, erro: "Erro interno" });
    }
  });

  // ── GET /exportacao/efd ───────────────────────────────────────────────────
  // Gera rascunho de arquivo EFD (SPED) para entrega ao contador.
  // Inclui blocos 0, C (NF-e emitidas), 9.

  router.get('/efd', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const dtIni = (dataInicial || hoje()).substring(0, 10).replace(/-/g, '');
      const dtFin = (dataFinal   || hoje()).substring(0, 10).replace(/-/g, '');

      // Participantes: clientes com vendas no período
      const partParams = [emp.id, emp.nome];
      let partWhere = `WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2)) AND v.cliente_id IS NOT NULL`;
      partWhere += adicionarFiltroPeriodo({ campo: 'v.data', params: partParams, dataInicial, dataFinal, castDate: false });

      const partResult = await pool.query(
        `SELECT DISTINCT c.id, c.nome, c.cpf_cnpj, c.endereco, c.cidade, c.uf
         FROM vendas v
         JOIN clientes c ON c.id = v.cliente_id
         ${partWhere}
         LIMIT 500`,
        partParams
      );

      // NF-e emitidas no período
      const nfeParams = [emp.id];
      let nfeWhere = `WHERE empresa_id = $1 AND status NOT IN ('cancelada','rejeitada')`;
      nfeWhere += adicionarFiltroPeriodo({ campo: 'data_emissao', params: nfeParams, dataInicial, dataFinal, castDate: false });

      const nfeResult = await pool.query(
        `SELECT numero, serie, chave_acesso, data_emissao, valor_total,
                destinatario_nome, destinatario_cpf_cnpj, cfop, natureza_operacao
         FROM nfe
         ${nfeWhere}
         ORDER BY data_emissao, numero`,
        nfeParams
      ).catch(() => ({ rows: [] }));

      // Monta arquivo EFD
      const linhas = [];
      let totalRegs = 0;

      function reg(linha) {
        linhas.push(`|${linha}|`);
        totalRegs++;
      }

      // Bloco 0
      reg(`0000|013|0|${dtIni}|${dtFin}|${emp.nome}|${emp.cnpj || '00000000000000'}|${emp.uf || 'CE'}|0|0|0|0|0|0|S|`);
      reg(`0001|0|`);
      reg(`0100|${emp.nome}|${emp.cnpj || ''}||||||||`);

      // Participantes
      partResult.rows.forEach((p, i) => {
        reg(`0150|${String(i + 1).padStart(4,'0')}|${p.nome}|${p.cpf_cnpj ? '1' : '2'}|${p.cpf_cnpj || ''}||${p.uf || ''}|${p.cidade || ''}|`);
      });

      reg(`0990|${partResult.rows.length + 3}|`);

      // Bloco C — documentos fiscais (NF-e)
      reg(`C001|0|`);
      nfeResult.rows.forEach((nf) => {
        const dtNF = String(nf.data_emissao || '').substring(0, 10).replace(/-/g, '');
        reg(`C100|0|0||55|${nf.serie || '001'}|${nf.numero}|${nf.chave_acesso || ''}|${dtNF}|${nf.destinatario_nome || ''}|${nf.destinatario_cpf_cnpj || ''}|${brlNum(nf.valor_total)}|0|0|0|0|0|0|0|0|0|`);
      });
      reg(`C990|${nfeResult.rows.length + 2}|`);

      // Bloco 9 — encerramento
      reg(`9001|0|`);
      reg(`9900|0000|1|`);
      reg(`9900|0001|1|`);
      reg(`9900|0100|1|`);
      if (partResult.rows.length > 0) reg(`9900|0150|${partResult.rows.length}|`);
      reg(`9900|0990|1|`);
      reg(`9900|C001|1|`);
      if (nfeResult.rows.length > 0) reg(`9900|C100|${nfeResult.rows.length}|`);
      reg(`9900|C990|1|`);
      reg(`9900|9001|1|`);
      reg(`9900|9900|${nfeResult.rows.length > 0 ? 8 : 7}|`);
      reg(`9900|9999|1|`);
      const bloco9total = linhas.filter((l) => l.startsWith('|9')).length + 2;
      reg(`9990|${bloco9total}|`);
      reg(`9999|${totalRegs + 1}|`);

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendTXT(res, `efd_${ini}.txt`, linhas.join('\r\n'));
    } catch (err) {
      console.error('[exportacao] efd:', err.message);
      res.status(500).json({ sucesso: false, erro: "Erro interno" });
    }
  });

  // Rate limiter local para endpoints pesados de leitura (max 20 req/min por IP)
  const rateMap = new Map();
  function readRateLimit(req, res, next) {
    const key = `${req.ip}-${req.user?.id || 'anon'}`;
    const now = Date.now();
    const entry = rateMap.get(key) || { count: 0, start: now };
    if (now - entry.start > 60_000) { entry.count = 0; entry.start = now; }
    entry.count++;
    rateMap.set(key, entry);
    if (entry.count > 20) return res.status(429).json({ sucesso: false, erro: 'Muitas requisições. Aguarde 1 minuto.' });
    next();
  }

  // ── GET /exportacao/painel — KPIs contábeis em tempo real ────────────────

  router.get('/painel', auth, requirePermissao(pool, 'relatorios', 'ver'), readRateLimit, async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const mesInicio = dataInicial || (hoje().substring(0, 7) + '-01');
      const mesFim    = dataFinal   || hoje();
      const eId = emp.id; const eNome = emp.nome;

      const [vendas, compras, crPendente, cpPendente, despesas, receitasExtra] = await Promise.all([
        pool.query(
          `SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS qtd
           FROM vendas
           WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2))
             AND data BETWEEN $3 AND $4`,
          [eId, eNome, mesInicio, mesFim]
        ),
        pool.query(
          `SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS qtd
           FROM compras
           WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2))
             AND data BETWEEN $3 AND $4`,
          [eId, eNome, mesInicio, mesFim]
        ),
        pool.query(
          `SELECT COALESCE(SUM(valor),0) AS total
           FROM contas_receber
           WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2))
             AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago')`,
          [eId, eNome]
        ),
        pool.query(
          `SELECT COALESCE(SUM(valor),0) AS total
           FROM contas_pagar
           WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2))
             AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago')`,
          [eId, eNome]
        ),
        pool.query(
          `SELECT COALESCE(SUM(valor),0) AS total
           FROM lancamentos_financeiros
           WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2))
             AND LOWER(tipo)='despesa'
             AND COALESCE(pagamento_data,vencimento) BETWEEN $3 AND $4`,
          [eId, eNome, mesInicio, mesFim]
        ),
        pool.query(
          `SELECT COALESCE(SUM(valor),0) AS total
           FROM lancamentos_financeiros
           WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2))
             AND LOWER(tipo)='receita'
             AND COALESCE(pagamento_data,vencimento) BETWEEN $3 AND $4`,
          [eId, eNome, mesInicio, mesFim]
        )
      ]);

      // valores vêm de SUM()/COALESCE do Postgres (string decimal) — nunca normalizarDecimal()
      // aqui, que trata "." como separador de milhar BR e corromperia o valor (ver auditoria FIN-01)
      const totalVendas    = Number(vendas.rows[0].total);
      const totalCompras   = Number(compras.rows[0].total);
      const totalDespesas  = Number(despesas.rows[0].total);
      const totalReceitas  = Number(receitasExtra.rows[0].total);
      const resultado      = totalVendas + totalReceitas - totalCompras - totalDespesas;

      return res.json({
        sucesso: true,
        painel: {
          periodo:      { inicio: mesInicio, fim: mesFim },
          vendas:       { total: totalVendas,   qtd: Number(vendas.rows[0].qtd) },
          compras:      { total: totalCompras,  qtd: Number(compras.rows[0].qtd) },
          cr_pendente:  Number(crPendente.rows[0].total),
          cp_pendente:  Number(cpPendente.rows[0].total),
          despesas:     totalDespesas,
          receitas_extra: totalReceitas,
          resultado,
          atualizado_em: new Date().toLocaleString('sv-SE', { timeZone: 'America/Fortaleza' }).replace(' ', 'T')
        }
      });
    } catch (err) {
      console.error('[exportacao] painel:', err.message);
      return res.status(500).json({ sucesso: false, erro: "Erro interno" });
    }
  });

  // ── GET /exportacao/integracao — ler configuração ─────────────────────────

  router.get('/integracao', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const r = await pool.query(
        `SELECT email_contador, webhook_url,
                CASE WHEN webhook_secret IS NOT NULL AND webhook_secret <> '' THEN '***' ELSE '' END AS webhook_secret,
                eventos_ativos, ativo
         FROM contabilidade_config WHERE empresa_id = $1`,
        [emp.id]
      );

      return res.json({
        sucesso: true,
        config: r.rows[0] || {
          email_contador: '', webhook_url: '', webhook_secret: '',
          eventos_ativos: ['venda.criada', 'recebimento.registrado', 'pagamento.registrado'],
          ativo: true
        }
      });
    } catch (err) {
      console.error('[exportacao] integracao GET:', err.message);
      return res.status(500).json({ sucesso: false, erro: "Erro interno" });
    }
  });

  // ── PUT /exportacao/integracao — salvar configuração ─────────────────────

  router.put('/integracao', auth, requirePermissao(pool, 'configuracoes', 'editar'), async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { email_contador, webhook_url, webhook_secret, eventos_ativos, ativo } = req.body;
      const eventosValidos = ['venda.criada', 'recebimento.registrado', 'pagamento.registrado'];
      const eventosFiltrados = Array.isArray(eventos_ativos)
        ? eventos_ativos.filter((e) => eventosValidos.includes(e))
        : eventosValidos;

      await pool.query(
        `INSERT INTO contabilidade_config
           (empresa_id, email_contador, webhook_url, webhook_secret, eventos_ativos, ativo)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (empresa_id) DO UPDATE SET
           email_contador  = EXCLUDED.email_contador,
           webhook_url     = EXCLUDED.webhook_url,
           webhook_secret  = COALESCE(NULLIF($4,'***'), contabilidade_config.webhook_secret),
           eventos_ativos  = EXCLUDED.eventos_ativos,
           ativo           = EXCLUDED.ativo,
           atualizado_em   = NOW()`,
        [
          emp.id,
          email_contador || null,
          webhook_url    || null,
          webhook_secret || null,
          eventosFiltrados,
          ativo !== false
        ]
      );

      return res.json({ sucesso: true, mensagem: 'Configuração salva com sucesso.' });
    } catch (err) {
      console.error('[exportacao] integracao PUT:', err.message);
      return res.status(500).json({ sucesso: false, erro: "Erro interno" });
    }
  });

  // ── POST /exportacao/integracao/testar — dispara ping de teste ───────────

  router.post('/integracao/testar', auth, requirePermissao(pool, 'configuracoes', 'editar'), async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const r = await pool.query(
        `SELECT webhook_url, webhook_secret FROM contabilidade_config WHERE empresa_id = $1`,
        [emp.id]
      );

      if (!r.rowCount || !r.rows[0]?.webhook_url) {
        return res.status(400).json({ sucesso: false, erro: 'Nenhuma URL de webhook configurada.' });
      }

      const { webhook_url, webhook_secret } = r.rows[0];
      const payload = JSON.stringify({
        evento: 'teste',
        timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'America/Fortaleza' }).replace(' ', 'T'),
        empresa_id: emp.id,
        dados: { mensagem: 'Teste de integração do LF ERP — webhook funcionando!' }
      });

      const headers = { 'Content-Type': 'application/json' };
      if (webhook_secret) headers['X-LF-Secret'] = webhook_secret;

      try {
        const _u = new URL(webhook_url);
        if (!['http:', 'https:'].includes(_u.protocol)) throw new Error('Protocolo inválido');
        if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i.test(_u.hostname)) throw new Error('URL aponta para rede interna');
      } catch (validErr) {
        return res.json({ sucesso: false, erro: validErr.message || 'URL de webhook inválida' });
      }

      const resp = await fetch(webhook_url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(10000)
      });

      return res.json({
        sucesso: true,
        status_http: resp.status,
        mensagem: resp.ok
          ? `Webhook recebido! Servidor respondeu ${resp.status}.`
          : `Servidor respondeu com status ${resp.status} — verifique a URL.`
      });
    } catch (err) {
      console.error('[exportacao] integracao testar:', err.message);
      const erroMsg = err.name === 'AbortError'
        ? 'Timeout: servidor não respondeu em 10 segundos.'
        : err.name === 'TypeError'
          ? 'URL inválida ou host inacessível.'
          : 'Falha ao disparar webhook.';
      return res.status(500).json({ sucesso: false, erro: erroMsg });
    }
  });

  return router;
};
