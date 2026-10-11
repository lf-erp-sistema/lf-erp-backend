/**
 * Links de Pagamento / Checkout Online — LF ERP
 * Gera links públicos de cobrança com PIX e/ou Boleto.
 *
 * (Autenticado)
 *   GET    /checkout                   — listar links da empresa
 *   POST   /checkout                   — criar novo link
 *   PATCH  /checkout/:id/pago          — marcar como pago manualmente
 *   PATCH  /checkout/:id/cancelar      — cancelar link
 *   GET    /checkout/dashboard         — KPIs
 *
 * (Público — sem auth)
 *   GET    /checkout/p/:token          — dados do checkout (para a página pública)
 *   POST   /checkout/p/:token/boleto   — gera boleto Asaas para este link
 *   POST   /checkout/p/:token/webhook  — callback Asaas (confirmação de pagamento)
 */

const crypto = require('crypto');
const { gerarPixCopiaCola } = require('../utils/pix');
const { resolverClienteAsaas, criarBoleto } = require('../utils/asaas');
const { decryptField } = require('../utils/pixCrypto');
const { requirePermissao } = require('../utils/permissoes');
const { erro, ok } = require('../utils/routeHelpers');
const { createSharedRateLimiter } = require('../utils/sharedRateLimiter');

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, hoje }) {
  const router = require('express').Router();


  async function emp(req)               { return validarAcessoEmpresa(req, null, req.empresa_id); }

  function gerarToken() {
    return crypto.randomBytes(12).toString('hex');
  }

  async function getCfgEmpresa(empresaId) {
    const r = await pool.query(
      `SELECT nome_empresa AS nome, pix_chave, cidade,
              asaas_api_key, asaas_sandbox
       FROM configuracoes WHERE empresa_id = $1`,
      [empresaId]
    );
    return r.rows[0] || null;
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  router.get('/dashboard', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pendente') AS pendentes,
           COUNT(*) FILTER (WHERE status = 'pago')     AS pagos,
           COUNT(*) FILTER (WHERE status = 'expirado' OR (expira_em IS NOT NULL AND expira_em < NOW() AND status = 'pendente')) AS expirados,
           COALESCE(SUM(valor) FILTER (WHERE status = 'pago'), 0) AS total_recebido,
           COALESCE(SUM(valor) FILTER (WHERE status = 'pendente'), 0) AS total_pendente
         FROM checkout_links WHERE empresa_id = $1`,
        [e.id]
      );

      const r = result.rows[0];
      return ok(res, {
        pendentes:       Number(r.pendentes),
        pagos:           Number(r.pagos),
        expirados:       Number(r.expirados),
        total_recebido:  Number(r.total_recebido),
        total_pendente:  Number(r.total_pendente)
      });
    } catch (err) {
      return erro(res, 500, 'Erro ao carregar dashboard');
    }
  });

  // ── Listar links ──────────────────────────────────────────────────────────

  router.get('/', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT id, token, descricao, valor, status, cliente_nome, metodo_pago,
                expira_em, pago_em, criado_em
         FROM checkout_links WHERE empresa_id = $1
         ORDER BY criado_em DESC LIMIT 200`,
        [e.id]
      );
      return ok(res, { links: result.rows });
    } catch (err) { return erro(res, 500, 'Erro ao listar links'); }
  });

  // ── Criar link ────────────────────────────────────────────────────────────

  router.post('/', auth, requirePermissao(pool, 'financeiro', 'criar'), writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { descricao, valor, cliente_nome, cliente_email, cliente_telefone, validade_dias, observacoes } = req.body;
      if (!descricao?.trim() || !valor) return erro(res, 400, 'descricao e valor são obrigatórios');

      const valorFinal = normalizarDecimal(valor);
      if (valorFinal <= 0) return erro(res, 400, 'Valor deve ser maior que zero');

      const cfg = await getCfgEmpresa(e.id);

      // Gera PIX Copia e Cola se a empresa tem chave PIX configurada
      let pixCopiaCola = null;
      const token = gerarToken();

      if (cfg?.pix_chave) {
        pixCopiaCola = gerarPixCopiaCola({
          chave:    cfg.pix_chave,
          valor:    valorFinal,
          nome:     cfg.nome || e.nome,
          cidade:   cfg.cidade || 'SAO PAULO',
          txid:     token.substring(0, 25),
          descricao: descricao.trim().substring(0, 72)
        });
      }

      const expiraEm = validade_dias
        ? new Date(Date.now() + normalizarInt(validade_dias) * 86_400_000).toISOString()
        : null;

      const result = await pool.query(
        `INSERT INTO checkout_links
           (empresa_id, token, descricao, valor, cliente_nome, cliente_email, cliente_telefone,
            pix_copia_cola, expira_em, observacoes, criado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          e.id, token, descricao.trim(), valorFinal,
          cliente_nome?.trim() || null,
          cliente_email?.trim() || null,
          cliente_telefone?.trim() || null,
          pixCopiaCola,
          expiraEm,
          observacoes?.trim() || null,
          req.user.id
        ]
      );

      const link = result.rows[0];

      return res.status(201).json({
        sucesso: true,
        link: {
          ...link,
          url_checkout: `/checkout.html#${token}`
        }
      });
    } catch (err) {
      console.error('[checkout] POST:', err.message);
      return erro(res, 500, 'Erro ao criar link de pagamento');
    }
  });

  // ── Marcar pago manualmente ───────────────────────────────────────────────

  router.patch('/:id/pago', auth, requirePermissao(pool, 'financeiro', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      // Verifica estado terminal antes de atualizar
      const checkoutAtual = await pool.query(
        `SELECT status FROM checkout_links WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), e.id]
      );
      if (!checkoutAtual.rows[0]) return erro(res, 404, 'Link não encontrado');
      if (['cancelado', 'estornado'].includes(checkoutAtual.rows[0].status)) {
        return res.status(409).json({ erro: 'Checkout em estado terminal não pode ser alterado' });
      }

      const r = await pool.query(
        `UPDATE checkout_links SET status = 'pago', pago_em = NOW() AT TIME ZONE 'America/Fortaleza', metodo_pago = COALESCE($1, metodo_pago), atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
         WHERE id = $2 AND empresa_id = $3 RETURNING *`,
        [req.body.metodo || null, Number(req.params.id), e.id]
      );
      if (r.rowCount === 0) return erro(res, 404, 'Link não encontrado');
      return ok(res, { link: r.rows[0] });
    } catch (err) { return erro(res, 500, 'Erro ao marcar como pago'); }
  });

  // ── Cancelar link ─────────────────────────────────────────────────────────

  router.patch('/:id/cancelar', auth, requirePermissao(pool, 'financeiro', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const check = await pool.query(
        `SELECT status FROM checkout_links WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), e.id]
      );
      if (!check.rows[0]) return erro(res, 404, 'Checkout não encontrado');
      const { status } = check.rows[0];
      if (['cancelado', 'expirado', 'pago'].includes(status)) {
        return erro(res, 400, `Checkout não pode ser cancelado no status "${status}"`);
      }

      const r = await pool.query(
        `UPDATE checkout_links SET status = 'cancelado', atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza' WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), e.id]
      );
      if (r.rowCount === 0) return erro(res, 404, 'Link não encontrado');
      return ok(res, { mensagem: 'Link cancelado' });
    } catch (err) { return erro(res, 500, 'Erro ao cancelar'); }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ROTAS PÚBLICAS (sem autenticação)
  // ═════════════════════════════════════════════════════════════════════════

  // ── Rate limiter por IP para a página pública de checkout (30 req/min) ────
  // Protege contra varredura/enumeração de tokens de pagamento
  const checkoutPublicoRateLimiter = createSharedRateLimiter(pool).middleware({
    key: (req) => `checkout-public:${req.ip || req.connection?.remoteAddress || 'unknown'}`,
    windowMs: 60_000,
    limit: 30,
    message: 'Muitas requisições. Aguarde 1 minuto.',
  });

  // ── GET /checkout/p/:token — dados para a página pública ──────────────────

  router.get('/p/:token', checkoutPublicoRateLimiter, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT cl.*, e.nome AS empresa_nome, cfg.cidade AS empresa_cidade,
                cfg.asaas_api_key IS NOT NULL AS tem_asaas
         FROM checkout_links cl
         JOIN empresas e ON e.id = cl.empresa_id
         LEFT JOIN configuracoes cfg ON cfg.empresa_id = cl.empresa_id
         WHERE cl.token = $1`,
        [req.params.token]
      );

      if (result.rowCount === 0) return erro(res, 404, 'Link não encontrado');

      const link = result.rows[0];

      // Verifica expiração
      if (link.expira_em && new Date(link.expira_em) < new Date()) {
        await pool.query(`UPDATE checkout_links SET status = 'expirado' WHERE token = $1 AND status = 'pendente'`, [req.params.token]);
        return erro(res, 410, 'Este link expirou');
      }

      if (link.status === 'cancelado') return erro(res, 410, 'Este link foi cancelado');

      return res.json({
        sucesso: true,
        checkout: {
          token:          link.token,
          descricao:      link.descricao,
          valor:          Number(link.valor),
          status:         link.status,
          cliente_nome:   link.cliente_nome,
          pix_copia_cola: link.pix_copia_cola,
          boleto_url:     link.boleto_url,
          boleto_linha:   link.boleto_linha,
          pago_em:        link.pago_em,
          expira_em:      link.expira_em,
          empresa_nome:   link.empresa_nome,
          tem_asaas:      Boolean(link.tem_asaas),
          tem_pix:        Boolean(link.pix_copia_cola)
        }
      });
    } catch (err) {
      console.error('[checkout] GET público:', err.message);
      return erro(res, 500, 'Erro ao carregar checkout');
    }
  });

  // ── POST /checkout/p/:token/boleto — gera boleto Asaas ───────────────────

  router.post('/p/:token/boleto', checkoutPublicoRateLimiter, async (req, res) => {
    let client;
    try {
      // Serializes generation per link and prevents duplicate Asaas charges.
      client = await pool.connect();
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT cl.*, e.nome AS empresa_nome,
                cfg.asaas_api_key, cfg.asaas_sandbox
         FROM checkout_links cl
         JOIN empresas e ON e.id = cl.empresa_id
         LEFT JOIN configuracoes cfg ON cfg.empresa_id = cl.empresa_id
         WHERE cl.token = $1 AND cl.status = 'pendente'
         FOR UPDATE OF cl`,
        [req.params.token]
      );

      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Link não encontrado ou já pago');
      }

      const link = result.rows[0];

      if (link.boleto_url) {
        await client.query('COMMIT');
        return ok(res, { boleto_url: link.boleto_url, boleto_linha: link.boleto_linha });
      }

      if (!link.asaas_api_key) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Boleto não disponível para este link');
      }

      const apiKey  = decryptField(link.asaas_api_key);
      const sandbox = link.asaas_sandbox !== false;

      const { nome, email, telefone } = req.body;
      const clienteId = await resolverClienteAsaas(apiKey, sandbox, {
        nome:     nome || link.cliente_nome || 'Cliente',
        cpfCnpj:  null,
        email:    email || link.cliente_email || null,
        telefone: telefone || link.cliente_telefone || null
      });

      const venc = new Date(Date.now() + 3 * 86_400_000).toISOString().substring(0, 10);

      const boleto = await criarBoleto(apiKey, sandbox, {
        customerId:        clienteId,
        valor:             link.valor,
        vencimento:        venc,
        descricao:         link.descricao,
        externalReference: link.token
      });

      await client.query(
        `UPDATE checkout_links SET boleto_url = $1, boleto_linha = $2, asaas_payment_id = $3, atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza' WHERE token = $4`,
        [boleto.invoiceUrl || boleto.bankSlipUrl, boleto.linhaDigitavel, boleto.id, link.token]
      );

      await client.query('COMMIT');

      return ok(res, {
        boleto_url:   boleto.invoiceUrl || boleto.bankSlipUrl,
        boleto_linha: boleto.linhaDigitavel
      });
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) { /* transação já encerrada */ }
      }
      console.error('[checkout] POST boleto:', err.message);
      return erro(res, 500, 'Erro ao gerar boleto');
    } finally {
      client?.release();
    }
  });

  // ── POST /checkout/webhook — Asaas confirma pagamento (rota global, usa externalReference) ────
  // O Asaas envia para um único URL configurado na conta; identifica o checkout via payment.externalReference

  router.post('/webhook', async (req, res) => {
    try {
      const _webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;
      if (!_webhookToken) {
        console.error('[checkout-webhook] ASAAS_WEBHOOK_TOKEN não configurado — rejeitando webhook');
        return res.status(503).json({ erro: 'Webhook não configurado no servidor' });
      }
      const _headerToken = req.headers['asaas-access-token'] || '';
      const lenA = Buffer.byteLength(_webhookToken);
      const lenB = Buffer.byteLength(_headerToken);
      const maxLen = Math.max(lenA, lenB);
      const _bufA = Buffer.concat([Buffer.from(_webhookToken), Buffer.alloc(Math.max(0, maxLen - lenA))]);
      const _bufB = Buffer.concat([Buffer.from(_headerToken),  Buffer.alloc(Math.max(0, maxLen - lenB))]);
      if (lenA !== lenB || !crypto.timingSafeEqual(_bufA, _bufB)) {
        console.warn('[checkout-webhook] Token Asaas invalido — rejeitado IP:', req.ip);
        return res.status(401).json({ erro: 'Unauthorized' });
      }

      const { event, payment } = req.body;
      const token = payment?.externalReference;

      if (token && (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED')) {
        await pool.query(
          `UPDATE checkout_links SET status = 'pago', pago_em = NOW() AT TIME ZONE 'America/Fortaleza',
           metodo_pago = 'boleto', atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
           WHERE token = $1 AND status = 'pendente'`,
          [token]
        );
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[checkout] webhook:', err.message);
      res.json({ ok: true });
    }
  });

  return router;
};
