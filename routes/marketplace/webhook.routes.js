'use strict';
const express = require('express');
const crypto = require('crypto');
const { PLATAFORMAS_VALIDAS, webhookRateLimit, createMarketplaceHelpers } = require('./helpers');

// Parte 4/4 de marketplace.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// recebimento de notificações de pedidos (sem auth JWT — autenticado por HMAC/x-signature).
module.exports = function marketplaceWebhookRoutes(deps) {
  const { pool } = deps;
  const { getMlToken, processarPedidoML } = createMarketplaceHelpers(deps);
  const router = express.Router();

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
