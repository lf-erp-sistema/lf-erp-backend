'use strict';

/**
 * Rotas do Módulo de Assistência Técnica — LF ERP
 *
 * ISOLAMENTO: Todas as rotas exigem:
 *   1. auth — usuário autenticado (JWT)
 *   2. requireFeatureHabilitada — empresa_id do token deve ter 'assistencia_tecnica' = TRUE em empresa_features
 *   3. requirePermissao — permissão granular sobre o recurso
 *   4. validarAcessoEmpresa — empresa_id do token coincide com os dados solicitados
 *
 * HTTP 403 para qualquer empresa que não tenha o feature habilitado.
 *
 * Achado ARCH-01 da Auditoria 360 (2026-10-06): este arquivo tinha 835 linhas
 * misturando dashboard, ordens de serviço, aparelhos, garantias e relatórios.
 * Dividido em routes/assistencia/{dashboard,os,aparelhos,garantias,relatorios}.routes.js
 * por sub-domínio, seguindo as próprias seções já delimitadas por comentário no
 * arquivo original. O middleware global (auth + requireFeatureHabilitada) continua
 * aplicado uma única vez aqui, antes de montar os 5 sub-roteadores na mesma ordem
 * relativa do arquivo original — mesma assinatura de factory, nenhuma mudança em
 * server.js.
 */

const express = require('express');
const { erro } = require('../utils/routeHelpers');
const dashboardRoutes = require('./assistencia/dashboard.routes');
const osRoutes = require('./assistencia/os.routes');
const aparelhosRoutes = require('./assistencia/aparelhos.routes');
const garantiasRoutes = require('./assistencia/garantias.routes');
const relatoriosRoutes = require('./assistencia/relatorios.routes');

module.exports = function assistenciaRoutes(deps) {
  const { auth, pool } = deps;
  const router = express.Router();

  // ── Middleware: valida feature 'assistencia_tecnica' pelo empresa_id do token ──
  async function requireFeatureHabilitada(req, res, next) {
    try {
      if (req.user?.is_saas_owner) return next();
      const empresaId = req.user?.empresa_id;
      if (!empresaId) return erro(res, 403, 'Empresa não identificada');

      const r = await pool.query(
        `SELECT habilitado FROM empresa_features WHERE empresa_id = $1 AND feature = $2`,
        [empresaId, 'assistencia_tecnica']
      );
      if (!r.rows[0]?.habilitado) {
        return erro(res, 403, 'Módulo de Assistência Técnica não habilitado para esta empresa');
      }
      next();
    } catch (e) {
      console.error('[assistencia] requireFeatureHabilitada:', e);
      return erro(res, 500, 'Erro ao verificar acesso ao módulo');
    }
  }

  // Aplica o middleware de feature em todas as rotas deste router
  router.use(auth, requireFeatureHabilitada);

  router.use(dashboardRoutes(deps));
  router.use(osRoutes(deps));
  router.use(aparelhosRoutes(deps));
  router.use(garantiasRoutes(deps));
  router.use(relatoriosRoutes(deps));

  return router;
};
