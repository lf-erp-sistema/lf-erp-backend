'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 1/5 de assistencia.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): dashboard/KPIs.
module.exports = function assistenciaDashboardRoutes({ pool, validarAcessoEmpresa }) {
  const router = express.Router();

  router.get('/dashboard', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');
      const eid = empresaResolvida.id;
      const en  = empresaResolvida.nome;
      const filtro = `(empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;

      const [status, faturamento] = await Promise.all([
        pool.query(
          `SELECT status, COUNT(*) AS qtd FROM ordens_servico
           WHERE ${filtro} GROUP BY status`,
          [eid, en]
        ),
        pool.query(
          `SELECT
             COALESCE(SUM(valor_total),0)     AS faturamento,
             COALESCE(SUM(valor_mao_obra),0)  AS receita_servico,
             COALESCE(SUM(valor_pecas),0)     AS receita_pecas,
             COUNT(*)                          AS total,
             COALESCE(AVG(valor_total),0)      AS ticket_medio
           FROM ordens_servico
           WHERE ${filtro}
             AND status NOT IN ('cancelada','reprovada')
             AND data_entrada >= NOW() - INTERVAL '30 days'`,
          [eid, en]
        ),
      ]);

      const qtd = {};
      status.rows.forEach(r => { qtd[r.status] = Number(r.qtd); });

      const fat = faturamento.rows[0];
      const totalOS = status.rows.reduce((s, r) => s + Number(r.qtd), 0);
      const aprovadas = (qtd.aprovada || 0) + (qtd.em_execucao || 0) + (qtd.pronto || 0) + (qtd.entregue || 0);
      const enviadas  = aprovadas + (qtd.orcamento_enviado || 0) + (qtd.aguardando_aprovacao || 0) + (qtd.reprovada || 0);
      const taxaAprovacao = enviadas > 0 ? Math.round((aprovadas / enviadas) * 100) : null;

      return ok(res, {
        kpis: {
          os_abertas:           qtd.aberta || 0,
          em_diagnostico:       qtd.diagnostico || 0,
          aguardando_orcamento: qtd.orcamento_enviado || 0,
          aguardando_aprovacao: qtd.aguardando_aprovacao || 0,
          em_manutencao:        qtd.em_execucao || 0,
          aguardando_peca:      qtd.aguardando_peca || 0,
          prontas:              qtd.pronto || 0,
          entregues_30d:        qtd.entregue || 0,
          faturamento_30d:      Number(fat.faturamento),
          ticket_medio:         Number(fat.ticket_medio),
          taxa_aprovacao:       taxaAprovacao,
          total:                totalOS,
        },
        por_status: status.rows,
      });
    } catch (e) {
      console.error('[assistencia] GET /dashboard:', e);
      return erro(res, 500, 'Erro ao carregar dashboard');
    }
  });

  return router;
};
