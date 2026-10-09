'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 3/5 de assistencia.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): cadastro de aparelhos.
module.exports = function assistenciaAparelhosRoutes({
  writeRateLimiter, pool, validarAcessoEmpresa, normalizarInt
}) {
  const router = express.Router();

  router.get('/aparelhos', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const er = await validarAcessoEmpresa(req, req.query.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');
      const { busca, limit = 50, offset = 0 } = req.query;

      let params = [er.id];
      let conds  = [`a.empresa_id = $1`];
      let p = 2;

      if (busca) {
        conds.push(`(a.imei1 ILIKE $${p} OR a.modelo ILIKE $${p} OR a.marca ILIKE $${p} OR c.nome ILIKE $${p})`);
        params.push(`%${busca}%`); p++;
      }

      params.push(Number(limit), Number(offset));
      const rows = await pool.query(
        `SELECT a.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone,
                COUNT(os.id) AS total_os
         FROM at_aparelhos a
         LEFT JOIN clientes c ON c.id = a.cliente_id
         LEFT JOIN ordens_servico os ON os.aparelho_id = a.id
         WHERE ${conds.join(' AND ')}
         GROUP BY a.id, c.nome, c.telefone
         ORDER BY a.criado_em DESC
         LIMIT $${p++} OFFSET $${p++}`,
        params
      );
      return ok(res, { aparelhos: rows.rows });
    } catch (e) {
      console.error('[assistencia] GET /aparelhos:', e);
      return erro(res, 500, 'Erro ao listar aparelhos');
    }
  });

  router.post('/aparelhos', writeRateLimiter, requirePermissao(pool, 'assistencia_tecnica', 'criar'), async (req, res) => {
    try {
      const er = await validarAcessoEmpresa(req, req.body.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');

      const { cliente_id, tipo, marca, modelo, imei1, imei2, serie, cor, capacidade, so, observacoes } = req.body;

      const r = await pool.query(
        `INSERT INTO at_aparelhos (empresa_id, cliente_id, tipo, marca, modelo, imei1, imei2, serie, cor, capacidade, so, observacoes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [er.id, normalizarInt(cliente_id) || null, tipo || 'Smartphone', marca || null, modelo || null,
         imei1 || null, imei2 || null, serie || null, cor || null, capacidade || null, so || null, observacoes || null]
      );
      return ok(res, { aparelho: r.rows[0] }, 201);
    } catch (e) {
      console.error('[assistencia] POST /aparelhos:', e);
      return erro(res, 500, 'Erro ao criar aparelho');
    }
  });

  router.get('/aparelhos/:id', requirePermissao(pool, 'assistencia_tecnica', 'ver'), async (req, res) => {
    try {
      const id = normalizarInt(req.params.id);
      if (!id) return erro(res, 400, 'ID inválido');
      const er = await validarAcessoEmpresa(req, req.query.empresa);
      if (!er) return erro(res, 403, 'Sem acesso');

      const [apRes, osRes] = await Promise.all([
        pool.query(
          `SELECT a.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone
           FROM at_aparelhos a LEFT JOIN clientes c ON c.id = a.cliente_id
           WHERE a.id=$1 AND a.empresa_id=$2`,
          [id, er.id]
        ),
        pool.query(
          `SELECT os.id, os.numero, os.status, os.defeito_cliente, os.diagnostico,
                  os.valor_total, os.data_entrada, os.data_conclusao,
                  c.nome AS cliente_nome
           FROM ordens_servico os
           LEFT JOIN clientes c ON c.id = os.cliente_id
           WHERE os.aparelho_id=$1 AND (os.empresa_id=$2 OR (os.empresa_id IS NULL AND os.empresa=$3))
           ORDER BY os.criado_em DESC`,
          [id, er.id, er.nome]
        ),
      ]);

      if (!apRes.rows[0]) return erro(res, 404, 'Aparelho não encontrado');
      return ok(res, { aparelho: apRes.rows[0], historico_os: osRes.rows });
    } catch (e) {
      console.error('[assistencia] GET /aparelhos/:id:', e);
      return erro(res, 500, 'Erro ao buscar aparelho');
    }
  });

  return router;
};
