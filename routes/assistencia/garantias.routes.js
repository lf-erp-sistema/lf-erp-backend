'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 4/5 de assistencia.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): consulta de garantias.
module.exports = function assistenciaGarantiasRoutes({ pool, validarAcessoEmpresa }) {
  const router = express.Router();

  router.get('/garantias', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const er = await validarAcessoEmpresa(req, req.query.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');
      const { status_garantia } = req.query;

      let cond = status_garantia === 'ativa' ? `AND g.data_fim >= CURRENT_DATE`
               : status_garantia === 'vencida' ? `AND g.data_fim < CURRENT_DATE`
               : '';

      const rows = await pool.query(
        `SELECT g.*, os.numero AS os_numero, os.equipamento_marca, os.equipamento_modelo,
                c.nome AS cliente_nome, c.telefone AS cliente_telefone,
                g.data_fim >= CURRENT_DATE AS ativa
         FROM at_garantias g
         JOIN ordens_servico os ON os.id = g.os_id
         LEFT JOIN clientes c ON c.id = os.cliente_id
         WHERE g.empresa_id=$1 ${cond}
         ORDER BY g.data_fim DESC`,
        [er.id]
      );
      return ok(res, { garantias: rows.rows });
    } catch (e) {
      console.error('[assistencia] GET /garantias:', e);
      return erro(res, 500, 'Erro ao listar garantias');
    }
  });

  return router;
};
