'use strict';
const express = require('express');
const { createVendasHelpers } = require('./vendas/helpers');
const criarRoutes = require('./vendas/criar.routes');
const editarRoutes = require('./vendas/editar.routes');
const consultaRoutes = require('./vendas/consulta.routes');
const excluirRoutes = require('./vendas/excluir.routes');

// Achado ARCH-01 da Auditoria 360 (2026-10-06): este arquivo tinha 1217 linhas
// (depois do ARCH-02) misturando criação, edição, consulta e exclusão de venda,
// mais 5 helpers internos compartilhados entre elas. Dividido em
// routes/vendas/{helpers,criar,editar,consulta,excluir}.routes.js por sub-domínio;
// este arquivo monta os helpers uma vez e combina os 4 sub-roteadores, preservando
// a mesma assinatura de factory e os mesmos caminhos relativos — nenhuma mudança
// necessária em server.js (que monta este router em app.use('/vendas', ...)).
module.exports = function vendasRoutes(deps) {
  const helpers = createVendasHelpers(deps);
  const todasDeps = { ...deps, ...helpers };

  const router = express.Router();
  router.use(criarRoutes(todasDeps));
  router.use(editarRoutes(todasDeps));
  router.use(consultaRoutes(todasDeps));
  router.use(excluirRoutes(todasDeps));
  return router;
};
