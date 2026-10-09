'use strict';

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
 *
 * Achado ARCH-01 da Auditoria 360 (2026-10-06): este arquivo tinha 736 linhas
 * misturando config, OAuth2, sincronização de estoque/vínculo e webhook, mais um
 * conjunto pesado de helpers de integração com a API do Mercado Livre (token,
 * refresh, chamadas HTTP, processamento de pedido). Dividido em
 * routes/marketplace/{helpers,config,oauth,produtos,webhook}.routes.js por
 * sub-domínio; este arquivo monta os 4 sub-roteadores na mesma ordem relativa do
 * arquivo original, mesma assinatura de factory, nenhuma mudança em server.js.
 */

const express = require('express');
const configRoutes = require('./marketplace/config.routes');
const oauthRoutes = require('./marketplace/oauth.routes');
const produtosRoutes = require('./marketplace/produtos.routes');
const webhookRoutes = require('./marketplace/webhook.routes');

module.exports = function marketplaceRoutes(deps) {
  const router = express.Router();
  router.use(configRoutes(deps));
  router.use(oauthRoutes(deps));
  router.use(produtosRoutes(deps));
  router.use(webhookRoutes(deps));
  return router;
};
