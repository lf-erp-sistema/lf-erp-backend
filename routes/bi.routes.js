/**
 * BI Simplificado — LF ERP
 * Relatórios executivos com análises temporais e comparativos.
 *
 * GET /bi/resumo-executivo   — todos os dados em uma única chamada
 * GET /bi/tendencia-vendas   — vendas por mês (últimos N meses)
 * GET /bi/comparativo        — este período vs anterior vs mesmo período ano passado
 * GET /bi/top-produtos       — top produtos por receita
 * GET /bi/top-clientes       — top clientes por receita
 * GET /bi/mix-pagamentos     — breakdown por forma de pagamento
 * GET /bi/margem-categorias  — margem bruta por categoria
 * GET /bi/funil              — orçamentos → pedidos → vendas
 */

const { erro, ok } = require('../utils/routeHelpers');

module.exports = function ({ auth, pool, validarAcessoEmpresa, hoje, requirePermissao }) {
  const router = require('express').Router();


  async function emp(req)               { return validarAcessoEmpresa(req, null, req.empresa_id); }

  // ── Tendência de vendas (últimos N meses) ─────────────────────────────────

  router.get('/tendencia-vendas', auth, requirePermissao(pool, 'bi', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const meses = Math.min(24, Math.max(3, Number(req.query.meses) || 12));

      const result = await pool.query(
        `SELECT
           TO_CHAR(DATE_TRUNC('month', data::date), 'YYYY-MM') AS mes,
           COUNT(*)                                             AS qtd_vendas,
           COALESCE(SUM(total), 0)                             AS receita,
           COALESCE(SUM(desconto), 0)                          AS descontos,
           COALESCE(SUM(vi_cmv.cmv), 0)                        AS custo
         FROM vendas v
         LEFT JOIN (
           SELECT venda_id, SUM(quantidade * COALESCE(custo_unitario, 0)) AS cmv
           FROM venda_itens GROUP BY venda_id
         ) vi_cmv ON vi_cmv.venda_id = v.id
         WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))
           AND v.status != 'cancelada'
           AND v.data::date >= (CURRENT_DATE - ($3 || ' months')::interval)::date
         GROUP BY 1
         ORDER BY 1`,
        [e.id, e.nome, meses]
      );

      return ok(res, {
        meses,
        dados: result.rows.map((r) => ({
          mes:        r.mes,
          qtd_vendas: Number(r.qtd_vendas),
          receita:    Number(r.receita),
          descontos:  Number(r.descontos),
          custo:      Number(r.custo),
          margem:     Number(r.receita) - Number(r.custo)
        }))
      });
    } catch (err) {
      console.error('[bi] tendencia:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Comparativo de períodos ───────────────────────────────────────────────

  router.get('/comparativo', auth, requirePermissao(pool, 'bi', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      async function kpiPeriodo(ini, fim) {
        const r = await pool.query(
          `SELECT
             COUNT(*)                      AS qtd_vendas,
             COALESCE(SUM(total), 0)       AS receita,
             COALESCE(SUM(desconto), 0)    AS descontos,
             COALESCE(COUNT(DISTINCT cliente_id) FILTER (WHERE cliente_id IS NOT NULL), 0) AS clientes_unicos
           FROM vendas
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
             AND status != 'cancelada'
             AND data::date BETWEEN $3 AND $4`,
          [e.id, e.nome, ini, fim]
        );

        const comp = await pool.query(
          `SELECT COALESCE(SUM(total), 0) AS compras
           FROM compras
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
             AND data::date BETWEEN $3 AND $4`,
          [e.id, e.nome, ini, fim]
        );

        const v = r.rows[0];
        return {
          qtd_vendas:    Number(v.qtd_vendas),
          receita:       Number(v.receita),
          descontos:     Number(v.descontos),
          compras:       Number(comp.rows[0].compras),
          clientes_unicos: Number(v.clientes_unicos)
        };
      }

      const hojeStr   = hoje();
      const dt        = new Date(hojeStr);
      const iniMes    = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-01`;
      const fimMes    = hojeStr;

      const dtPrev = new Date(dt.getFullYear(), dt.getMonth() - 1, 1);
      const iniPrev = `${dtPrev.getFullYear()}-${String(dtPrev.getMonth()+1).padStart(2,'0')}-01`;
      const fimPrev = `${dtPrev.getFullYear()}-${String(dtPrev.getMonth()+1).padStart(2,'0')}-${new Date(dtPrev.getFullYear(), dtPrev.getMonth()+1, 0).getDate()}`;

      const dtAnoAnt = new Date(dt.getFullYear()-1, dt.getMonth(), 1);
      const iniAnoAnt = `${dtAnoAnt.getFullYear()}-${String(dtAnoAnt.getMonth()+1).padStart(2,'0')}-01`;
      const fimAnoAnt = `${dtAnoAnt.getFullYear()}-${String(dtAnoAnt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;

      const [atual, anterior, anoAnterior] = await Promise.all([
        kpiPeriodo(iniMes, fimMes),
        kpiPeriodo(iniPrev, fimPrev),
        kpiPeriodo(iniAnoAnt, fimAnoAnt)
      ]);

      function variacao(agora, antes) {
        if (antes === 0) return agora > 0 ? 100 : 0;
        return Number((((agora - antes) / antes) * 100).toFixed(1));
      }

      return ok(res, {
        atual,
        anterior,
        ano_anterior: anoAnterior,
        variacoes: {
          vs_anterior:    { receita: variacao(atual.receita,    anterior.receita),    vendas: variacao(atual.qtd_vendas, anterior.qtd_vendas) },
          vs_ano_anterior: { receita: variacao(atual.receita,   anoAnterior.receita), vendas: variacao(atual.qtd_vendas, anoAnterior.qtd_vendas) }
        },
        periodos: { atual: { ini: iniMes, fim: fimMes }, anterior: { ini: iniPrev, fim: fimPrev }, ano_anterior: { ini: iniAnoAnt, fim: fimAnoAnt } }
      });
    } catch (err) {
      console.error('[bi] comparativo:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Top produtos ──────────────────────────────────────────────────────────

  router.get('/top-produtos', auth, requirePermissao(pool, 'bi', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const limit  = Math.min(20, Number(req.query.limit) || 10);
      const { inicio, fim } = req.query;

      const params = [e.id, e.nome];
      let dataCond = '';
      if (inicio) { params.push(inicio); dataCond += ` AND v.data >= $${params.length}`; }
      if (fim)    { params.push(fim);    dataCond += ` AND v.data <= $${params.length}`; }

      const result = await pool.query(
        `SELECT vi.produto_nome,
                COUNT(DISTINCT vi.venda_id)       AS qtd_vendas,
                SUM(vi.quantidade)                AS qtd_total,
                COALESCE(SUM(vi.total), 0)        AS receita,
                COALESCE(SUM(vi.quantidade * COALESCE(vi.custo_unitario,0)), 0) AS custo
         FROM venda_itens vi
         JOIN vendas v ON v.id = vi.venda_id
         WHERE (vi.empresa_id = $1 OR (vi.empresa_id IS NULL AND vi.empresa = $2))
           AND v.status != 'cancelada' ${dataCond}
         GROUP BY vi.produto_nome
         ORDER BY receita DESC
         LIMIT ${limit}`,
        params
      );

      return ok(res, {
        produtos: result.rows.map((r) => ({
          nome:       r.produto_nome,
          qtd_vendas: Number(r.qtd_vendas),
          qtd_total:  Number(r.qtd_total),
          receita:    Number(r.receita),
          custo:      Number(r.custo),
          margem:     Number(r.receita) - Number(r.custo)
        }))
      });
    } catch (err) {
      console.error('[bi] top-produtos:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Top clientes ──────────────────────────────────────────────────────────

  router.get('/top-clientes', auth, requirePermissao(pool, 'bi', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const limit = Math.min(20, Number(req.query.limit) || 10);
      const { inicio, fim } = req.query;

      const params = [e.id, e.nome];
      let dataCond = '';
      if (inicio) { params.push(inicio); dataCond += ` AND data >= $${params.length}`; }
      if (fim)    { params.push(fim);    dataCond += ` AND data <= $${params.length}`; }

      const result = await pool.query(
        `SELECT COALESCE(cliente_nome, 'Consumidor final') AS cliente,
                COUNT(*)                                   AS qtd_compras,
                COALESCE(SUM(total), 0)                    AS total_gasto,
                COALESCE(AVG(total), 0)                    AS ticket_medio
         FROM vendas
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
           AND status != 'cancelada' ${dataCond}
         GROUP BY cliente
         ORDER BY total_gasto DESC
         LIMIT ${limit}`,
        params
      );

      return ok(res, {
        clientes: result.rows.map((r) => ({
          nome:        r.cliente,
          qtd_compras: Number(r.qtd_compras),
          total_gasto: Number(r.total_gasto),
          ticket_medio: Number(Number(r.ticket_medio).toFixed(2))
        }))
      });
    } catch (err) {
      console.error('[bi] top-clientes:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Mix de pagamentos ─────────────────────────────────────────────────────

  router.get('/mix-pagamentos', auth, requirePermissao(pool, 'bi', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { inicio, fim } = req.query;
      const params = [e.id, e.nome];
      let dataCond = '';
      if (inicio) { params.push(inicio); dataCond += ` AND data >= $${params.length}`; }
      if (fim)    { params.push(fim);    dataCond += ` AND data <= $${params.length}`; }

      const result = await pool.query(
        `SELECT COALESCE(pagamento, 'Não informado') AS metodo,
                COUNT(*)                             AS qtd,
                COALESCE(SUM(total), 0)              AS total
         FROM vendas
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
           AND status != 'cancelada' ${dataCond}
         GROUP BY metodo
         ORDER BY total DESC`,
        params
      );

      const totalGeral = result.rows.reduce((s, r) => s + Number(r.total), 0);

      return ok(res, {
        metodos: result.rows.map((r) => ({
          metodo: r.metodo,
          qtd:    Number(r.qtd),
          total:  Number(r.total),
          pct:    totalGeral > 0 ? Number(((r.total / totalGeral) * 100).toFixed(1)) : 0
        })),
        total_geral: totalGeral
      });
    } catch (err) {
      console.error('[bi] mix-pagamentos:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Margem por categoria ──────────────────────────────────────────────────

  router.get('/margem-categorias', auth, requirePermissao(pool, 'bi', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { inicio, fim } = req.query;
      const params = [e.id, e.nome];
      let dataCond = '';
      if (inicio) { params.push(inicio); dataCond += ` AND v.data >= $${params.length}`; }
      if (fim)    { params.push(fim);    dataCond += ` AND v.data <= $${params.length}`; }

      const result = await pool.query(
        `SELECT COALESCE(p.categoria, 'Sem categoria') AS categoria,
                COALESCE(SUM(vi.total), 0) AS receita,
                COALESCE(SUM(vi.quantidade * COALESCE(vi.custo_unitario, 0)), 0) AS custo,
                COUNT(DISTINCT vi.venda_id) AS qtd_vendas
         FROM venda_itens vi
         JOIN vendas v ON v.id = vi.venda_id
         LEFT JOIN produtos p ON p.id = vi.produto_id
         WHERE (vi.empresa_id = $1 OR (vi.empresa_id IS NULL AND vi.empresa = $2))
           AND v.status != 'cancelada' ${dataCond}
         GROUP BY categoria
         ORDER BY receita DESC`,
        params
      );

      return ok(res, {
        categorias: result.rows.map((r) => {
          const rec = Number(r.receita);
          const cus = Number(r.custo);
          return {
            categoria:  r.categoria,
            receita:    rec,
            custo:      cus,
            margem:     rec - cus,
            margem_pct: rec > 0 ? Number(((rec - cus) / rec * 100).toFixed(1)) : 0,
            qtd_vendas: Number(r.qtd_vendas)
          };
        })
      });
    } catch (err) {
      console.error('[bi] margem-categorias:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Funil de conversão ────────────────────────────────────────────────────

  router.get('/funil', auth, requirePermissao(pool, 'bi', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { inicio, fim } = req.query;
      const params = [e.id, e.nome];
      let dataCond = '';
      if (inicio) { params.push(inicio); dataCond += ` AND criado_em::date >= $${params.length}`; }
      if (fim)    { params.push(fim);    dataCond += ` AND criado_em::date <= $${params.length}`; }

      const [orcRes, pedRes, vendasRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS total, COALESCE(SUM(total),0) AS valor FROM orcamentos WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) ${dataCond}`, params),
        pool.query(`SELECT COUNT(*) AS total, COALESCE(SUM(total),0) AS valor FROM pedidos WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) ${dataCond}`, params),
        pool.query(`SELECT COUNT(*) AS total, COALESCE(SUM(total),0) AS valor FROM vendas WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND status != 'cancelada' ${dataCond}`, params)
      ]);

      const etapas = [
        { etapa: 'Orçamentos', qtd: Number(orcRes.rows[0].total),    valor: Number(orcRes.rows[0].valor) },
        { etapa: 'Pedidos',    qtd: Number(pedRes.rows[0].total),    valor: Number(pedRes.rows[0].valor) },
        { etapa: 'Vendas',     qtd: Number(vendasRes.rows[0].total), valor: Number(vendasRes.rows[0].valor) }
      ];

      const maxQtd = Math.max(...etapas.map((e) => e.qtd), 1);
      const funilDados = etapas.map((e, i) => ({
        ...e,
        pct_entrada:   i === 0 ? 100 : Number(((e.qtd / etapas[0].qtd) * 100).toFixed(1)),
        conversao_step: i === 0 ? 100 : etapas[i-1].qtd > 0 ? Number(((e.qtd / etapas[i-1].qtd) * 100).toFixed(1)) : 0
      }));

      return ok(res, { etapas: funilDados });
    } catch (err) {
      console.error('[bi] funil:', err.message);
      return erro(res, 500, 'Erro interno no funil de conversão');
    }
  });

  // ── Insights IA ───────────────────────────────────────────────────────────

  const _iaCache = new Map(); // empresa_id → { ts, texto, gerado_em }

  router.get('/insights-ia', auth, requirePermissao(pool, 'bi', 'ver'), async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return erro(res, 503, 'ANTHROPIC_API_KEY não configurada no servidor');

    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      // Cache de 30 min por empresa
      const hit = _iaCache.get(e.id);
      if (hit && Date.now() - hit.ts < 30 * 60 * 1000) {
        return ok(res, { insights: hit.texto, gerado_em: hit.gerado_em, cache: true });
      }

      const [compR, tendR, atrasoR, estoqueR, topProdR] = await Promise.allSettled([
        pool.query(`
          SELECT TO_CHAR(DATE_TRUNC('month', data::date), 'YYYY-MM') AS mes,
                 COALESCE(SUM(total), 0) AS receita,
                 COUNT(*) AS qtd,
                 COALESCE(AVG(total), 0) AS ticket
          FROM vendas
          WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
            AND DATE_TRUNC('month', data::date) >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
          GROUP BY 1 ORDER BY 1`, [e.id, e.nome]),

        pool.query(`
          SELECT TO_CHAR(DATE_TRUNC('month', data::date), 'YYYY-MM') AS mes,
                 COALESCE(SUM(total), 0) AS receita
          FROM vendas
          WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
            AND data::date >= CURRENT_DATE - INTERVAL '6 months'
          GROUP BY 1 ORDER BY 1`, [e.id, e.nome]),

        pool.query(`
          SELECT COUNT(*) AS qtd, COALESCE(SUM(valor), 0) AS total
          FROM contas_receber
          WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
            AND status IN ('atrasado', 'parcial_atrasado')`, [e.id, e.nome]),

        pool.query(`
          SELECT COUNT(*) AS qtd
          FROM produtos
          WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
            AND estoque_minimo > 0 AND estoque < estoque_minimo`, [e.id, e.nome]),

        pool.query(`
          SELECT vi.produto_nome, COALESCE(SUM(vi.total), 0) AS receita
          FROM venda_itens vi
          JOIN vendas v ON v.id = vi.venda_id
          WHERE vi.empresa_id = $1
            AND v.data::date >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY vi.produto_nome ORDER BY receita DESC LIMIT 5`, [e.id])
      ]);

      const falhaConsulta = [compR, tendR, atrasoR, estoqueR, topProdR].find(r => r.status === 'rejected');
      if (falhaConsulta) throw falhaConsulta.reason;
      const safeRows = (r) => r.status === 'fulfilled' ? r.value.rows : [];

      const hojeStr  = hoje();
      const mesMes   = hojeStr.slice(0, 7);
      const comp     = safeRows(compR);
      const tend     = safeRows(tendR);
      const atraso   = safeRows(atrasoR)[0] || { qtd: 0, total: 0 };
      const estoque  = safeRows(estoqueR)[0] || { qtd: 0 };
      const topProd  = safeRows(topProdR);

      // Calcula mês anterior dinamicamente
      const dtAnterior = new Date(hojeStr.slice(0, 8) + '01');
      dtAnterior.setMonth(dtAnterior.getMonth() - 1);
      const mesPrev  = `${dtAnterior.getFullYear()}-${String(dtAnterior.getMonth() + 1).padStart(2, '0')}`;

      const atual    = comp.find(r => r.mes === mesMes)  || { receita: 0, qtd: 0, ticket: 0 };
      const anterior = comp.find(r => r.mes === mesPrev) || { receita: 0 };

      const varPct   = Number(anterior.receita) > 0
        ? ((Number(atual.receita) - Number(anterior.receita)) / Number(anterior.receita) * 100).toFixed(1)
        : null;

      const brl      = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const tendFmt  = tend.map(t => `${t.mes}: ${brl(t.receita)}`).join(', ');
      const prodFmt  = topProd.map((p, i) => `${i + 1}. ${p.produto_nome} (${brl(p.receita)})`).join('; ');
      const nomeEmp  = e.nome.replace(/["""'']/g, "'").slice(0, 60);

      const prompt = `Você é um analista de negócios especialista do ERP da empresa "${nomeEmp}". Com base nos dados reais abaixo, gere um resumo executivo em português do Brasil.

DADOS DO NEGÓCIO:
- Receita mês atual: ${brl(atual.receita)}${varPct !== null ? ` (${Number(varPct) >= 0 ? '+' : ''}${varPct}% vs mês anterior)` : ''}
- Número de vendas este mês: ${atual.qtd}
- Ticket médio: ${brl(atual.ticket)}
- Tendência dos últimos 6 meses (receita por mês): ${tendFmt || 'dados insuficientes'}
- Top 5 produtos últimos 30 dias: ${prodFmt || 'sem dados'}
- Contas a receber em atraso: ${atraso.qtd} título(s), total ${brl(atraso.total)}
- Produtos com estoque abaixo do mínimo: ${estoque.qtd}

Responda EXATAMENTE neste formato (sem markdown adicional):

DIAGNÓSTICO
[2 frases curtas sobre o momento atual do negócio usando os números reais]

PONTOS POSITIVOS
• [ponto específico com dado numérico]
• [ponto específico com dado numérico]

ALERTAS
• [alerta específico com dado numérico]
• [alerta específico com dado numérico]

AÇÕES PARA ESTA SEMANA
• [ação concreta e prática]
• [ação concreta e prática]

Máximo 200 palavras. Use os números reais fornecidos acima.`;

      const AnthropicSdk = require('@anthropic-ai/sdk');
      const AntClass     = AnthropicSdk.default ?? AnthropicSdk;
      const client       = new AntClass({ apiKey });

      const msg = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages:   [{ role: 'user', content: prompt }]
      });

      const texto     = (msg.content[0]?.type === 'text' ? msg.content[0].text : '').trim();
      const gerado_em = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });

      _iaCache.set(e.id, { ts: Date.now(), texto, gerado_em });
      return ok(res, { insights: texto, gerado_em, cache: false });

    } catch (err) {
      console.error('[bi] insights-ia:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Resumo executivo (tudo em uma chamada) ────────────────────────────────

  router.get('/resumo-executivo', auth, requirePermissao(pool, 'bi', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      // Dispara todas as queries em paralelo
      const [t, comp, tp, tc, mp, mc, fn] = await Promise.allSettled([
        // tendencia
        pool.query(`SELECT TO_CHAR(DATE_TRUNC('month',data::date),'YYYY-MM') AS mes, COUNT(*) AS qtd, COALESCE(SUM(total),0) AS receita FROM vendas WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND data::date >= (CURRENT_DATE - '12 months'::interval)::date GROUP BY 1 ORDER BY 1`, [e.id, e.nome]),
        // comparativo mês atual vs anterior
        pool.query(`SELECT TO_CHAR(DATE_TRUNC('month',data::date),'YYYY-MM') AS mes, COALESCE(SUM(total),0) AS receita, COUNT(*) AS qtd FROM vendas WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND DATE_TRUNC('month',data::date) >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '1 month' GROUP BY 1 ORDER BY 1`, [e.id, e.nome]),
        // top produtos
        pool.query(`SELECT vi.produto_nome, COALESCE(SUM(vi.total),0) AS receita, SUM(vi.quantidade) AS qtd FROM venda_itens vi WHERE (vi.empresa_id=$1 OR (vi.empresa_id IS NULL AND vi.empresa=$2)) GROUP BY vi.produto_nome ORDER BY receita DESC LIMIT 10`, [e.id, e.nome]),
        // top clientes
        pool.query(`SELECT COALESCE(cliente_nome,'Consumidor final') AS cliente, COALESCE(SUM(total),0) AS total, COUNT(*) AS qtd FROM vendas WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) GROUP BY cliente ORDER BY total DESC LIMIT 10`, [e.id, e.nome]),
        // mix pagamentos
        pool.query(`SELECT COALESCE(pagamento,'Não informado') AS metodo, COUNT(*) AS qtd, COALESCE(SUM(total),0) AS total FROM vendas WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND data::date >= CURRENT_DATE - INTERVAL '30 days' GROUP BY metodo ORDER BY total DESC`, [e.id, e.nome]),
        // margem categorias
        pool.query(`SELECT COALESCE(p.categoria,'Sem categoria') AS categoria, COALESCE(SUM(vi.total),0) AS receita, COALESCE(SUM(vi.quantidade*COALESCE(vi.custo_unitario,0)),0) AS custo FROM venda_itens vi JOIN vendas v ON v.id=vi.venda_id LEFT JOIN produtos p ON p.id=vi.produto_id WHERE (vi.empresa_id=$1 OR (vi.empresa_id IS NULL AND vi.empresa=$2)) AND v.data::date >= CURRENT_DATE-INTERVAL '30 days' GROUP BY categoria ORDER BY receita DESC`, [e.id, e.nome]),
        // funil
        Promise.all([
          pool.query(`SELECT COUNT(*) AS total FROM orcamentos WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND criado_em >= CURRENT_DATE-INTERVAL '30 days'`, [e.id, e.nome]),
          pool.query(`SELECT COUNT(*) AS total FROM pedidos    WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND criado_em >= CURRENT_DATE-INTERVAL '30 days'`, [e.id, e.nome]),
          pool.query(`SELECT COUNT(*) AS total FROM vendas     WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND criado_em >= CURRENT_DATE-INTERVAL '30 days'`, [e.id, e.nome])
        ])
      ]);

      const falha = [t, comp, tp, tc, mp, mc, fn].find(result => result.status === 'rejected');
      if (falha) throw falha.reason;
      const safe = (r, map) => r.status === 'fulfilled' ? (map ? r.value.rows.map(map) : r.value.rows) : [];
      const safeVal = (r, key, def = []) => r.status === 'fulfilled' ? r.value[key] || def : def;

      const fnVal = fn.status === 'fulfilled' ? fn.value : [{ rows:[{total:0}] }, { rows:[{total:0}] }, { rows:[{total:0}] }];

      return ok(res, {
        tendencia_12m:  safe(t),
        comparativo_2m: safe(comp),
        top_produtos:   safe(tp),
        top_clientes:   safe(tc),
        mix_pagamentos: safe(mp),
        margem_categorias: safe(mc),
        funil: [
          { etapa: 'Orçamentos', qtd: Number(fnVal[0].rows[0].total) },
          { etapa: 'Pedidos',    qtd: Number(fnVal[1].rows[0].total) },
          { etapa: 'Vendas',     qtd: Number(fnVal[2].rows[0].total) }
        ]
      });
    } catch (err) {
      console.error('[bi] resumo-executivo:', err.message);
      return erro(res, 500, 'Erro interno no resumo executivo');
    }
  });

  return router;
};
