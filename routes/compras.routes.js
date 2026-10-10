'use strict';
const express = require('express');
const criarRoutes = require('./compras/criar.routes');
const editarRoutes = require('./compras/editar.routes');
const importarXmlRoutes = require('./compras/importarXml.routes');

// Achado ARCH-01 da Auditoria 360 (2026-10-06): este arquivo tinha 721 linhas
// misturando criação de compra (com baixa de estoque, custo médio e geração de
// contas a pagar), edição (reversão + reaplicação de tudo isso) e importação de
// XML de NF-e. Dividido em routes/compras/{criar,editar,importarXml}.routes.js
// por sub-domínio; este arquivo monta os 3 sub-roteadores na mesma ordem relativa
// do arquivo original, mesma assinatura de factory, nenhuma mudança em server.js.
//
// Com isso, o ARCH-01 da Auditoria 360 (dividir os 7 arquivos de rota gigantes)
// está completo: contas-receber, vendas, produtos, assistencia, relatorios,
// marketplace e compras.
module.exports = function comprasRoutes(deps) {
  const router = express.Router();
  router.use(criarRoutes(deps));
  router.use(editarRoutes(deps));
  router.use(importarXmlRoutes(deps));
  return router;
};
