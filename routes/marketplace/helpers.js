'use strict';
const https = require('https');
const { encryptField, decryptField } = require('../../utils/pixCrypto');

// Helpers compartilhados pelas rotas de marketplace.routes.js (achado ARCH-01 da
// Auditoria 360, 2026-10-06) -- extraídos sem nenhuma alteração de lógica.

const ML_BASE = 'https://api.mercadolibre.com';
const ML_AUTH = 'https://auth.mercadolivre.com.br/authorization';
const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const PLATAFORMAS_VALIDAS = ['mercadolivre', 'shopee'];
const ML_TIMEOUT_MS = 15000;

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

function createMarketplaceHelpers({ pool, normalizarDecimal, normalizarInt, normalizarDataISO, hoje, registrarMovimentacaoEstoque }) {
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

  return { mlTokenFetch, apiGet, apiPost, getConfig, refreshMlToken, getMlToken, processarPedidoML };
}

module.exports = {
  ML_BASE, ML_AUTH, ML_TOKEN_URL, PLATAFORMAS_VALIDAS, ML_TIMEOUT_MS,
  safeDecrypt, webhookRateLimit,
  createMarketplaceHelpers
};
