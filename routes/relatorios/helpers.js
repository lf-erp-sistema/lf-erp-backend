'use strict';
const { erro } = require('../../utils/routeHelpers');

// Helper compartilhado pelas 4 rotas de relatorios.routes.js (achado ARCH-01 da
// Auditoria 360, 2026-10-06) -- extraído sem nenhuma alteração de lógica.
function checkFinanceiro(req, res, podeGerenciarFinanceiro) {
  if (typeof podeGerenciarFinanceiro === 'function' && !podeGerenciarFinanceiro(req)) {
    erro(res, 403, 'Acesso restrito a administradores e gerentes');
    return false;
  }
  return true;
}

module.exports = { checkFinanceiro };
