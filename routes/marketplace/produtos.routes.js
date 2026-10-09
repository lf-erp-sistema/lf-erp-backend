'use strict';
const express = require('express');
const { erro, ok } = require('../../utils/routeHelpers');
const { requirePermissao } = require('../../utils/permissoes');
const { ML_BASE, createMarketplaceHelpers } = require('./helpers');

// Parte 3/4 de marketplace.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// sincronização de estoque e vínculo produto LF ERP ↔ listing.
module.exports = function marketplaceProdutosRoutes(deps) {
  const { auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarInt } = deps;
  const { getMlToken, apiPost } = createMarketplaceHelpers(deps);
  const router = express.Router();

  router.post('/sync-estoque', auth, requirePermissao(pool, 'marketplace', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { produto_id, plataforma } = req.body;
      if (!produto_id || !plataforma) return erro(res, 400, 'produto_id e plataforma são obrigatórios');

      // Busca vínculo
      const vinculo = await pool.query(
        `SELECT * FROM marketplace_produtos WHERE empresa_id = $1 AND produto_id = $2 AND plataforma = $3`,
        [empresaResolvida.id, produto_id, plataforma]
      );
      if (vinculo.rowCount === 0) return erro(res, 404, 'Produto não vinculado a esta plataforma');

      const link = vinculo.rows[0];

      // Busca estoque atual do produto
      const prodResult = await pool.query(
        `SELECT estoque FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
        [produto_id, empresaResolvida.id]
      );
      if (prodResult.rowCount === 0) return erro(res, 404, 'Produto não encontrado');

      const estoqueAtual = normalizarInt(prodResult.rows[0].estoque);

      if (plataforma === 'mercadolivre') {
        const token = await getMlToken(empresaResolvida.id);
        if (!token) return erro(res, 400, 'Token ML expirado. Reautorize a integração.');

        const mlRes = await apiPost(
          `${ML_BASE}/items/${link.listing_id}`,
          token,
          { available_quantity: Math.max(0, estoqueAtual) }
        );

        if (!mlRes.ok) {
          return erro(res, 400, `Erro ML: ${JSON.stringify(mlRes.data)}`);
        }
      }

      // Atualiza sync local
      await pool.query(
        `UPDATE marketplace_produtos SET estoque_publicado = $1, ultimo_sync = NOW() WHERE id = $2 AND empresa_id = $3`,
        [estoqueAtual, link.id, empresaResolvida.id]
      );

      return ok(res, { mensagem: `Estoque sincronizado: ${estoqueAtual} unidades`, listing_id: link.listing_id });
    } catch (err) {
      console.error('[marketplace] sync-estoque:', err.message);
      return erro(res, 500, 'Erro ao sincronizar estoque');
    }
  });

  router.get('/produtos', auth, requirePermissao(pool, 'marketplace', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT mp.*, p.nome AS produto_nome, p.estoque AS estoque_lferp
         FROM marketplace_produtos mp
         JOIN produtos p ON p.id = mp.produto_id
         WHERE mp.empresa_id = $1
         ORDER BY mp.plataforma, p.nome`,
        [empresaResolvida.id]
      );

      return ok(res, { produtos: result.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar produtos');
    }
  });

  router.post('/vincular', auth, requirePermissao(pool, 'marketplace', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { produto_id, plataforma, listing_id, titulo } = req.body;
      if (!produto_id || !plataforma || !listing_id) {
        return erro(res, 400, 'produto_id, plataforma e listing_id são obrigatórios');
      }
      if (!/^[A-Za-z0-9_\-]{3,60}$/.test(String(listing_id))) {
        return erro(res, 400, 'listing_id inválido');
      }

      // Verifica que o produto pertence à empresa antes de vincular (evita IDOR)
      const prod = await pool.query(
        `SELECT id FROM produtos WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND ativo = true AND deletado_em IS NULL`,
        [produto_id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (prod.rows.length === 0) return erro(res, 404, 'Produto não encontrado');

      const result = await pool.query(
        `INSERT INTO marketplace_produtos
           (empresa_id, produto_id, plataforma, listing_id, titulo, ultimo_sync)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (empresa_id, produto_id, plataforma) DO UPDATE
         SET listing_id = $4, titulo = $5, ultimo_sync = NOW()
         RETURNING *`,
        [empresaResolvida.id, produto_id, plataforma, listing_id, titulo || null]
      );

      return res.status(201).json({ sucesso: true, vinculo: result.rows[0] });
    } catch (err) {
      return erro(res, 500, 'Erro ao vincular produto');
    }
  });

  router.delete('/vincular/:id', auth, requirePermissao(pool, 'marketplace', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      await pool.query(
        `DELETE FROM marketplace_produtos WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), empresaResolvida.id]
      );
      return ok(res, { mensagem: 'Vínculo removido' });
    } catch (err) {
      return erro(res, 500, 'Erro ao remover vínculo');
    }
  });

  return router;
};
