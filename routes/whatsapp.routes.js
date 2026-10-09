/**
 * WhatsApp Business — LF ERP
 * Envio via API (Evolution / Z-API) com templates e automação de cobranças.
 *
 * GET    /whatsapp/config                   — ler config da empresa
 * PUT    /whatsapp/config                   — salvar credenciais + ativar/desativar
 * POST   /whatsapp/testar                   — enviar mensagem de teste para o próprio número
 *
 * GET    /whatsapp/templates                — listar templates por evento
 * PUT    /whatsapp/templates/:evento        — salvar template
 *
 * POST   /whatsapp/enviar                   — envio manual para um cliente/número
 * POST   /whatsapp/processar/cobrancas      — processa cobranças atrasadas/vencendo (batch)
 *
 * GET    /whatsapp/historico                — últimos 200 envios
 */

const { enviarMensagem, aplicarTemplate } = require('../utils/whatsapp');
const { erro, ok } = require('../utils/routeHelpers');
const { validarHostExterno } = require('../utils/ssrfGuard');

const EVENTOS = [
  { key: 'cobranca.atrasada',  label: 'Cobrança atrasada',         variaveis: ['nome', 'valor', 'dias', 'empresa'] },
  { key: 'cobranca.vencendo',  label: 'Vencimento próximo',         variaveis: ['nome', 'valor', 'vencimento', 'empresa'] },
  { key: 'venda.confirmada',   label: 'Venda confirmada',           variaveis: ['nome', 'valor', 'empresa'] },
  { key: 'pedido.criado',      label: 'Pedido criado',              variaveis: ['nome', 'numero', 'valor', 'empresa'] },
  { key: 'nfe.emitida',        label: 'NF-e emitida',               variaveis: ['nome', 'numero', 'empresa', 'link'] },
  { key: 'boleto.gerado',      label: 'Boleto gerado',              variaveis: ['nome', 'valor', 'vencimento', 'empresa', 'link'] },
  { key: 'manual',             label: 'Mensagem manual',            variaveis: ['nome', 'empresa'] }
];

const TEMPLATES_PADRAO = {
  'cobranca.atrasada':
    'Olá {{nome}}! 👋\n\nIdentificamos um pagamento em atraso de *{{valor}}* há {{dias}} dia(s).\n\nPor favor, entre em contato com *{{empresa}}* para regularizar. Evite juros!\n\n_Mensagem automática — LF ERP_',
  'cobranca.vencendo':
    'Olá {{nome}}! ⏰\n\nLembrete: você tem uma parcela de *{{valor}}* vencendo em *{{vencimento}}* com *{{empresa}}*.\n\nEvite atraso realizando o pagamento até a data.\n\n_Mensagem automática — LF ERP_',
  'venda.confirmada':
    'Obrigado, {{nome}}! 🛍️\n\nSua compra de *{{valor}}* em *{{empresa}}* foi registrada com sucesso.\n\nQualquer dúvida, estamos à disposição!',
  'pedido.criado':
    '✅ Pedido *#{{numero}}* recebido!\n\nOlá {{nome}}, seu pedido de *{{valor}}* foi registrado em *{{empresa}}*.\n\nAvisaremos assim que for separado.',
  'nfe.emitida':
    '📄 Sua Nota Fiscal nº *{{numero}}* foi emitida por *{{empresa}}*.\n\nAcesse o documento: {{link}}',
  'boleto.gerado':
    '🔔 Boleto gerado!\n\nOlá {{nome}}, seu boleto de *{{valor}}* vence em *{{vencimento}}*.\n\nLink para pagamento: {{link}}\n\n*{{empresa}}*',
  'manual': 'Olá {{nome}}, mensagem de *{{empresa}}*.'
};

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, hoje, requirePermissao }) {
  const router = require('express').Router();


  async function emp(req)                 { return validarAcessoEmpresa(req, null, req.empresa_id); }

  async function getCfg(empresaId) {
    const r = await pool.query(`SELECT * FROM alertas_config WHERE empresa_id = $1`, [empresaId]);
    return r.rows[0] || null;
  }

  // ── Config ────────────────────────────────────────────────────────────────

  router.get('/config', auth, requirePermissao(pool, 'whatsapp', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');
      const cfg = await getCfg(e.id);
      return ok(res, {
        config: cfg ? {
          wpp_provider:   cfg.wpp_provider  || 'link',
          wpp_api_url:    cfg.wpp_api_url   || null,
          wpp_instance:   cfg.wpp_instance  || null,
          wpp_token:      cfg.wpp_token     ? '***configurado***' : null,
          wpp_numero:     cfg.wpp_numero    || null,
          wpp_ativo:      Boolean(cfg.wpp_ativo),
          wpp_cooldown_h: cfg.wpp_cooldown_h || 24
        } : null,
        eventos: EVENTOS
      });
    } catch (err) {
      return erro(res, 500, 'Erro ao buscar configuração');
    }
  });

  router.put('/config', auth, writeRateLimiter, requirePermissao(pool, 'whatsapp', 'editar'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { wpp_provider, wpp_api_url, wpp_instance, wpp_token, wpp_numero, wpp_ativo, wpp_cooldown_h } = req.body;

      if (wpp_api_url) {
        try {
          const parsedUrl = new URL(wpp_api_url);
          if (!(await validarHostExterno(parsedUrl.hostname))) {
            return erro(res, 400, 'URL de API não permitida');
          }
        } catch {
          return erro(res, 400, 'URL de API inválida');
        }
      }

      await pool.query(
        `INSERT INTO alertas_config (empresa_id, wpp_provider, wpp_api_url, wpp_instance, wpp_token, wpp_numero, wpp_ativo, wpp_cooldown_h)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (empresa_id) DO UPDATE SET
           wpp_provider   = $2,
           wpp_api_url    = COALESCE(NULLIF($3,''), alertas_config.wpp_api_url),
           wpp_instance   = COALESCE(NULLIF($4,''), alertas_config.wpp_instance),
           wpp_token      = COALESCE(NULLIF($5,'***configurado***'), alertas_config.wpp_token),
           wpp_numero     = COALESCE(NULLIF($6,''), alertas_config.wpp_numero),
           wpp_ativo      = $7,
           wpp_cooldown_h = COALESCE($8, alertas_config.wpp_cooldown_h)`,
        [
          e.id,
          wpp_provider || 'link',
          wpp_api_url  || null,
          wpp_instance || null,
          wpp_token    || null,
          wpp_numero   || null,
          Boolean(wpp_ativo),
          wpp_cooldown_h ? Number(wpp_cooldown_h) : null
        ]
      );

      return ok(res, { mensagem: 'Configuração salva' });
    } catch (err) {
      console.error('[whatsapp] PUT config:', err.message);
      return erro(res, 500, 'Erro ao salvar configuração');
    }
  });

  // ── Testar conexão ────────────────────────────────────────────────────────

  router.post('/testar', auth, writeRateLimiter, requirePermissao(pool, 'whatsapp', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');
      const cfg = await getCfg(e.id);
      if (!cfg?.wpp_numero) return erro(res, 400, 'Configure o número WhatsApp antes de testar');

      const resultado = await enviarMensagem({
        cfg,
        telefone: cfg.wpp_numero,
        mensagem: `✅ Teste de conexão do *${e.nome}* via LF ERP. Se recebeu esta mensagem, a integração está funcionando!`
      });

      if (resultado.status === 'link') {
        return ok(res, { mensagem: 'Nenhuma API configurada. Abra o link para testar manualmente.', link: resultado.link });
      }
      if (!resultado.sucesso) return erro(res, 400, resultado.erro || 'Falha no envio');
      return ok(res, { mensagem: 'Mensagem de teste enviada com sucesso!' });
    } catch (err) {
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Templates ─────────────────────────────────────────────────────────────

  router.get('/templates', auth, requirePermissao(pool, 'whatsapp', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT * FROM whatsapp_templates WHERE empresa_id = $1`,
        [e.id]
      );

      // Mescla templates customizados com os padrão
      const customMap = {};
      for (const row of result.rows) customMap[row.evento] = row;

      const templates = EVENTOS.map((ev) => ({
        evento:    ev.key,
        label:     ev.label,
        variaveis: ev.variaveis,
        mensagem:  customMap[ev.key]?.mensagem || TEMPLATES_PADRAO[ev.key] || '',
        ativo:     customMap[ev.key] ? Boolean(customMap[ev.key].ativo) : true,
        customizado: Boolean(customMap[ev.key])
      }));

      return ok(res, { templates });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar templates');
    }
  });

  router.put('/templates/:evento', auth, writeRateLimiter, requirePermissao(pool, 'whatsapp', 'editar'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { evento } = req.params;
      if (!EVENTOS.find((ev) => ev.key === evento)) return erro(res, 400, 'Evento inválido');

      const { mensagem, ativo } = req.body;
      if (!mensagem?.trim()) return erro(res, 400, 'Mensagem é obrigatória');

      await pool.query(
        `INSERT INTO whatsapp_templates (empresa_id, evento, mensagem, ativo, atualizado_em)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (empresa_id, evento) DO UPDATE SET mensagem = $3, ativo = $4, atualizado_em = NOW()`,
        [e.id, evento, mensagem.trim(), ativo !== false]
      );

      return ok(res, { mensagem: 'Template salvo' });
    } catch (err) {
      return erro(res, 500, 'Erro ao salvar template');
    }
  });

  // ── Envio manual ──────────────────────────────────────────────────────────

  router.post('/enviar', auth, writeRateLimiter, requirePermissao(pool, 'whatsapp', 'criar'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { telefone, mensagem, cliente_id, cliente_nome, evento = 'manual' } = req.body;
      if (!telefone?.trim() || !mensagem?.trim()) return erro(res, 400, 'telefone e mensagem são obrigatórios');

      const cfg = await getCfg(e.id);
      const resultado = await enviarMensagem({ cfg, telefone, mensagem });

      await pool.query(
        `INSERT INTO whatsapp_envios (empresa_id, evento, cliente_id, cliente_nome, telefone, mensagem, status, erro_msg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [e.id, evento, cliente_id || null, cliente_nome || null, telefone, mensagem, resultado.status, resultado.erro || null]
      );

      return ok(res, { ...resultado });
    } catch (err) {
      console.error('[whatsapp] POST enviar:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Processar cobranças automáticas ───────────────────────────────────────

  router.post('/processar/cobrancas', auth, writeRateLimiter, requirePermissao(pool, 'whatsapp', 'criar'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const cfg = await getCfg(e.id);
      if (!cfg?.wpp_ativo) return erro(res, 400, 'WhatsApp não está ativo nas configurações');

      const hojeStr    = hoje();
      const cooldownH  = cfg.wpp_cooldown_h || 24;
      const diasAviso  = Number(req.body.dias_aviso  ?? 3);   // avisar N dias antes do vencimento
      const diasAtraso = Number(req.body.dias_atraso ?? 1);   // cobrar com N dias de atraso

      // Busca templates ativos
      const tplResult = await pool.query(
        `SELECT * FROM whatsapp_templates WHERE empresa_id = $1 AND ativo = true`,
        [e.id]
      );
      const tplMap = {};
      for (const t of tplResult.rows) tplMap[t.evento] = t.mensagem;

      const resumo = { atrasadas: 0, vencendo: 0, erros: 0, links: 0 };

      // ── 1. Cobranças atrasadas ────────────────────────────────────────────
      const atrasadasResult = await pool.query(
        `SELECT cr.id, cr.cliente_id, cr.cliente_nome, cr.valor, cr.data_vencimento,
                c.telefone,
                CURRENT_DATE - cr.data_vencimento::date AS dias_atraso
         FROM contas_receber cr
         LEFT JOIN clientes c ON c.id = cr.cliente_id AND c.empresa_id = cr.empresa_id
         WHERE cr.empresa_id = $1
           AND LOWER(COALESCE(cr.status,'pendente')) NOT IN ('pago','cancelado')
           AND cr.data_vencimento::date < $2::date
           AND CURRENT_DATE - cr.data_vencimento::date >= $3
           AND c.telefone IS NOT NULL AND c.telefone != ''
           AND NOT EXISTS (
             SELECT 1 FROM whatsapp_envios we
             WHERE we.empresa_id = $1 AND we.cliente_id = cr.cliente_id
               AND we.evento = 'cobranca.atrasada'
               AND we.status IN ('enviado','link')
               AND we.criado_em > NOW() - ($4::text || ' hours')::interval
           )`,
        [e.id, hojeStr, diasAtraso, cooldownH]
      );

      for (const conta of atrasadasResult.rows) {
        const vars = {
          nome: conta.cliente_nome || 'Cliente',
          valor: Number(conta.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
          dias: String(conta.dias_atraso || 0),
          empresa: e.nome
        };
        const msg = aplicarTemplate(tplMap['cobranca.atrasada'] || TEMPLATES_PADRAO['cobranca.atrasada'], vars);
        const resultado = await enviarMensagem({ cfg, telefone: conta.telefone, mensagem: msg });

        await pool.query(
          `INSERT INTO whatsapp_envios (empresa_id, evento, cliente_id, cliente_nome, telefone, mensagem, status, erro_msg, referencia_id, referencia_tipo)
           VALUES ($1,'cobranca.atrasada',$2,$3,$4,$5,$6,$7,$8,'conta_receber')`,
          [e.id, conta.cliente_id, conta.cliente_nome, conta.telefone, msg, resultado.status, resultado.erro || null, conta.id]
        );

        if (resultado.status === 'enviado') resumo.atrasadas++;
        else if (resultado.status === 'link') resumo.links++;
        else resumo.erros++;
      }

      // ── 2. Vencimentos próximos ───────────────────────────────────────────
      const vencendoResult = await pool.query(
        `SELECT cr.id, cr.cliente_id, cr.cliente_nome, cr.valor, cr.data_vencimento,
                c.telefone
         FROM contas_receber cr
         LEFT JOIN clientes c ON c.id = cr.cliente_id AND c.empresa_id = cr.empresa_id
         WHERE cr.empresa_id = $1
           AND LOWER(COALESCE(cr.status,'pendente')) NOT IN ('pago','cancelado')
           AND cr.data_vencimento::date BETWEEN $2::date AND $2::date + ($3 || ' days')::interval
           AND c.telefone IS NOT NULL AND c.telefone != ''
           AND NOT EXISTS (
             SELECT 1 FROM whatsapp_envios we
             WHERE we.empresa_id = $1 AND we.cliente_id = cr.cliente_id
               AND we.evento = 'cobranca.vencendo'
               AND we.status IN ('enviado','link')
               AND we.criado_em > NOW() - ($4::text || ' hours')::interval
           )`,
        [e.id, hojeStr, diasAviso, cooldownH]
      );

      for (const conta of vencendoResult.rows) {
        const dtVenc = String(conta.data_vencimento).substring(0, 10);
        const [y, m, d] = dtVenc.split('-');
        const vars = {
          nome: conta.cliente_nome || 'Cliente',
          valor: Number(conta.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
          vencimento: `${d}/${m}/${y}`,
          empresa: e.nome
        };
        const msg = aplicarTemplate(tplMap['cobranca.vencendo'] || TEMPLATES_PADRAO['cobranca.vencendo'], vars);
        const resultado = await enviarMensagem({ cfg, telefone: conta.telefone, mensagem: msg });

        await pool.query(
          `INSERT INTO whatsapp_envios (empresa_id, evento, cliente_id, cliente_nome, telefone, mensagem, status, erro_msg, referencia_id, referencia_tipo)
           VALUES ($1,'cobranca.vencendo',$2,$3,$4,$5,$6,$7,$8,'conta_receber')`,
          [e.id, conta.cliente_id, conta.cliente_nome, conta.telefone, msg, resultado.status, resultado.erro || null, conta.id]
        );

        if (resultado.status === 'enviado') resumo.vencendo++;
        else if (resultado.status === 'link') resumo.links++;
        else resumo.erros++;
      }

      return ok(res, {
        mensagem: `Processamento concluído. Atrasadas: ${resumo.atrasadas}, Vencendo: ${resumo.vencendo}, Links: ${resumo.links}, Erros: ${resumo.erros}`,
        resumo
      });
    } catch (err) {
      console.error('[whatsapp] processar/cobrancas:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Histórico ─────────────────────────────────────────────────────────────

  router.get('/historico', auth, requirePermissao(pool, 'whatsapp', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { evento, status } = req.query;
      const EVENTOS_WPP_VALIDOS = EVENTOS.map((ev) => ev.key);
      const STATUS_WPP_VALIDOS  = ['enviado', 'link', 'erro', 'pendente', 'falhou'];
      const params = [e.id];
      let where = `WHERE empresa_id = $1`;
      if (evento && EVENTOS_WPP_VALIDOS.includes(evento)) { params.push(evento); where += ` AND evento = $${params.length}`; }
      if (status && STATUS_WPP_VALIDOS.includes(status))  { params.push(status); where += ` AND status = $${params.length}`; }

      const result = await pool.query(
        `SELECT * FROM whatsapp_envios ${where} ORDER BY criado_em DESC LIMIT 200`,
        params
      );

      return ok(res, { historico: result.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao buscar histórico');
    }
  });

  return router;
};
