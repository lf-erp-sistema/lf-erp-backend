'use strict';
const express = require('express');
const crypto = require('crypto');
const { erro, ok } = require('../../utils/routeHelpers');
const { requirePermissao } = require('../../utils/permissoes');
const { encryptField } = require('../../utils/pixCrypto');
const { ML_AUTH, ML_TOKEN_URL, PLATAFORMAS_VALIDAS, createMarketplaceHelpers } = require('./helpers');

// Parte 2/4 de marketplace.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): fluxo OAuth2.
module.exports = function marketplaceOauthRoutes(deps) {
  const { auth, pool, validarAcessoEmpresa } = deps;
  const { getConfig, mlTokenFetch } = createMarketplaceHelpers(deps);
  const router = express.Router();

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

  return router;
};
