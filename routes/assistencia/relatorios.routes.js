'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { addDias } = require('../../utils/normalizadores');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 5/5 de assistencia.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): relatório-resumo.
module.exports = function assistenciaRelatoriosRoutes({ pool, validarAcessoEmpresa, hoje }) {
  const router = express.Router();

  router.get('/relatorios/resumo', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const er = await validarAcessoEmpresa(req, req.query.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');

      const { data_inicial, data_final } = req.query;
      const di = data_inicial || addDias(hoje(), -30);
      const df = data_final   || hoje();

      const filtro = `(os.empresa_id=$1 OR (os.empresa_id IS NULL AND os.empresa=$2)) AND os.data_entrada::date BETWEEN $3 AND $4`;

      const [totais, marcas, servicos] = await Promise.all([
        pool.query(
          `SELECT status, COUNT(*) qtd, COALESCE(SUM(valor_total),0) valor
           FROM ordens_servico os WHERE ${filtro} GROUP BY status`,
          [er.id, er.nome, di, df]
        ),
        pool.query(
          `SELECT COALESCE(equipamento_marca,'Sem marca') AS marca,
                  COUNT(*) qtd, COALESCE(SUM(valor_total),0) valor
           FROM ordens_servico os WHERE ${filtro}
           GROUP BY 1 ORDER BY qtd DESC LIMIT 10`,
          [er.id, er.nome, di, df]
        ),
        pool.query(
          `SELECT osi.descricao, COUNT(*) qtd, COALESCE(SUM(osi.valor_total),0) valor
           FROM ordens_servico_itens osi
           JOIN ordens_servico os ON os.id = osi.os_id
           WHERE ${filtro}
           GROUP BY 1 ORDER BY qtd DESC LIMIT 10`,
          [er.id, er.nome, di, df]
        ),
      ]);

      return ok(res, {
        periodo: { data_inicial: di, data_final: df },
        por_status: totais.rows,
        por_marca: marcas.rows,
        top_servicos: servicos.rows,
      });
    } catch (e) {
      console.error('[assistencia] GET /relatorios/resumo:', e);
      return erro(res, 500, 'Erro ao gerar relatório');
    }
  });

  return router;
};
