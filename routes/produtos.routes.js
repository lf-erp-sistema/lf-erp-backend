'use strict';
const express = require('express');
const criarRoutes = require('./produtos/criar.routes');
const consultaRoutes = require('./produtos/consulta.routes');
const editarRoutes = require('./produtos/editar.routes');
const excluirRoutes = require('./produtos/excluir.routes');

// Achado ARCH-01 da Auditoria 360 (2026-10-06): este arquivo tinha 838 linhas
// misturando criação, consulta/listagem, edição e exclusão de produto. Dividido em
// routes/produtos/{criar,consulta,editar,excluir}.routes.js por sub-domínio; este
// arquivo monta os 4 sub-roteadores na mesma ordem relativa do arquivo original —
// importante porque /etiquetas-hoje/:empresa precisa continuar registrada antes de
// /:empresa — preservando a mesma assinatura de factory e os mesmos caminhos
// relativos, sem nenhuma mudança necessária em server.js.
module.exports = function produtosRoutes(deps) {
  const router = express.Router();
  router.use(criarRoutes(deps));
  router.use(consultaRoutes(deps));
  router.use(editarRoutes(deps));
  router.use(excluirRoutes(deps));
  return router;
};
