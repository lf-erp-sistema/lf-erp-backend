'use strict';
const express = require('express');
const resumoRoutes = require('./relatorios/resumo.routes');
const fluxoCaixaRoutes = require('./relatorios/fluxoCaixa.routes');
const contasRoutes = require('./relatorios/contas.routes');

// Achado ARCH-01 da Auditoria 360 (2026-10-06): este arquivo tinha 758 linhas com
// 4 rotas de relatório financeiro, cada uma com queries grandes e pouco relacionadas
// entre si além do helper checkFinanceiro compartilhado. Dividido em
// routes/relatorios/{helpers,resumo,fluxoCaixa,contas}.routes.js por sub-domínio;
// este arquivo monta os 3 sub-roteadores na mesma ordem relativa do arquivo original
// (resumo, fluxo-caixa, contas-receber, contas-pagar), mesma assinatura de factory,
// nenhuma mudança necessária em server.js.
module.exports = function relatoriosRoutes(deps) {
  const router = express.Router();
  router.use(resumoRoutes(deps));
  router.use(fluxoCaixaRoutes(deps));
  router.use(contasRoutes(deps));
  return router;
};
