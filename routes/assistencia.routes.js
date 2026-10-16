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
const { createRequireFeatureHabilitada } = require('../utils/routeHelpers');
const dashboardRoutes = require('./assistencia/dashboard.routes');
const osRoutes = require('./assistencia/os.routes');
const aparelhosRoutes = require('./assistencia/aparelhos.routes');
const garantiasRoutes = require('./assistencia/garantias.routes');
const relatoriosRoutes = require('./assistencia/relatorios.routes');

module.exports = function assistenciaRoutes(deps) {
  const { auth, pool } = deps;
  const router = express.Router();

  // Aplica o middleware de feature (compartilhado com /ordens-servico, ver
  // utils/routeHelpers.js) em todas as rotas deste router
  router.use(auth, createRequireFeatureHabilitada(pool));

  router.use(dashboardRoutes(deps));
  router.use(osRoutes(deps));
  router.use(aparelhosRoutes(deps));
  router.use(garantiasRoutes(deps));
  router.use(relatoriosRoutes(deps));

  return router;
};
