'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { calcularComissaoVenda } = require('../../utils/comissoes');
const { acumularPontosFidelidade } = require('../../utils/fidelidade');
const { dispararWebhookComRetry } = require('../../utils/webhookContabil');
const { createVendasService } = require('../../utils/vendasService');
const { erro } = require('../../utils/routeHelpers');

// Parte 1/4 de vendas.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): criação de venda.
module.exports = function vendasCriarRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarVendas, validarLimiteVendasMes,
  normalizarDecimal, normalizarInt, normalizarDataISO, hoje,
  criarParcelasContasReceber, atualizarStatusContasReceberPorEmpresa,
  registrarAuditoria, inserirItensVendaEBaixarEstoque
}) {
  const router = express.Router();

  const { criarVenda } = createVendasService({
    pool,
    normalizarDecimal,
    normalizarInt,
    normalizarDataISO,
    hoje,
    validarLimiteVendasMes,
    criarParcelasContasReceber
  });

  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'vendas', 'criar'), async (req, res) => {
    const client = await pool.connect();

    try {
      if (!podeGerenciarVendas(req)) {
        return erro(res, 403, 'Sem permissão para vendas');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const resultado = await criarVenda({
        client,
        empresaResolvida,
        usuarioId: req.user.id,
        body: req.body,
        inserirItensVendaEBaixarEstoque
      });

      if (!resultado.ok) {
        return erro(res, resultado.status, resultado.mensagem);
      }

      if (resultado.deduplicated) {
        return res.status(200).json({ success: true, venda_id: resultado.venda.id, deduplicated: true });
      }

      const {
        venda, clienteIdFinal, clienteNomeFinal,
        subtotalFinal, descontoFinal, acrescimoFinal, totalFinal, pagamentoPrincipal
      } = resultado;

      try {
        await registrarAuditoria({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          usuario_id: req.user.id,
          usuario_nome: req.user.nome || '',
          modulo: 'vendas',
          acao: 'cadastro',
          referencia_id: venda.id,
          dados_novos: {
            cliente_id: clienteIdFinal,
            cliente_nome: clienteNomeFinal,
            subtotal: subtotalFinal,
            desconto: descontoFinal,
            acrescimo: acrescimoFinal,
            total: totalFinal,
            pagamento: req.body.pagamento || 'Dinheiro',
            parcelas: Math.max(1, normalizarInt(req.body.parcelas || 1)),
            status_pagamento: req.body.status_pagamento || 'pago',
            itens: req.body.itens.map((i) => ({
              produto_id: i.produto_id,
              quantidade: i.quantidade,
              preco_unitario: i.preco_unitario
            }))
          },
          req
        });
      } catch (e) { console.error('[vendas] audit:', e.message); }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[venda-criar] status-cr:', e.message); }

      // Calcula comissão em background — não bloqueia resposta; erro é logado com contexto
      calcularComissaoVenda(pool, {
        vendaId: venda.id,
        usuarioId: req.user.id,
        empresaId: empresaResolvida.id
      }).catch((e) => console.error(
        `[comissao] falha ao calcular venda=${venda.id} usuario=${req.user.id} empresa=${empresaResolvida.id}:`,
        e.message
      ));

      // Acumula pontos de fidelidade em background (só se houver cliente vinculado)
      if (clienteIdFinal) {
        acumularPontosFidelidade(pool, {
          empresaId: empresaResolvida.id,
          clienteId: clienteIdFinal,
          vendaId:   venda.id,
          totalVenda: totalFinal
        }).catch((e) => console.error(`[fidelidade] falha venda=${venda.id}:`, e.message));
      }

      // Notifica integração contábil em background (com 1 retry após 5s em falha transitória)
      dispararWebhookComRetry(pool, empresaResolvida.id, 'venda.criada', {
        id: venda.id, total: totalFinal,
        cliente: clienteNomeFinal, pagamento: pagamentoPrincipal || 'Dinheiro'
      }).catch((e) => console.error(`[webhook-contabil] venda=${venda.id}:`, e.message));

      return res.json({
        sucesso: true,
        dados: { venda_id: venda.id }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('ERRO REAL AO REGISTRAR VENDA:', error);
      return erro(res, 500, 'Erro ao registrar venda');
    } finally {
      client.release();
    }
  });

  return router;
};
