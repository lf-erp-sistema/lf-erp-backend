'use strict';
const express = require('express');
const { erro, ok } = require('../../utils/routeHelpers');
const { requirePermissao } = require('../../utils/permissoes');
const { encryptField } = require('../../utils/pixCrypto');
const { PLATAFORMAS_VALIDAS } = require('./helpers');

// Parte 1/4 de marketplace.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): configuração por plataforma.
module.exports = function marketplaceConfigRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa }) {
  const router = express.Router();

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

  return router;
};
