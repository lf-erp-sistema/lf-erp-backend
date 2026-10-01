/**
 * Marketplace — LF ERP
 * Integração com Mercado Livre e Shopee.
 * Sincroniza estoque de produtos e recebe pedidos.
 *
 * Rotas:
 *   GET    /marketplace/config          — configurações das plataformas
 *   PUT    /marketplace/config          — salvar App ID / Secret
 *   GET    /marketplace/oauth/callback  — recebe code OAuth2 (ML/Shopee)
 *   GET    /marketplace/oauth/url       — gera URL de autorização
 *   POST   /marketplace/sync-estoque    — sincroniza estoque de um produto
 *   GET    /marketplace/produtos         — lista produtos vinculados
 *   POST   /marketplace/vincular        — vincula produto LF ERP ↔ listing
 *   DELETE /marketplace/vincular/:id    — remove vínculo
 *   POST   /marketplace/webhook/:plataforma — recebe notificações (pedidos)
 */

const https = require('https');
const crypto = require('crypto');
const { erro, ok } = require('../utils/routeHelpers');
const { requirePermissao } = require('../utils/permissoes');
const { encryptField, decryptField } = require('../utils/pixCrypto');

function safeDecrypt(v) {
  if (!v) return v;
  try { return decryptField(v); } catch { return v; }
}

// Rate limiter por IP para o endpoint de webhook (sem auth JWT)
const _webhookIpMap = new Map();
const WEBHOOK_MAX = 60;       // 60 notificações por janela
const WEBHOOK_WINDOW = 60000; // 1 minuto

function webhookRateLimit(req, res, next) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  const now = Date.now();
  const entry = _webhookIpMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > WEBHOOK_WINDOW) { entry.count = 1; entry.start = now; }
  else entry.count += 1;
  if (_webhookIpMap.size > 2000) {
    for (const [k, v] of _webhookIpMap) { if (now - v.start > WEBHOOK_WINDOW) _webhookIpMap.delete(k); }
  }
  _webhookIpMap.set(ip, entry);
  if (entry.count > WEBHOOK_MAX) { res.status(429).json({ error: 'Too many requests' }); return; }
  next();
}

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, normalizarDataISO, hoje, registrarMovimentacaoEstoque, criarParcelasContasReceber }) {
  const router = require('express').Router();



  const ML_BASE = 'https://api.mercadolibre.com';
  const ML_AUTH = 'https://auth.mercadolivre.com.br/authorization';
  const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
  const PLATAFORMAS_VALIDAS = ['mercadolivre', 'shopee'];
  const ML_TIMEOUT_MS = 15000;

  async function mlTokenFetch(url, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      return res;
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error(`ML token: timeout (${ML_TIMEOUT_MS}ms)`);
        e.code = 'ML_TOKEN_TIMEOUT';
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function apiGet(url, token) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const opts = {
        hostname: u.hostname, path: u.pathname + u.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      };
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { clearTimeout(timer); try { resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(data) }); } catch { resolve({ ok: false, status: res.statusCode, data }); } });
      });
      const timer = setTimeout(() => req.destroy(new Error(`ML API: timeout ${ML_TIMEOUT_MS}ms`)), ML_TIMEOUT_MS);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }

  async function apiPost(url, token, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const bodyStr = JSON.stringify(body);
      const opts = {
        hostname: u.hostname, path: u.pathname + u.search,
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
      };
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { clearTimeout(timer); try { resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(data) }); } catch { resolve({ ok: false, status: res.statusCode, data }); } });
      });
      const timer = setTimeout(() => req.destroy(new Error(`ML API: timeout ${ML_TIMEOUT_MS}ms`)), ML_TIMEOUT_MS);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.write(bodyStr);
      req.end();
    });
  }

  async function getConfig(empresaId, plataforma) {
    const r = await pool.query(
      `SELECT * FROM marketplace_config WHERE empresa_id = $1 AND plataforma = $2`,
      [empresaId, plataforma]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      ...row,
      access_token:  safeDecrypt(row.access_token),
      refresh_token: safeDecrypt(row.refresh_token),
      client_secret: safeDecrypt(row.client_secret)
    };
  }

  async function refreshMlToken(cfg, empresaId) {
    if (!cfg.refresh_token || !cfg.app_id || !cfg.client_secret) return null;
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: cfg.app_id,
        client_secret: cfg.client_secret,
        refresh_token: cfg.refresh_token
      });
      const res = await mlTokenFetch(ML_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      const data = await res.json();
      if (!res.ok || !data.access_token) return null;

      await pool.query(
        `UPDATE marketplace_config SET
           access_token = $1, refresh_token = $2,
           token_expires_at = NOW() + INTERVAL '6 hours',
           atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
         WHERE empresa_id = $3 AND plataforma = 'mercadolivre'`,
        [encryptField(data.access_token), encryptField(data.refresh_token || cfg.refresh_token), empresaId]
      );
      return data.access_token;
    } catch { return null; }
  }

  async function getMlToken(empresaId) {
    const cfg = await getConfig(empresaId, 'mercadolivre');
    if (!cfg?.access_token) return null;

    // Se expirado, tenta renovar
    if (cfg.token_expires_at && new Date(cfg.token_expires_at) < new Date()) {
      return refreshMlToken(cfg, empresaId);
    }
    return cfg.access_token;
  }

  // ── Processar pedido ML ────────────────────────────────────────────────────
  // Cria uma venda no LF ERP a partir de um pedido do Mercado Livre.
  // Idempotente: pedidos já processados são ignorados silenciosamente.
  async function processarPedidoML({ orderId, empresaId, empresaNome, token }) {
    // 1. Idempotência
    const jaProcessado = await pool.query(
      `SELECT id, venda_id FROM marketplace_pedidos WHERE plataforma = 'mercadolivre' AND pedido_externo = $1 AND empresa_id = $2`,
      [String(orderId), empresaId]
    );
    if (jaProcessado.rowCount > 0) {
      return { jaProcessado: true, vendaId: jaProcessado.rows[0].venda_id };
    }

    // 2. Buscar pedido completo na ML API
    const mlRes = await apiGet(`${ML_BASE}/orders/${orderId}`, token);
    if (!mlRes.ok) throw new Error(`ML API /orders/${orderId}: ${JSON.stringify(mlRes.data)}`);
    const order = mlRes.data;

    // Só processa pedidos efetivamente pagos
    const STATUS_PROCESSAVEIS = ['paid', 'confirmed'];
    if (!STATUS_PROCESSAVEIS.includes(order.status)) {
      console.log(`[marketplace] pedido ML #${orderId} status="${order.status}" — aguardando pagamento`);
      return { aguardando: true, status: order.status };
    }

    // 3. Mapear itens do ML → produtos LF ERP
    const itensVenda = [];
    for (const oi of (order.order_items || [])) {
      const listingId = oi.item?.id;
      if (!listingId) continue;

      const vinculo = await pool.query(
        `SELECT produto_id FROM marketplace_produtos WHERE listing_id = $1 AND empresa_id = $2`,
        [listingId, empresaId]
      );
      if (vinculo.rowCount === 0) {
        console.warn(`[marketplace] listing ${listingId} não mapeado para empresa ${empresaId} — item ignorado`);
        continue;
      }

      itensVenda.push({
        produto_id: vinculo.rows[0].produto_id,
        quantidade: normalizarInt(oi.quantity) || 1,
        preco_unitario: normalizarDecimal(oi.unit_price)
      });
    }

    if (itensVenda.length === 0) {
      await pool.query(
        `INSERT INTO marketplace_pedidos (empresa_id, plataforma, pedido_externo, status, dados_raw)
         VALUES ($1, 'mercadolivre', $2, 'sem_produtos', $3)
         ON CONFLICT (plataforma, pedido_externo) DO NOTHING`,
        [empresaId, String(orderId), JSON.stringify(order)]
      );
      return { semProdutos: true };
    }

    // 4. Resolver cliente
    const buyer = order.buyer || {};
    const buyerNome = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() || buyer.nickname || 'ML Cliente';

    let clienteId = null;
    if (buyer.email) {
      const cr = await pool.query(
        `SELECT id FROM clientes WHERE email = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL LIMIT 1`,
        [buyer.email, empresaId, empresaNome]
      );
      if (cr.rowCount > 0) clienteId = cr.rows[0].id;
    }

    // 5. Preparar dados da venda
    const totalVenda   = Number(order.total_amount || 0);
    const dataVenda    = normalizarDataISO((order.date_created || '').substring(0, 10)) || hoje();
    const observacao   = `Pedido ML #${orderId}`;
    const pagamentoStr = 'Mercado Livre';
    const pagamentosJson = JSON.stringify([{ forma: pagamentoStr, valor: totalVenda, parcelas: 1 }]);

    // 6. Transação
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Advisory lock por (empresa, pedido ML) — serializa chamadas simultâneas com o mesmo orderId
      // evitando criação de venda duplicada e débito duplo de estoque em race conditions
      const lockKey = parseInt(empresaId) * 1000000 + (parseInt(orderId) % 1000000);
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      // Re-verifica idempotência dentro da transação (cobertura de race condition)
      const jaProcessadoTx = await client.query(
        `SELECT id, venda_id FROM marketplace_pedidos WHERE plataforma = 'mercadolivre' AND pedido_externo = $1 AND empresa_id = $2`,
        [String(orderId), empresaId]
      );
      if (jaProcessadoTx.rowCount > 0) {
        await client.query('ROLLBACK');
        return { jaProcessado: true, vendaId: jaProcessadoTx.rows[0].venda_id };
      }

      // Buscar nome do cliente se vinculado
      let clienteNomeFinal = buyerNome;
      if (clienteId) {
        const cNome = await client.query(`SELECT nome FROM clientes WHERE id = $1`, [clienteId]);
        if (cNome.rowCount > 0) clienteNomeFinal = cNome.rows[0].nome;
      }

      // INSERT venda
      const vendaResult = await client.query(
        `INSERT INTO vendas
           (empresa, empresa_id, cliente_id, cliente_nome, subtotal, desconto, acrescimo, total,
            pagamento, pagamentos, parcelas, status_pagamento, data, observacao, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,0,0,$5,$6,$7,1,'pago',$8,$9,NOW(),NOW())
         RETURNING *`,
        [empresaNome, empresaId, clienteId, clienteNomeFinal,
         totalVenda, pagamentoStr, pagamentosJson, dataVenda, observacao]
      );
      const venda = vendaResult.rows[0];

      // INSERT itens + baixa de estoque
      for (const item of itensVenda) {
        const prodResult = await client.query(
          `SELECT * FROM produtos WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL`,
          [item.produto_id, empresaId, empresaNome]
        );
        if (prodResult.rowCount === 0) continue;

        const produto     = prodResult.rows[0];
        const qtd         = item.quantidade;
        // Dados da API do ML (number) e do banco (NUMERIC string): usar Number(), não normalizarDecimal.
        const precoUnit   = Number(item.preco_unitario || produto.preco || 0);
        const custoUnit   = Number(produto.custo || 0);
        const totalItem   = Number((qtd * precoUnit).toFixed(2));

        await client.query(
          `INSERT INTO venda_itens
             (venda_id, empresa, empresa_id, produto_id, produto_nome, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [venda.id, empresaNome, empresaId, produto.id, produto.nome, qtd, precoUnit, custoUnit, totalItem]
        );

        await client.query(
          `UPDATE produtos SET estoque = GREATEST(0, estoque - $1), atualizado_em = NOW()
           WHERE id = $2 AND empresa_id = $3`,
          [qtd, produto.id, empresaId]
        );

        await registrarMovimentacaoEstoque({
          client,
          empresa: empresaNome,
          empresa_id: empresaId,
          produto_id: produto.id,
          tipo: 'saida',
          quantidade: qtd,
          observacao,
          referencia_tipo: 'venda',
          referencia_id: venda.id,
          usuario_id: null
        });
      }

      // Registro de idempotência
      await client.query(
        `INSERT INTO marketplace_pedidos (empresa_id, plataforma, pedido_externo, status, venda_id, dados_raw)
         VALUES ($1, 'mercadolivre', $2, 'processado', $3, $4)
         ON CONFLICT (plataforma, pedido_externo) DO UPDATE SET status = 'processado', venda_id = $3`,
        [empresaId, String(orderId), venda.id, JSON.stringify(order)]
      );

      await client.query('COMMIT');
      return { vendaId: venda.id };
    } catch (err) {
      await client.query('ROLLBACK');
      // Registra erro para diagnóstico
      await pool.query(
        `INSERT INTO marketplace_pedidos (empresa_id, plataforma, pedido_externo, status, erro_msg, dados_raw)
         VALUES ($1, 'mercadolivre', $2, 'erro', $3, $4)
         ON CONFLICT (plataforma, pedido_externo) DO UPDATE SET status = 'erro', erro_msg = $3`,
        [empresaId, String(orderId), err.message, JSON.stringify(order)]
      ).catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  router.get('/config', auth, requirePermissao(pool, 'marketplace', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT plataforma, seller_id, app_id,
                CASE WHEN access_token IS NOT NULL THEN 'conectado' ELSE 'desconectado' END AS status_conexao,
                token_expires_at, ativo, atualizado_em
         FROM marketplace_config WHERE empresa_id = $1`,
        [empresaResolvida.id]
      );

      return ok(res, { plataformas: result.rows });
    } catch (err) {
      console.error('[marketplace] GET config:', err.message);
      return erro(res, 500, 'Erro ao buscar configuração');
    }
  });

  router.put('/config', auth, requirePermissao(pool, 'marketplace', 'configurar'), writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { plataforma, app_id, client_secret } = req.body;
      if (!plataforma || !app_id) return erro(res, 400, 'plataforma e app_id são obrigatórios');
      if (!PLATAFORMAS_VALIDAS.includes(plataforma)) return erro(res, 400, 'Plataforma inválida');

      const clientSecretFinal = !client_secret || client_secret === '***'
        ? null
        : encryptField(client_secret);
      await pool.query(
        `INSERT INTO marketplace_config (empresa_id, plataforma, app_id, client_secret)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (empresa_id, plataforma) DO UPDATE
         SET app_id = $3, client_secret = COALESCE($4, marketplace_config.client_secret),
             atualizado_em = NOW()`,
        [empresaResolvida.id, plataforma, app_id, clientSecretFinal]
      );

      return ok(res, { mensagem: 'Configuração salva. Agora faça a autorização OAuth.' });
    } catch (err) {
      console.error('[marketplace] PUT config:', err.message);
      return erro(res, 500, 'Erro ao salvar configuração');
    }
  });

  // ── OAuth ──────────────────────────────────────────────────────────────────

  router.get('/oauth/url', auth, requirePermissao(pool, 'marketplace', 'configurar'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { plataforma } = req.query;
      if (!PLATAFORMAS_VALIDAS.includes(plataforma)) return erro(res, 400, 'Plataforma inválida');
      const cfg = await getConfig(empresaResolvida.id, plataforma);
      if (!cfg?.app_id) return erro(res, 400, 'Configure o App ID antes de autorizar');

      const redirectUri = process.env.MARKETPLACE_REDIRECT_URI || `${process.env.BACKEND_URL || ''}/marketplace/oauth/callback`;
      const stateSecret = process.env.MARKETPLACE_STATE_SECRET;
      if (!stateSecret) {
        console.error('[marketplace] MARKETPLACE_STATE_SECRET não definido — OAuth desabilitado');
        return erro(res, 503, 'Integração ML não configurada: defina MARKETPLACE_STATE_SECRET no ambiente');
      }
      const statePayload = JSON.stringify({ empresa_id: empresaResolvida.id, plataforma, ts: Date.now() });
      const stateSig = crypto.createHmac('sha256', stateSecret).update(statePayload).digest('hex');
      const state = Buffer.from(JSON.stringify({ p: statePayload, s: stateSig })).toString('base64url');

      let url;
      if (plataforma === 'mercadolivre') {
        url = `${ML_AUTH}?response_type=code&client_id=${cfg.app_id}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
      } else {
        return erro(res, 400, `Plataforma '${plataforma}' não suportada ainda`);
      }

      return ok(res, { url });
    } catch (err) {
      console.error('[marketplace] GET oauth/url:', err.message);
      return erro(res, 500, 'Erro ao gerar URL OAuth');
    }
  });

  router.get('/oauth/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      if (!code || !state) return res.send('<h3>Parâmetros inválidos</h3>');

      let empresa_id, plataforma;
      try {
        const stateSecret = process.env.MARKETPLACE_STATE_SECRET;
        if (!stateSecret) {
          return res.send('<h3>Integração ML não configurada. Contate o suporte.</h3>');
        }
        const { p: statePayload, s: stateSig } = JSON.parse(Buffer.from(state, 'base64url').toString());
        const expectedSig = crypto.createHmac('sha256', stateSecret).update(statePayload).digest('hex');
        const bufA = Buffer.from(stateSig);
        const bufB = Buffer.from(expectedSig);
        if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) return res.send('<h3>State inválido ou adulterado</h3>');
        const parsed = JSON.parse(statePayload);
        if (Date.now() - parsed.ts > 15 * 60 * 1000) return res.send('<h3>Autorização expirada. Tente novamente.</h3>');
        empresa_id = parsed.empresa_id;
        plataforma = parsed.plataforma;
      } catch {
        return res.send('<h3>State malformado</h3>');
      }
      const cfg = await getConfig(empresa_id, plataforma);
      if (!cfg) return res.send('<h3>Configuração não encontrada</h3>');

      const redirectUri = process.env.MARKETPLACE_REDIRECT_URI || `${process.env.BACKEND_URL || ''}/marketplace/oauth/callback`;

      let accessToken, refreshToken, sellerId;

      if (plataforma === 'mercadolivre') {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: cfg.app_id,
          client_secret: cfg.client_secret,
          code,
          redirect_uri: redirectUri
        });
        const tokenRes = await mlTokenFetch(ML_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          const _escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          return res.send(`<h3>Erro na autenticação: ${_escHtml(JSON.stringify(tokenData))}</h3>`);
        }
        accessToken  = tokenData.access_token;
        refreshToken = tokenData.refresh_token;
        sellerId     = String(tokenData.user_id || '');
      }

      await pool.query(
        `UPDATE marketplace_config
         SET access_token = $1, refresh_token = $2, seller_id = $3,
             token_expires_at = NOW() + INTERVAL '6 hours', atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
         WHERE empresa_id = $4 AND plataforma = $5`,
        [encryptField(accessToken), encryptField(refreshToken), sellerId, empresa_id, plataforma]
      );

      res.send(`<h3>✅ Autorização concluída!</h3><p>Feche esta janela e volte ao LF ERP.</p><script>window.close();</script>`);
    } catch (err) {
      console.error('[marketplace] oauth callback:', err.message);
      res.send('<h3>Erro ao processar autorização. Tente novamente.</h3>');
    }
  });

  // ── Sync estoque ───────────────────────────────────────────────────────────

  router.post('/sync-estoque', auth, requirePermissao(pool, 'marketplace', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { produto_id, plataforma } = req.body;
      if (!produto_id || !plataforma) return erro(res, 400, 'produto_id e plataforma são obrigatórios');

      // Busca vínculo
      const vinculo = await pool.query(
        `SELECT * FROM marketplace_produtos WHERE empresa_id = $1 AND produto_id = $2 AND plataforma = $3`,
        [empresaResolvida.id, produto_id, plataforma]
      );
      if (vinculo.rowCount === 0) return erro(res, 404, 'Produto não vinculado a esta plataforma');

      const link = vinculo.rows[0];

      // Busca estoque atual do produto
      const prodResult = await pool.query(
        `SELECT estoque FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
        [produto_id, empresaResolvida.id]
      );
      if (prodResult.rowCount === 0) return erro(res, 404, 'Produto não encontrado');

      const estoqueAtual = normalizarInt(prodResult.rows[0].estoque);

      if (plataforma === 'mercadolivre') {
        const token = await getMlToken(empresaResolvida.id);
        if (!token) return erro(res, 400, 'Token ML expirado. Reautorize a integração.');

        const mlRes = await apiPost(
          `${ML_BASE}/items/${link.listing_id}`,
          token,
          { available_quantity: Math.max(0, estoqueAtual) }
        );

        if (!mlRes.ok) {
          return erro(res, 400, `Erro ML: ${JSON.stringify(mlRes.data)}`);
        }
      }

      // Atualiza sync local
      await pool.query(
        `UPDATE marketplace_produtos SET estoque_publicado = $1, ultimo_sync = NOW() WHERE id = $2 AND empresa_id = $3`,
        [estoqueAtual, link.id, empresaResolvida.id]
      );

      return ok(res, { mensagem: `Estoque sincronizado: ${estoqueAtual} unidades`, listing_id: link.listing_id });
    } catch (err) {
      console.error('[marketplace] sync-estoque:', err.message);
      return erro(res, 500, 'Erro ao sincronizar estoque');
    }
  });

  // ── Produtos vinculados ────────────────────────────────────────────────────

  router.get('/produtos', auth, requirePermissao(pool, 'marketplace', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT mp.*, p.nome AS produto_nome, p.estoque AS estoque_lferp
         FROM marketplace_produtos mp
         JOIN produtos p ON p.id = mp.produto_id
         WHERE mp.empresa_id = $1
         ORDER BY mp.plataforma, p.nome`,
        [empresaResolvida.id]
      );

      return ok(res, { produtos: result.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar produtos');
    }
  });

  router.post('/vincular', auth, requirePermissao(pool, 'marketplace', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { produto_id, plataforma, listing_id, titulo } = req.body;
      if (!produto_id || !plataforma || !listing_id) {
        return erro(res, 400, 'produto_id, plataforma e listing_id são obrigatórios');
      }
      if (!/^[A-Za-z0-9_\-]{3,60}$/.test(String(listing_id))) {
        return erro(res, 400, 'listing_id inválido');
      }

      // Verifica que o produto pertence à empresa antes de vincular (evita IDOR)
      const prod = await pool.query(
        `SELECT id FROM produtos WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND ativo = true AND deletado_em IS NULL`,
        [produto_id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (prod.rows.length === 0) return erro(res, 404, 'Produto não encontrado');

      const result = await pool.query(
        `INSERT INTO marketplace_produtos
           (empresa_id, produto_id, plataforma, listing_id, titulo, ultimo_sync)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (empresa_id, produto_id, plataforma) DO UPDATE
         SET listing_id = $4, titulo = $5, ultimo_sync = NOW()
         RETURNING *`,
        [empresaResolvida.id, produto_id, plataforma, listing_id, titulo || null]
      );

      return res.status(201).json({ sucesso: true, vinculo: result.rows[0] });
    } catch (err) {
      return erro(res, 500, 'Erro ao vincular produto');
    }
  });

  router.delete('/vincular/:id', auth, requirePermissao(pool, 'marketplace', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      await pool.query(
        `DELETE FROM marketplace_produtos WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), empresaResolvida.id]
      );
      return ok(res, { mensagem: 'Vínculo removido' });
    } catch (err) {
      return erro(res, 500, 'Erro ao remover vínculo');
    }
  });

  // ── Webhook (notificações de pedidos) ─────────────────────────────────────

  router.post('/webhook/:plataforma', webhookRateLimit, async (req, res) => {
    const { plataforma } = req.params;
    if (!PLATAFORMAS_VALIDAS.includes(plataforma)) return res.status(400).json({ ok: false });

    const payload = req.body;

    // Shopee: integração não implementada — nenhuma assinatura oficial configurada.
    // Fail-closed: rejeitar todo payload até que a validação HMAC da Shopee seja implementada.
    if (plataforma === 'shopee') {
      console.warn('[marketplace] webhook Shopee recebido mas integração não está habilitada');
      return res.status(501).json({ ok: false, erro: 'Integração Shopee não habilitada' });
    }

    // Mercado Livre: verificar x-signature antes de responder 200
    if (plataforma === 'mercadolivre') {
      const xSig   = req.headers['x-signature'];
      const xReqId = req.headers['x-request-id'];
      if (!xSig) {
        console.warn('[marketplace] webhook ML: x-signature ausente');
        return res.status(401).json({ ok: false });
      }
      const sellerId = String(payload?.user_id || '');
      if (!sellerId) {
        console.warn('[marketplace] webhook ML: user_id ausente no payload');
        return res.status(401).json({ ok: false });
      }
      try {
        const cfgCheck = await pool.query(
          `SELECT client_secret FROM marketplace_config WHERE seller_id = $1 AND plataforma = 'mercadolivre' AND ativo = true LIMIT 1`,
          [sellerId]
        );
        if (cfgCheck.rowCount === 0 || !cfgCheck.rows[0].client_secret) {
          console.warn(`[marketplace] webhook ML: seller_id "${sellerId}" sem configuração HMAC`);
          return res.status(401).json({ ok: false });
        }
        const secret   = cfgCheck.rows[0].client_secret;
        const notifId  = String(payload?.id || '');
        const manifest = `id:${notifId};request-id:${xReqId}`;
        const parts    = Object.fromEntries(xSig.split(',').map(p => { const [k, ...v] = p.split('='); return [k, v.join('=')]; }));
        const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
        const recvBuf  = Buffer.from(parts.v1 || '', 'hex');
        const expBuf   = Buffer.from(expected, 'hex');
        if (recvBuf.length !== expBuf.length || !crypto.timingSafeEqual(recvBuf, expBuf)) {
          console.warn('[marketplace] webhook ML: assinatura inválida');
          return res.status(401).json({ ok: false });
        }
      } catch (sigErr) {
        console.warn('[marketplace] webhook ML: erro na verificação de assinatura:', sigErr.message);
        return res.status(401).json({ ok: false });
      }
    }

    // Responde 200 imediatamente — ML considera falha se demorar > 5s
    res.status(200).json({ ok: true });

    try {
      console.log(`[marketplace] webhook ${plataforma}:`, JSON.stringify(payload).slice(0, 300));

      if (plataforma === 'mercadolivre' && payload.topic === 'orders_v2') {
        const match = String(payload.resource || '').match(/\/orders\/(\d+)/);
        if (!match) return;

        const orderId  = match[1];
        const sellerId = String(payload.user_id || '');

        // Encontrar qual empresa pertence a este seller
        const cfgResult = await pool.query(
          `SELECT mc.empresa_id, e.nome AS empresa_nome
           FROM marketplace_config mc
           JOIN empresas e ON e.id = mc.empresa_id
           WHERE mc.seller_id = $1 AND mc.plataforma = 'mercadolivre' AND mc.ativo = true
           LIMIT 1`,
          [sellerId]
        );

        if (cfgResult.rowCount === 0) {
          console.warn(`[marketplace] webhook ML: seller_id "${sellerId}" não encontrado`);
          return;
        }

        const { empresa_id: empresaId, empresa_nome: empresaNome } = cfgResult.rows[0];

        const token = await getMlToken(empresaId);
        if (!token) {
          console.warn(`[marketplace] webhook ML: token expirado para empresa ${empresaId} — pedido #${orderId} não processado`);
          return;
        }

        const resultado = await processarPedidoML({ orderId, empresaId, empresaNome, token });
        console.log(`[marketplace] pedido ML #${orderId}:`, resultado);
      }
    } catch (err) {
      console.error('[marketplace] webhook erro:', err.message);
    }
  });

  return router;
};
