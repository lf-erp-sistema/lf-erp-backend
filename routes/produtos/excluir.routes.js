'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 4/4 de produtos.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): exclusão (soft-delete) de produto.
module.exports = function produtosExcluirRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, normalizarInt, registrarAuditoria
}) {
  const router = express.Router();

  router.delete('/:id', auth, writeRateLimiter, requirePermissao(pool, 'produtos', 'deletar'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresa = req.query.empresa || req.body.empresa || null;

      if (!id) {
        return erro(res, 400, 'Produto inválido');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      // Todas as verificações + soft-delete dentro de uma única transação
      // com FOR UPDATE para evitar TOCTOU
      const clienteDel = await pool.connect();
      let produtoParaAudit;
      try {
        await clienteDel.query('BEGIN');

        // Lock no produto impede corrida entre verificação e deleção
        const produtoResult = await clienteDel.query(
          `SELECT * FROM produtos WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL FOR UPDATE`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (produtoResult.rowCount === 0) {
          await clienteDel.query('ROLLBACK');
          return erro(res, 404, 'Produto não encontrado');
        }

        const produto = produtoResult.rows[0];
        produtoParaAudit = produto;

        if (normalizarInt(produto.estoque) > 0) {
          await clienteDel.query('ROLLBACK');
          return erro(res, 400, `Produto possui ${produto.estoque} unidade(s) em estoque. Zere o estoque antes de excluir.`);
        }

        const vendaItemResult = await clienteDel.query(
          `SELECT COUNT(*) AS total
     FROM venda_itens
     WHERE produto_id = $1
     AND (
       empresa_id = $2
       OR (
         empresa_id IS NULL
         AND empresa = $3
       )
     )`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        const compraItemResult = await clienteDel.query(
          `SELECT COUNT(*) AS total
     FROM compra_itens
     WHERE produto_id = $1
     AND (
       empresa_id = $2
       OR (
         empresa_id IS NULL
         AND empresa = $3
       )
     )`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (
          Number(vendaItemResult.rows[0].total || 0) > 0 ||
          Number(compraItemResult.rows[0].total || 0) > 0
        ) {
          await clienteDel.query('ROLLBACK');
          return erro(res, 400, 'Produto já possui movimentações e não pode ser excluído');
        }

        await clienteDel.query(
          `DELETE FROM movimentacoes_estoque
           WHERE produto_id = $1
             AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        await clienteDel.query(
          `UPDATE produtos
           SET deletado_em = NOW(), atualizado_em = NOW()
           WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        await clienteDel.query('COMMIT');
      } catch (txErr) {
        await clienteDel.query('ROLLBACK');
        throw txErr;
      } finally {
        clienteDel.release();
      }

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'produtos',
        acao: 'soft_delete',
        referencia_id: id,
        dados_anteriores: produtoParaAudit,
        dados_novos: {
          deletado_em: new Date()
        },
        req
      });

      return ok(res, {
        mensagem: 'Produto excluído com sucesso'
      });
    } catch (error) {
      console.error('Erro real ao excluir produto:', error);
      return erro(res, 500, 'Erro ao excluir produto');
    }
  });

  return router;
};
