'use strict';
const express = require('express');
const consultaRoutes = require('./contas-receber/consulta.routes');
const baixaRoutes = require('./contas-receber/baixa.routes');
const crudRoutes = require('./contas-receber/crud.routes');

// Achado ARCH-01 da Auditoria 360 (2026-10-06): este arquivo tinha 1447 linhas
// misturando CRUD, baixa, estorno, estorno parcial, criação manual e histórico de
// cliente num único módulo. Dividido em routes/contas-receber/{consulta,baixa,crud}.routes.js
// por sub-domínio; este arquivo apenas combina os 3 sub-roteadores, preservando a
// mesma assinatura de factory e os mesmos caminhos — nenhuma mudança de comportamento,
// nenhuma mudança necessária em server.js.
module.exports = function contasReceberRoutes(deps) {
  const router = express.Router();
  router.use(consultaRoutes(deps));
  router.use(baixaRoutes(deps));
  router.use(crudRoutes(deps));
  return router;
};
