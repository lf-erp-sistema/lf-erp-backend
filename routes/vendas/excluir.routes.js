'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { erro } = require('../../utils/routeHelpers');

// Parte 4/4 de vendas.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): exclusão de venda.
module.exports = function vendasExcluirRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarVendas,
  atualizarStatusContasReceberPorEmpresa, registrarAuditoria,
  validarVendaPertenceEmpresa, vendaPossuiParcelaPaga,
  estornarEstoqueVenda, removerDadosDependentesVenda
}) {
  const router = express.Router();

  router.delete('/:id', auth, writeRateLimiter, requirePermissao(pool, 'vendas', 'deletar'), async (req, res) => {
    const client = await pool.connect();

    try {
      if (!podeGerenciarVendas(req)) {
        return erro(res, 403, 'Sem permissão para excluir vendas');
      }

      const id = Number(req.params.id);

      if (!id) {
        return erro(res, 400, 'Venda inválida');
      }

      await client.query('BEGIN');

      const vendaResult = await client.query(
        `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1 FOR UPDATE`,
        [id, req.user.empresa_id || 0, req.user.empresa || '']
      );

      if (vendaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Venda não encontrada');
      }

      const venda = vendaResult.rows[0];
      // FIX 1: empresaBase era INTEGER quando empresa_id preenchido — agora passa nome e id separados
      const empresaResolvida = await validarAcessoEmpresa(req, venda.empresa || null, venda.empresa_id || null);
      if (!empresaResolvida) {
        await client.query('ROLLBACK');
        return erro(res, 403, 'Sem acesso');
      }

      const pertenceEmpresa = await validarVendaPertenceEmpresa({
        client,
        venda,
        empresaResolvida
      });

      if (!pertenceEmpresa) {
        await client.query('ROLLBACK');
        return erro(res, 403, 'Venda não pertence à empresa autenticada');
      }

      const possuiParcelaPaga = await vendaPossuiParcelaPaga({
        client,
        vendaId: id,
        empresaResolvida
      });

      if (possuiParcelaPaga) {
        await client.query('ROLLBACK');
        return erro(
          res,
          400,
          'Esta venda possui conta a receber paga. Estorne o recebimento antes de excluir.'
        );
      }

      await estornarEstoqueVenda({
        client,
        vendaId: id,
        empresaResolvida,
        usuarioId: req.user.id,
        motivo: `Estorno por exclusão da venda #${id}`
      });

      await removerDadosDependentesVenda({
        client,
        vendaId: id,
        empresaResolvida
      });

      await client.query(
        `
        DELETE FROM vendas
        WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        `,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      await client.query('COMMIT');

      try {
        await registrarAuditoria({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          usuario_id: req.user.id,
          usuario_nome: req.user.nome || '',
          modulo: 'vendas',
          acao: 'exclusao',
          referencia_id: id,
          dados_anteriores: venda,
          dados_novos: null,
          req
        });
      } catch (e) { console.error('[vendas] audit:', e.message); }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[venda-excluir] status-cr:', e.message); }

      return res.json({
        sucesso: true,
        mensagem: 'Venda excluída com sucesso'
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro real ao excluir venda:', error);
      return erro(res, 500, 'Erro ao excluir venda');
    } finally {
      client.release();
    }
  });

  return router;
};
