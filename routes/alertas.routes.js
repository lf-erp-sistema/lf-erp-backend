/**
 * Alertas de Cobrança — LF ERP
 * Dispara lembretes de pagamento por email (SMTP) e gera links WhatsApp.
 *
 * Montado em /alertas.
 *
 * Rotas:
 *   GET  /alertas/config                — ler configuração de alertas
 *   PUT  /alertas/config                — salvar configuração (SMTP, templates)
 *   POST /alertas/disparar              — envia emails e retorna links WhatsApp (inadimplentes)
 *   GET  /alertas/historico             — histórico dos últimos 100 alertas
 *   GET  /alertas/preview-promissoria   — gera mensagem WhatsApp para um cliente (manual)
 *   POST /alertas/disparar-preventivo   — dispara cobrança preventiva (cron webhook ou manual)
 */

const nodemailer = require('nodemailer');

// Template simples: substitui {{variavel}} pelos valores
function aplicarTemplate(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// Monta mensagem WhatsApp para cobrança preventiva de promissórias
function montarMensagemPromissoria(cliente, empresaNome) {
  const fmtCur = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtData = d => d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR') : '';

  const hojeFortaleza = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  const hojeStr = hojeFortaleza.toISOString().slice(0, 10);

  const venceHoje = cliente.itens.some(i => String(i.data_vencimento || '').slice(0, 10) === hojeStr);

  const itensLinhas = cliente.itens.map(item => {
    const temParcial = Number(item.valor_original || 0) > Number(item.valor || 0) + 0.01;
    const nome = item.descricao || 'Produto';
    if (temParcial) return `• ${nome} → restam *${fmtCur(item.valor)}* (de ${fmtCur(item.valor_original)})`;
    return `• ${nome} → *${fmtCur(item.valor)}*`;
  }).join('\n');

  const temParcialTotal = Number(cliente.total_original || 0) > Number(cliente.total || 0) + 0.01;
  const totalLinha = temParcialTotal
    ? `💰 *Total em aberto: ${fmtCur(cliente.total)}* (de ${fmtCur(cliente.total_original)})`
    : `💰 *Total: ${fmtCur(cliente.total)}*`;

  const aviso = venceHoje
    ? `Sua promissória vence *hoje, ${fmtData(hojeStr)}*. Segue o detalhamento:`
    : `Segue o resumo das suas promissórias em aberto:`;

  return `Olá, *${cliente.cliente_nome}*! 👋\n\n${aviso}\n\n📦 *Produtos:*\n${itensLinhas}\n\n${totalLinha}\n\nQualquer dúvida, fale com a gente! 😊\n— *${empresaNome}*`;
}

// ── Dias úteis ───────────────────────────────────────────────────────────────

// Algoritmo de Meeus/Jones/Butcher para calcular Domingo de Páscoa
function calcularPascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}

function addDias(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function mesmoDia(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

function isFeriadoNacional(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  // Feriados nacionais fixos brasileiros
  const fixos = new Set(['1-1','4-21','5-1','9-7','10-12','11-2','11-15','12-25']);
  if (fixos.has(`${m}-${d}`)) return true;

  // Feriados móveis baseados na Páscoa
  const pascoa = calcularPascoa(date.getFullYear());
  const moveis = [
    addDias(pascoa, -48), // Segunda de Carnaval
    addDias(pascoa, -47), // Terça de Carnaval
    addDias(pascoa,  -2), // Sexta-feira Santa (Paixão de Cristo)
    addDias(pascoa,  60), // Corpus Christi
  ];
  return moveis.some(f => mesmoDia(f, date));
}

function isDiaUtil(date) {
  const dow = date.getDay(); // 0=Dom, 6=Sáb
  if (dow === 0 || dow === 6) return false;
  return !isFeriadoNacional(date);
}

// Retorna array de datas YYYY-MM-DD que devem ser cobertas hoje (dia útil cobre os
// próximos dias não-úteis até o próximo dia útil). Retorna null se hoje não é dia útil.
function datasParaProcessarHoje(hojeDate) {
  if (!isDiaUtil(hojeDate)) return null;
  const datas = [];
  let d = new Date(hojeDate);
  while (true) {
    datas.push(d.toISOString().slice(0, 10));
    const prox = new Date(d);
    prox.setDate(prox.getDate() + 1);
    if (isDiaUtil(prox)) break;
    d = prox;
  }
  return datas;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Limpa número de telefone e gera URL wa.me
function gerarLinkWhatsApp(telefone, mensagem) {
  if (!telefone) return null;
  let num = String(telefone).replace(/\D/g, '');
  if (!num) return null;
  if (num.startsWith('0')) num = '55' + num.slice(1);
  if (!num.startsWith('55')) num = '55' + num;
  return `https://wa.me/${num}?text=${encodeURIComponent(mensagem)}`;
}

const { requirePermissao } = require('../utils/permissoes');
const { erro, ok } = require('../utils/routeHelpers');
const { encryptField, decryptField } = require('../utils/pixCrypto');

function safeDecryptSMTP(v) {
  if (!v) return v;
  try { return decryptField(v); } catch { return v; }
}

module.exports = ({ auth, writeRateLimiter, pool, validarAcessoEmpresa }) => {
  const router = require('express').Router();



  async function getEmpresa(req) {
    return validarAcessoEmpresa(req, req.query.empresa || req.body?.empresa, req.empresa_id);
  }

  async function getConfig(empresaId) {
    const r = await pool.query(`SELECT * FROM alertas_config WHERE empresa_id = $1`, [empresaId]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    // Descriptografa smtp_pass para uso interno (nodemailer)
    return { ...row, smtp_pass: safeDecryptSMTP(row.smtp_pass) };
  }

  // ── GET /alertas/config ───────────────────────────────────────────────────
  router.get('/config', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const cfg = await getConfig(emp.id);
      // Nunca retorna a senha ao frontend
      const cfgSafe = cfg ? { ...cfg, smtp_pass: cfg.smtp_pass ? '***configurado***' : null } : null;
      return ok(res, { config: cfgSafe });
    } catch (err) {
      console.error('[alertas] GET config:', err.message);
      return erro(res, 500, 'Erro ao buscar configuração');
    }
  });

  // ── PUT /alertas/config ───────────────────────────────────────────────────
  router.put('/config', auth, requirePermissao(pool, 'financeiro', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const {
        email_ativo, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
        email_assunto, email_corpo,
        whatsapp_ativo, whatsapp_msg,
        dias_atraso_minimo,
        cobranca_preventiva_ativa
      } = req.body;

      if (dias_atraso_minimo != null) {
        const diasN = parseInt(dias_atraso_minimo, 10);
        if (isNaN(diasN) || diasN < 1 || diasN > 365) {
          return erro(res, 400, 'dias_atraso_minimo deve ser entre 1 e 365');
        }
      }

      await pool.query(
        `INSERT INTO alertas_config
           (empresa_id, email_ativo, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
            email_assunto, email_corpo, whatsapp_ativo, whatsapp_msg, dias_atraso_minimo,
            cobranca_preventiva_ativa, atualizado_em)
         VALUES ($1,COALESCE($2,false),$3,$4,$5,$6,$7,$8,$9,COALESCE($10,false),$11,$12,COALESCE($13,false),NOW() AT TIME ZONE 'America/Fortaleza')
         ON CONFLICT (empresa_id) DO UPDATE SET
           email_ativo           = COALESCE($2, alertas_config.email_ativo),
           smtp_host             = COALESCE($3, alertas_config.smtp_host),
           smtp_port             = COALESCE($4, alertas_config.smtp_port),
           smtp_user             = COALESCE($5, alertas_config.smtp_user),
           smtp_pass             = COALESCE($6, alertas_config.smtp_pass),
           smtp_from             = COALESCE($7, alertas_config.smtp_from),
           email_assunto         = COALESCE($8, alertas_config.email_assunto),
           email_corpo           = COALESCE($9, alertas_config.email_corpo),
           whatsapp_ativo        = COALESCE($10, alertas_config.whatsapp_ativo),
           whatsapp_msg               = COALESCE($11, alertas_config.whatsapp_msg),
           dias_atraso_minimo         = COALESCE($12, alertas_config.dias_atraso_minimo),
           cobranca_preventiva_ativa  = COALESCE($13, alertas_config.cobranca_preventiva_ativa),
           atualizado_em              = NOW() AT TIME ZONE 'America/Fortaleza'`,
        [
          emp.id,
          email_ativo !== undefined ? Boolean(email_ativo) : null,
          smtp_host || null,
          smtp_port ? Number(smtp_port) : null,
          smtp_user || null,
          smtp_pass ? encryptField(smtp_pass) : null,
          smtp_from || null,
          email_assunto || null,
          email_corpo || null,
          whatsapp_ativo !== undefined ? Boolean(whatsapp_ativo) : null,
          whatsapp_msg || null,
          dias_atraso_minimo != null ? Number(dias_atraso_minimo) : null,
          cobranca_preventiva_ativa !== undefined ? Boolean(cobranca_preventiva_ativa) : null
        ]
      );

      return ok(res, { mensagem: 'Configuração de alertas salva' });
    } catch (err) {
      console.error('[alertas] PUT config:', err.message);
      return erro(res, 500, 'Erro ao salvar configuração');
    }
  });

  // ── POST /alertas/disparar ────────────────────────────────────────────────
  router.post('/disparar', auth, requirePermissao(pool, 'financeiro', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const cfg = await getConfig(emp.id);
      if (!cfg) return erro(res, 400, 'Configure os alertas antes de disparar');

      if (!cfg.email_ativo && !cfg.whatsapp_ativo) {
        return erro(res, 400, 'Ative email ou WhatsApp nas configurações');
      }

      const diasMin = Number(cfg.dias_atraso_minimo || 1);

      // Busca clientes inadimplentes com dados de contato
      const clientesResult = await pool.query(
        `SELECT
           cr.cliente_id,
           cr.cliente_nome,
           c.email,
           c.telefone,
           COALESCE(SUM(cr.valor), 0) AS valor_total,
           MAX(CURRENT_DATE - cr.data_vencimento::date) AS max_dias
         FROM contas_receber cr
         LEFT JOIN clientes c ON c.id = cr.cliente_id AND (c.empresa_id = cr.empresa_id OR (c.empresa_id IS NULL AND c.empresa = cr.empresa))
         WHERE (cr.empresa_id = $1 OR (cr.empresa_id IS NULL AND cr.empresa = $3))
           AND LOWER(COALESCE(cr.status,'pendente')) NOT IN ('pago', 'cancelado', 'estornado')
           AND cr.data_vencimento::date < CURRENT_DATE
           AND CURRENT_DATE - cr.data_vencimento::date >= $2
         GROUP BY cr.cliente_id, cr.cliente_nome, c.email, c.telefone
         ORDER BY valor_total DESC`,
        [emp.id, diasMin, emp.nome]
      );

      const clientes = clientesResult.rows;

      if (clientes.length === 0) {
        return ok(res, { enviados_email: 0, links_whatsapp: [], mensagem: 'Nenhum cliente inadimplente para o critério configurado' });
      }

      const results = { enviados_email: 0, erros_email: 0, links_whatsapp: [], total_clientes: clientes.length };

      // ── Email ──────────────────────────────────────────────────────────────
      let transporter = null;
      const SSRF_BLOCK = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.|::1|fc00:|fe80:|fd[0-9a-f]{2}:|localhost$)/i;
      if (cfg.email_ativo && cfg.smtp_host && cfg.smtp_user && cfg.smtp_pass) {
        if (SSRF_BLOCK.test(String(cfg.smtp_host).trim().replace(/^\[|\]$/g, ''))) {
          console.warn('[alertas] smtp_host bloqueado (IP privado/localhost):', cfg.smtp_host);
        } else {
          try {
            transporter = nodemailer.createTransport({
              host: cfg.smtp_host,
              port: Number(cfg.smtp_port || 587),
              secure: Number(cfg.smtp_port) === 465,
              auth: { user: cfg.smtp_user, pass: cfg.smtp_pass }
            });
          } catch (te) {
            console.error('[alertas] transporter error:', te.message);
          }
        }
      }

      const defaultCorpo = `Olá {{cliente_nome}},\n\nVerificamos que você possui um saldo em aberto de {{valor_total}} com vencimento ultrapassado.\n\nPor favor, entre em contato para regularizar sua situação.\n\nAtenciosamente,\n{{empresa_nome}}`;
      const defaultAssunto = `Aviso de pagamento — {{empresa_nome}}`;

      for (const cli of clientes) {
        const vars = {
          cliente_nome:  cli.cliente_nome || 'Cliente',
          valor_total:   Number(cli.valor_total || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
          empresa_nome:  emp.nome,
          dias_atraso:   String(cli.max_dias || 0)
        };

        // Email
        if (transporter && cli.email) {
          const assunto  = aplicarTemplate(cfg.email_assunto || defaultAssunto, vars);
          const corpo    = aplicarTemplate(cfg.email_corpo   || defaultCorpo,   vars);
          const htmlVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escHtml(v)]));
          const corpoHtml = aplicarTemplate(cfg.email_corpo  || defaultCorpo,   htmlVars).replace(/\n/g, '<br>');
          try {
            await transporter.sendMail({
              from:    cfg.smtp_from || cfg.smtp_user,
              to:      cli.email,
              subject: assunto,
              text:    corpo,
              html:    corpoHtml
            });
            results.enviados_email++;
            await pool.query(
              `INSERT INTO alertas_historico (empresa_id, tipo, cliente_id, cliente_nome, contato, valor_total, status)
               VALUES ($1,'email',$2,$3,$4,$5,'enviado')`,
              [emp.id, cli.cliente_id, cli.cliente_nome, cli.email, cli.valor_total]
            );
          } catch (mailErr) {
            results.erros_email = (results.erros_email || 0) + 1;
            await pool.query(
              `INSERT INTO alertas_historico (empresa_id, tipo, cliente_id, cliente_nome, contato, valor_total, status, erro_msg)
               VALUES ($1,'email',$2,$3,$4,$5,'erro',$6)`,
              [emp.id, cli.cliente_id, cli.cliente_nome, cli.email, cli.valor_total, 'Erro ao enviar e-mail']
            );
          }
        }

        // WhatsApp link
        if (cfg.whatsapp_ativo && cli.telefone) {
          const msgWpp = aplicarTemplate(
            cfg.whatsapp_msg || `Olá {{cliente_nome}}, você possui um saldo em aberto de {{valor_total}} com {{empresa_nome}}. Por favor entre em contato.`,
            vars
          );
          const link = gerarLinkWhatsApp(cli.telefone, msgWpp);
          if (link) {
            results.links_whatsapp.push({
              cliente_nome:  cli.cliente_nome,
              telefone:      cli.telefone,
              valor_total:   Number(cli.valor_total || 0),
              link
            });
            await pool.query(
              `INSERT INTO alertas_historico (empresa_id, tipo, cliente_id, cliente_nome, contato, valor_total, status)
               VALUES ($1,'whatsapp',$2,$3,$4,$5,'enviado')`,
              [emp.id, cli.cliente_id, cli.cliente_nome, cli.telefone, cli.valor_total]
            );
          }
        }
      }

      results.mensagem = `Alertas processados. ${results.enviados_email} email(s) enviado(s), ${results.links_whatsapp.length} link(s) WhatsApp gerado(s).`;
      return ok(res, results);
    } catch (err) {
      console.error('[alertas] POST disparar:', err.message);
      return erro(res, 500, 'Erro ao disparar alertas');
    }
  });

  // ── GET /alertas/preview-promissoria — mensagem manual para um cliente ───────
  router.get('/preview-promissoria', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const clienteId   = req.query.cliente_id   ? Number(req.query.cliente_id)   : null;
      const clienteNome = req.query.cliente_nome  ? String(req.query.cliente_nome) : null;

      if (!clienteId && !clienteNome) return erro(res, 400, 'Informe cliente_id ou cliente_nome');

      const whereCliente = clienteId
        ? `AND cr.cliente_id = ${clienteId}`
        : `AND LOWER(cr.cliente_nome) = LOWER('${clienteNome.replace(/'/g, "''")}')`;

      const result = await pool.query(
        `SELECT cr.id, cr.cliente_id, cr.cliente_nome, cr.observacao,
                cr.valor, cr.valor_original, cr.data_vencimento, cr.status,
                c.telefone
         FROM contas_receber cr
         LEFT JOIN clientes c ON c.id = cr.cliente_id
           AND (c.empresa_id = cr.empresa_id OR (c.empresa_id IS NULL AND c.empresa = cr.empresa))
         WHERE (cr.empresa_id = $1 OR (cr.empresa_id IS NULL AND cr.empresa = $2))
           AND cr.forma_pagamento ILIKE 'promiss%'
           AND LOWER(COALESCE(cr.status,'pendente')) NOT IN ('pago','cancelado','estornado')
           ${whereCliente}
         ORDER BY cr.data_vencimento`,
        [emp.id, emp.nome]
      );

      if (result.rowCount === 0) return erro(res, 404, 'Nenhuma promissória em aberto para este cliente');

      const first = result.rows[0];
      const cliente = {
        cliente_id:    first.cliente_id,
        cliente_nome:  first.cliente_nome || 'Cliente',
        telefone:      first.telefone,
        itens:         result.rows.map(r => ({
          id:              r.id,
          descricao:       r.observacao || 'Produto',
          valor:           Number(r.valor || 0),
          valor_original:  Number(r.valor_original || r.valor || 0),
          data_vencimento: r.data_vencimento,
          status:          r.status || 'pendente'
        })),
        total:          result.rows.reduce((s, r) => s + Number(r.valor || 0), 0),
        total_original: result.rows.reduce((s, r) => s + Number(r.valor_original || r.valor || 0), 0)
      };

      const mensagem = montarMensagemPromissoria(cliente, emp.nome);
      const link     = gerarLinkWhatsApp(cliente.telefone, mensagem);

      return ok(res, { mensagem, link, telefone: cliente.telefone });
    } catch (err) {
      console.error('[alertas] GET preview-promissoria:', err.message);
      return erro(res, 500, 'Erro ao gerar preview');
    }
  });

  // ── POST /alertas/disparar-preventivo — cron webhook ou disparo manual ────────
  router.post('/disparar-preventivo', async (req, res) => {
    try {
      // Aceita CRON_SECRET (webhook externo) ou JWT (usuário autenticado)
      const cronSecret = process.env.CRON_SECRET;
      const tokenHeader = req.headers['x-cron-secret'] || req.headers['authorization']?.replace('Bearer ', '');
      const isCron = cronSecret && tokenHeader === cronSecret;

      let emp = null;
      if (isCron) {
        // Webhook: empresa_id obrigatório no body
        const { empresa_id } = req.body;
        if (!empresa_id) return erro(res, 400, 'empresa_id obrigatório para disparo via cron');
        const r = await pool.query(`SELECT * FROM empresas WHERE id = $1 LIMIT 1`, [empresa_id]);
        if (!r.rowCount) return erro(res, 404, 'Empresa não encontrada');
        emp = r.rows[0];
      } else {
        // Usuário autenticado via JWT
        await new Promise((resolve, reject) => {
          require('../middleware/auth').auth(req, res, (err) => err ? reject(err) : resolve());
        });
        emp = await getEmpresa(req);
        if (!emp) return erro(res, 403, 'Sem acesso');
      }

      // Verifica se cobrança preventiva está ativa (ignora para disparo manual isCron=false)
      if (isCron) {
        const cfg = await pool.query(`SELECT cobranca_preventiva_ativa FROM alertas_config WHERE empresa_id = $1`, [emp.id]);
        if (!cfg.rowCount || !cfg.rows[0].cobranca_preventiva_ativa) {
          return ok(res, { mensagem: 'Cobrança preventiva desativada para esta empresa', disparados: 0 });
        }
      }

      const hojeFortaleza = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
      const hoje = hojeFortaleza.toISOString().slice(0, 10);

      // Busca apenas vencimentos de hoje (preventivo) ou todos em aberto (manual)
      const somenteHoje = req.body.somente_hoje !== false; // default true
      let whereData = '';
      let params = [emp.id, emp.nome];

      if (somenteHoje) {
        if (isCron) {
          // Cron: respeita dias úteis — sexta cobre sábado+domingo, etc.
          const datasHoje = datasParaProcessarHoje(hojeFortaleza);
          if (!datasHoje) {
            return ok(res, { mensagem: 'Hoje não é dia útil — nenhuma mensagem enviada', disparados: 0 });
          }
          whereData = `AND cr.data_vencimento::date = ANY($3::date[])`;
          params = [emp.id, emp.nome, datasHoje];
        } else {
          // Disparo manual (frontend): ignora regra de dia útil, usa data atual
          whereData = `AND cr.data_vencimento::date = $3`;
          params = [emp.id, emp.nome, hoje];
        }
      }

      const result = await pool.query(
        `SELECT cr.id, cr.cliente_id, cr.cliente_nome, cr.observacao,
                cr.valor, cr.valor_original, cr.data_vencimento, cr.status,
                c.telefone
         FROM contas_receber cr
         LEFT JOIN clientes c ON c.id = cr.cliente_id
           AND (c.empresa_id = cr.empresa_id OR (c.empresa_id IS NULL AND c.empresa = cr.empresa))
         WHERE (cr.empresa_id = $1 OR (cr.empresa_id IS NULL AND cr.empresa = $2))
           AND cr.forma_pagamento ILIKE 'promiss%'
           AND LOWER(COALESCE(cr.status,'pendente')) NOT IN ('pago','cancelado','estornado')
           ${whereData}
         ORDER BY cr.cliente_nome, cr.data_vencimento`,
        params
      );

      if (result.rowCount === 0) {
        return ok(res, { mensagem: 'Nenhuma promissória para disparar hoje', disparados: 0 });
      }

      // Agrupa por cliente
      const clienteMap = new Map();
      for (const row of result.rows) {
        const key = row.cliente_id ?? `nome_${row.cliente_nome}`;
        if (!clienteMap.has(key)) {
          clienteMap.set(key, {
            cliente_id: row.cliente_id, cliente_nome: row.cliente_nome || 'Cliente',
            telefone: row.telefone, itens: [], total: 0, total_original: 0
          });
        }
        const cli = clienteMap.get(key);
        const v = Number(row.valor || 0), vo = Number(row.valor_original || row.valor || 0);
        cli.itens.push({ id: row.id, descricao: row.observacao || 'Produto', valor: v, valor_original: vo, data_vencimento: row.data_vencimento, status: row.status });
        cli.total += v; cli.total_original += vo;
      }

      const wppCfg = await pool.query(
        `SELECT wpp_provider, wpp_api_url, wpp_instance, wpp_token, wpp_ativo FROM alertas_config WHERE empresa_id = $1`,
        [emp.id]
      );
      const wpp = wppCfg.rows[0] || {};

      const links = [];
      let enviados = 0, erros = 0;

      for (const cli of clienteMap.values()) {
        const mensagem = montarMensagemPromissoria(cli, emp.nome);
        const link     = gerarLinkWhatsApp(cli.telefone, mensagem);

        let statusLog = 'link';
        if (wpp.wpp_ativo && wpp.wpp_provider !== 'link' && cli.telefone) {
          const { enviarMensagem } = require('../utils/whatsapp');
          const r = await enviarMensagem({ cfg: wpp, telefone: cli.telefone, mensagem });
          if (r.sucesso) { enviados++; statusLog = 'enviado'; }
          else           { erros++;    statusLog = 'erro';    }
        } else if (link) {
          links.push({ cliente_nome: cli.cliente_nome, telefone: cli.telefone, link, mensagem });
        }

        await pool.query(
          `INSERT INTO alertas_historico (empresa_id, tipo, cliente_id, cliente_nome, contato, valor_total, status)
           VALUES ($1,'whatsapp',$2,$3,$4,$5,$6)`,
          [emp.id, cli.cliente_id, cli.cliente_nome, cli.telefone, Math.round(cli.total * 100) / 100, statusLog]
        ).catch(() => {});
      }

      return ok(res, {
        mensagem: `Cobrança preventiva processada: ${enviados} enviados, ${links.length} links, ${erros} erros.`,
        disparados: clienteMap.size,
        enviados,
        links_whatsapp: links,
        erros
      });
    } catch (err) {
      console.error('[alertas] POST disparar-preventivo:', err.message);
      return erro(res, 500, 'Erro ao disparar cobrança preventiva');
    }
  });

  // ── GET /alertas/historico ────────────────────────────────────────────────
  router.get('/historico', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT * FROM alertas_historico
         WHERE empresa_id = $1
         ORDER BY criado_em DESC
         LIMIT 100`,
        [emp.id]
      );

      return ok(res, {
        historico: result.rows.map((r) => ({ ...r, valor_total: Number(r.valor_total || 0) }))
      });
    } catch (err) {
      console.error('[alertas] GET historico:', err.message);
      return erro(res, 500, 'Erro ao buscar histórico');
    }
  });

  return router;
};
