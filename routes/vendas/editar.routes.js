'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { erro } = require('../../utils/routeHelpers');
const { deveGerarFinanceiroVenda, sanitizarFormaPagamento } = require('../../utils/vendasOps');

// Parte 2/4 de vendas.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// edição de venda (itens/valores) e edição isolada da observação.
module.exports = function vendasEditarRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarVendas,
  normalizarDecimal, normalizarInt, normalizarDataISO, hoje,
  criarParcelasContasReceber, atualizarStatusContasReceberPorEmpresa,
  registrarAuditoria,
  validarVendaPertenceEmpresa, vendaPossuiParcelaPaga,
  estornarEstoqueVenda, removerDadosDependentesVenda, inserirItensVendaEBaixarEstoque
}) {
  const router = express.Router();

  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'vendas', 'editar'), async (req, res) => {
    const client = await pool.connect();

    try {
      if (!podeGerenciarVendas(req)) {
        return erro(res, 403, 'Sem permissão para editar vendas');
      }

      const id = Number(req.params.id);

      if (!id) {
        return erro(res, 400, 'Venda inválida');
      }

      const {
        empresa,
        cliente_id,
        cliente_nome,
        subtotal,
        desconto,
        acrescimo,
        total,
        pagamento,
        parcelas,
        status_pagamento,
        data,
        observacao,
        conta_receber,
        itens
      } = req.body;

      if (!Array.isArray(itens) || itens.length === 0) {
        return erro(res, 400, 'Dados da venda incompletos');
      }

      await client.query('BEGIN');

      const vendaResult = req.user.is_saas_owner
        ? await client.query(`SELECT * FROM vendas WHERE id = $1 LIMIT 1 FOR UPDATE`, [id])
        : await client.query(
            `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1 FOR UPDATE`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (vendaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Venda não encontrada');
      }

      const vendaAtual = vendaResult.rows[0];

      const empresaBase = empresa || vendaAtual.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresaBase);

      if (!empresaResolvida) {
        await client.query('ROLLBACK');
        return erro(res, 403, 'Sem acesso');
      }

      const pertenceEmpresa = await validarVendaPertenceEmpresa({
        client,
        venda: vendaAtual,
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
          'Esta venda possui conta a receber paga. Estorne o recebimento antes de editar.'
        );
      }

      let clienteNomeFinal = cliente_nome || '';
      let clienteIdFinal = cliente_id || null;

      if (clienteIdFinal) {
        const clienteResult = await client.query(
          `SELECT * FROM clientes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL LIMIT 1`,
          [clienteIdFinal, empresaResolvida.id, empresaResolvida.nome]
        );

        if (clienteResult.rowCount === 0) {
          await client.query('ROLLBACK');
          return erro(res, 404, 'Cliente não encontrado');
        }

        clienteNomeFinal = clienteResult.rows[0].nome;
      }

      const subtotalFinal = normalizarDecimal(subtotal) ?? 0;
      const descontoFinal = normalizarDecimal(desconto) ?? 0;
      const acrescimoFinal = normalizarDecimal(acrescimo) ?? 0;
      const totalFinal = normalizarDecimal(total) ?? 0;

      // FIX 2: rejeitar desconto/acréscimo negativos
      if (descontoFinal < 0) { await client.query('ROLLBACK'); return erro(res, 400, 'Desconto não pode ser negativo'); }
      if (acrescimoFinal < 0) { await client.query('ROLLBACK'); return erro(res, 400, 'Acréscimo não pode ser negativo'); }

      const parcelasFinal = Math.max(1, normalizarInt(parcelas || 1));
      const dataFinal = normalizarDataISO(data) || hoje();

      // Salvar total já pago antes de deletar parcelas (VP-C1/C2)
      const parcelasJaPagasResult = await client.query(
        `SELECT COALESCE(SUM(COALESCE(valor_original, valor)), 0) AS total_pago
         FROM contas_receber
         WHERE venda_id = $1
           AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
           AND LOWER(COALESCE(status, 'pendente')) = 'pago'`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      const totalJaPago = Number(parcelasJaPagasResult.rows[0].total_pago || 0);

      await estornarEstoqueVenda({
        client,
        vendaId: id,
        empresaResolvida,
        usuarioId: req.user.id,
        motivo: `Estorno para edição da venda #${id}`
      });

      await removerDadosDependentesVenda({
        client,
        vendaId: id,
        empresaResolvida
      });

      const vendaAtualizadaResult = await client.query(
        `
        UPDATE vendas
        SET empresa = $1,
            empresa_id = $2,
            cliente_id = $3,
            cliente_nome = $4,
            subtotal = $5,
            desconto = $6,
            acrescimo = $7,
            total = $8,
            pagamento = $9,
            parcelas = $10,
            status_pagamento = $11,
            data = $12,
            observacao = $13,
            atualizado_em = NOW()
        WHERE id = $14 AND (empresa_id = $15 OR (empresa_id IS NULL AND empresa = $1))
        RETURNING *
`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          clienteIdFinal,
          clienteNomeFinal,
          subtotalFinal,
          descontoFinal,
          acrescimoFinal,
          totalFinal,
          sanitizarFormaPagamento(pagamento),
          parcelasFinal,
          (['pendente','atrasado','pago','parcial','parcial_atrasado'].includes(status_pagamento) ? status_pagamento : 'pago'),
          dataFinal,
          observacao || '',
          id,
          empresaResolvida.id
        ]
      );

      if (vendaAtualizadaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Venda não encontrada para atualização');
      }

      const somaItens = await inserirItensVendaEBaixarEstoque({
        client,
        vendaId: id,
        empresaResolvida,
        itens,
        usuarioId: req.user.id,
        clienteId: clienteIdFinal ? Number(clienteIdFinal) : null
      });

      // Confere se o total informado bate com a soma real dos itens (com tolerância de arredondamento)
      const totalEsperadoEdicao = Number((somaItens - descontoFinal + acrescimoFinal).toFixed(2));
      const toleranciaTotalEdicao = 0.05;
      if (Math.abs(totalEsperadoEdicao - totalFinal) > toleranciaTotalEdicao) {
        await client.query('ROLLBACK');
        return erro(res, 400, `Total da venda (R$ ${totalFinal.toFixed(2)}) não corresponde à soma dos itens com desconto/acréscimo (R$ ${totalEsperadoEdicao.toFixed(2)}).`);
      }

      if (
        deveGerarFinanceiroVenda({
          conta_receber,
          pagamento,
          status_pagamento,
          parcelas: parcelasFinal
        })
      ) {
        const saldoPendente = Number((totalFinal - totalJaPago).toFixed(2));
        if (saldoPendente > 0) {
          // VP-C2: garantir que o vencimento não seja no passado
          const dataVenc = dataFinal < hoje() ? hoje() : dataFinal;
          await criarParcelasContasReceber({
            client,
            empresa: empresaResolvida.nome,
            empresa_id: empresaResolvida.id,
            venda_id: id,
            cliente_id: clienteIdFinal,
            cliente_nome: clienteNomeFinal,
            total: saldoPendente,
            quantidade_parcelas: parcelasFinal,
            data_primeiro_vencimento: dataVenc,
            intervalo_dias: 30,
            observacao: observacao || '',
            criado_por: req.user.id,
            forma_pagamento: pagamento || 'Promissória'
          });
        }
      }

      await client.query('COMMIT');

      try {
        await registrarAuditoria({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          usuario_id: req.user.id,
          usuario_nome: req.user.nome || '',
          modulo: 'vendas',
          acao: 'edicao',
          referencia_id: id,
          dados_anteriores: vendaAtual,
          dados_novos: {
            cliente_id: clienteIdFinal,
            cliente_nome: clienteNomeFinal,
            subtotal: subtotalFinal,
            desconto: descontoFinal,
            acrescimo: acrescimoFinal,
            total: totalFinal,
            pagamento: pagamento || 'Dinheiro',
            parcelas: parcelasFinal,
            status_pagamento: status_pagamento || 'pago',
            itens: itens.map((i) => ({
              produto_id: i.produto_id,
              quantidade: i.quantidade,
              preco_unitario: i.preco_unitario
            }))
          },
          req
        });
      } catch (e) { console.error('[vendas] audit:', e.message); }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[venda-editar] status-cr:', e.message); }

      return res.json({
        sucesso: true,
        mensagem: 'Venda editada com sucesso',
        dados: {
          venda_id: id
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro real ao editar venda:', error);
      return erro(res, 500, 'Erro ao editar venda');
    } finally {
      client.release();
    }
  });

  router.patch('/:id/observacao', auth, writeRateLimiter, requirePermissao(pool, 'vendas', 'editar'), async (req, res) => {
    try {
      if (!podeGerenciarVendas(req)) {
        return erro(res, 403, 'Sem permissão para editar vendas');
      }

      const id = Number(req.params.id);
      const { empresa, observacao } = req.body;

      if (!id) {
        return erro(res, 400, 'Venda inválida');
      }

      const client = await pool.connect();
      let vendaResult, venda, empresaResolvida, result;
      try {
        await client.query('BEGIN');

        vendaResult = req.user.is_saas_owner
          ? await client.query(`SELECT * FROM vendas WHERE id = $1 LIMIT 1 FOR UPDATE`, [id])
          : await client.query(
              `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1 FOR UPDATE`,
              [id, req.user.empresa_id || 0, req.user.empresa || '']
            );

        if (vendaResult.rowCount === 0) {
          await client.query('ROLLBACK');
          client.release();
          return erro(res, 404, 'Venda não encontrada');
        }

        venda = vendaResult.rows[0];
        const empresaBase = empresa || venda.empresa;
        empresaResolvida = await validarAcessoEmpresa(req, empresaBase);

        if (!empresaResolvida) {
          await client.query('ROLLBACK');
          client.release();
          return erro(res, 403, 'Sem acesso');
        }

        const vendaEmpresaId = venda.empresa_id ? Number(venda.empresa_id) : null;
        const pertenceEmpresa =
          (vendaEmpresaId && vendaEmpresaId === Number(empresaResolvida.id)) ||
          (!vendaEmpresaId && venda.empresa === empresaResolvida.nome);

        if (!pertenceEmpresa) {
          await client.query('ROLLBACK');
          client.release();
          return erro(res, 403, 'Venda não pertence à empresa autenticada');
        }

        result = await client.query(
          `UPDATE vendas
           SET observacao = $1, atualizado_em = NOW()
           WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
           RETURNING id, observacao`,
          [observacao || '', id, empresaResolvida.id, empresaResolvida.nome]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        throw txErr;
      }
      client.release();

      if (result.rowCount === 0) {
        return erro(res, 404, 'Venda não encontrada para atualização');
      }

      try {
        await registrarAuditoria({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          usuario_id: req.user.id,
          usuario_nome: req.user.nome || '',
          modulo: 'vendas',
          acao: 'edicao_observacao',
          referencia_id: id,
          dados_anteriores: {
            observacao: venda.observacao || ''
          },
          dados_novos: {
            observacao: observacao || ''
          },
          req
        });
      } catch (auditErr) {
        console.error('[auditoria] edicao_observacao venda:', auditErr.message);
      }

      return res.json({
        sucesso: true,
        mensagem: 'Observação atualizada com sucesso',
        dados: result.rows[0]
      });
    } catch (error) {
      console.error('Erro real ao editar observação da venda:', error);
      return erro(res, 500, 'Erro ao editar observação da venda');
    }
  });

  return router;
};
