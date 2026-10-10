'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const {
  normalizarDecimal, normalizarInt, normalizarDataISO, hoje, addDias, validarECalcularTotalItens
} = require('../../utils/normalizadores');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 2/3 de compras.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): edição de compra.
module.exports = function comprasEditarRoutes({
  auth, pool, writeRateLimiter, validarAcessoEmpresa, podeGerenciarCompras,
  registrarMovimentacaoEstoque, atualizarStatusContasPagarPorEmpresa, registrarAuditoria
}) {
  const router = express.Router();

  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'compras', 'editar'), async (req, res) => {
    if (!podeGerenciarCompras(req)) return erro(res, 403, 'Sem permissão para compras');

    const id = Number(req.params.id);
    const { empresa, fornecedor_id, data, pagamento, parcelas, observacao, primeiro_vencimento, itens } = req.body;

    if (!id || !fornecedor_id || !data || !pagamento || !Array.isArray(itens) || itens.length === 0) {
      return erro(res, 400, 'Dados da compra incompletos');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const compraAtual = await client.query(
        `SELECT * FROM compras WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) FOR UPDATE`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (compraAtual.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Compra não encontrada');
      }

      const contasPagas = await client.query(
        `SELECT COUNT(*) AS total FROM contas_pagar
         WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND LOWER(status) = 'pago'`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (Number(contasPagas.rows[0].total) > 0) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Não é possível editar uma compra com contas a pagar já pagas');
      }

      // Reverter estoque dos itens originais
      const itensOriginais = await client.query(
        `SELECT * FROM compra_itens WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      // Pré-busca todos os produtos originais em 1 SELECT FOR UPDATE (ORDER BY id = lock consistente)
      const idsOriginais = [...new Set(itensOriginais.rows.map(r => Number(r.produto_id)))].sort((a, b) => a - b);
      if (idsOriginais.length > 0) {
        const prodsOriginaisResult = await client.query(
          `SELECT id, estoque, custo_medio, custo FROM produtos WHERE id = ANY($1::int[]) AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) FOR UPDATE`,
          [idsOriginais, empresaResolvida.id, empresaResolvida.nome]
        );
        const prodsOriginaisMap = Object.fromEntries(prodsOriginaisResult.rows.map(p => [Number(p.id), p]));

        for (const item of itensOriginais.rows) {
          const prod = prodsOriginaisMap[Number(item.produto_id)];
          if (!prod) continue;
          const estoqueAtual  = normalizarInt(prod.estoque);
          const custoAtual    = Number(prod.custo_medio || prod.custo || 0);
          const qtdOriginal   = normalizarInt(item.quantidade);
          const custoOriginal = Number(item.custo_unitario || 0);
          if (estoqueAtual !== null && qtdOriginal !== null && estoqueAtual < qtdOriginal) {
            await client.query('ROLLBACK');
            return erro(res, 400, `Produto ${item.produto_id}: ${qtdOriginal - estoqueAtual} unidade(s) desta compra já foram utilizadas. Reverta as movimentações antes de editar.`);
          }
          const estoqueRevertido = (estoqueAtual || 0) - (qtdOriginal || 0);
          const custoRevertido = (() => {
            if (estoqueRevertido <= 0) return custoAtual;
            const calc = (estoqueAtual * custoAtual - qtdOriginal * custoOriginal) / estoqueRevertido;
            return calc > 0 ? Number(calc.toFixed(2)) : custoAtual;
          })();

          await client.query(
            `UPDATE produtos SET estoque = $1, custo_medio = $2, atualizado_em = NOW()
             WHERE id = $3 AND (empresa_id = $4 OR (empresa_id IS NULL AND empresa = $5))`,
            [estoqueRevertido, custoRevertido, Number(item.produto_id), empresaResolvida.id, empresaResolvida.nome]
          );
          // Atualiza o mapa para itens duplicados na mesma compra
          prodsOriginaisMap[Number(item.produto_id)] = { ...prod, estoque: estoqueRevertido, custo_medio: custoRevertido };
        }
      }

      // Limpar dados originais
      await client.query(
        `DELETE FROM compra_itens WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      await client.query(
        `DELETE FROM movimentacoes_estoque WHERE referencia_tipo = 'compra' AND referencia_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      await client.query(
        `DELETE FROM contas_pagar WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND LOWER(status) != 'pago'`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      const totalCalculado = validarECalcularTotalItens(itens);
      if (totalCalculado === null) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Itens da compra inválidos');
      }

      const FORMAS_PAGAMENTO_VALIDAS = [
        'dinheiro', 'pix', 'cartao', 'cartao_credito', 'cartao_debito',
        'boleto', 'promissoria', 'duplicata mercantil',
        'transferencia', 'cheque', 'prazo', 'outros', 'outro'
      ];
      if (pagamento && !FORMAS_PAGAMENTO_VALIDAS.includes(String(pagamento).toLowerCase())) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'forma_pagamento inválida');
      }

      const pagamentoNormalizado = String(pagamento || '').toLowerCase();
      const geraContaPagar = pagamentoNormalizado === 'boleto' || pagamentoNormalizado === 'promissoria' || pagamentoNormalizado === 'duplicata mercantil';
      const parcelasFinal = geraContaPagar ? Math.max(1, Math.min(120, normalizarInt(parcelas || 1) || 1)) : 1;

      // Buscar fornecedor
      const fornecedorResult = await client.query(
        `SELECT * FROM fornecedores WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL`,
        [fornecedor_id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (fornecedorResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Fornecedor não encontrado');
      }
      const fornecedor = fornecedorResult.rows[0];

      // Atualizar compra
      await client.query(
        `UPDATE compras SET fornecedor_id=$1, data=$2, total=$3, observacao=$4, pagamento=$5, gerar_conta_pagar=$6, atualizado_em=NOW()
         WHERE id=$7 AND (empresa_id=$8 OR (empresa_id IS NULL AND empresa = $9))`,
        [fornecedor_id, normalizarDataISO(data) || hoje(), totalCalculado, observacao || '', pagamentoNormalizado, geraContaPagar, id, empresaResolvida.id, empresaResolvida.nome]
      );

      // Aplicar novos itens — pré-busca todos em 1 SELECT FOR UPDATE (ORDER BY id = lock consistente)
      const idsNovos = [...new Set(itens.map(i => Number(i.produto_id)))].sort((a, b) => a - b);
      const prodsNovosResult = await client.query(
        `SELECT * FROM produtos WHERE id = ANY($1::int[]) AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL FOR UPDATE`,
        [idsNovos, empresaResolvida.id, empresaResolvida.nome]
      );
      const prodsNovosMap = Object.fromEntries(prodsNovosResult.rows.map(p => [Number(p.id), p]));

      // Valida todos os produtos antes de iniciar as escritas
      for (const item of itens) {
        if (!prodsNovosMap[Number(item.produto_id)]) {
          await client.query('ROLLBACK');
          return erro(res, 404, `Produto ${Number(item.produto_id)} não encontrado`);
        }
      }

      for (const item of itens) {
        const produtoId     = Number(item.produto_id);
        const quantidade    = normalizarInt(item.quantidade);
        const custoUnitario = normalizarDecimal(item.custo_unitario || item.custo);
        const produto       = prodsNovosMap[produtoId];

        const estoqueAtual  = normalizarInt(produto.estoque);
        const novoEstoque   = estoqueAtual + quantidade;
        const custoAtual    = Number(produto.custo_medio || produto.custo || 0);
        const novoCustoMedio = novoEstoque > 0
          ? Number(((estoqueAtual * custoAtual + quantidade * custoUnitario) / novoEstoque).toFixed(2))
          : custoUnitario;
        const precoProduto  = Number(produto.preco || 0);
        const lucroUnitario  = Number((precoProduto - novoCustoMedio).toFixed(2));
        const margemLucroRaw = precoProduto > 0 ? Number(((lucroUnitario / precoProduto) * 100).toFixed(2)) : 0;
        const margemLucro    = Math.min(Math.max(margemLucroRaw, -9999), 9999);

        await client.query(
          `INSERT INTO compra_itens (compra_id, empresa, empresa_id, produto_id, produto_nome, quantidade, custo_unitario, subtotal)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, empresaResolvida.nome, empresaResolvida.id, produto.id, produto.nome, quantidade, custoUnitario, Number((quantidade * custoUnitario).toFixed(2))]
        );

        await client.query(
          `UPDATE produtos SET estoque=$1, custo=$2, custo_unitario=$3, custo_medio=$4, lucro_unitario=$5, margem_lucro=$6, atualizado_em=NOW()
           WHERE id=$7 AND (empresa_id=$8 OR (empresa_id IS NULL AND empresa = $9))`,
          [novoEstoque, custoUnitario, custoUnitario, novoCustoMedio, lucroUnitario, margemLucro, produto.id, empresaResolvida.id, empresaResolvida.nome]
        );

        // Atualiza mapa para produto duplicado na mesma compra
        prodsNovosMap[produtoId] = { ...produto, estoque: novoEstoque, custo_medio: novoCustoMedio };

        if (typeof registrarMovimentacaoEstoque === 'function') {
          await registrarMovimentacaoEstoque({
            empresa: empresaResolvida.nome, empresa_id: empresaResolvida.id,
            produto_id: produto.id, tipo: 'entrada_compra', quantidade,
            observacao: `Entrada por compra #${id} (editada)`,
            referencia_tipo: 'compra', referencia_id: id, usuario_id: req.user.id, client
          });
        }
      }

      // Recriar contas_pagar se necessário
      if (geraContaPagar) {
        const dataPrimeiroVencimento = normalizarDataISO(primeiro_vencimento || data) || normalizarDataISO(data) || hoje();
        const valorBase = Number((totalCalculado / parcelasFinal).toFixed(2));
        let acumulado = 0;
        for (let i = 1; i <= parcelasFinal; i++) {
          let valorParcela = valorBase;
          if (i === parcelasFinal) valorParcela = Number((totalCalculado - acumulado).toFixed(2));
          acumulado = Number((acumulado + valorParcela).toFixed(2));
          const vencimento = i === 1 ? dataPrimeiroVencimento : addDias(dataPrimeiroVencimento, (i - 1) * 30);
          await client.query(
            `INSERT INTO contas_pagar (empresa, empresa_id, fornecedor_id, fornecedor_nome, compra_id, descricao, parcela, total_parcelas, valor, valor_original, data_vencimento, data_pagamento, status, forma_pagamento, observacao, criado_por, criado_em, atualizado_em)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,NULL,'pendente',$11,$12,$13,NOW(),NOW())`,
            [empresaResolvida.nome, empresaResolvida.id, fornecedor.id, fornecedor.nome, id,
             `Parcela ${i}/${parcelasFinal} - Compra #${id}`, i, parcelasFinal, valorParcela, vencimento,
             pagamentoNormalizado, observacao || '', req.user.id]
          );
        }
      }

      await client.query('COMMIT');

      try {
        await registrarAuditoria({
          empresa: empresaResolvida.nome, empresa_id: empresaResolvida.id,
          usuario_id: req.user.id, usuario_nome: req.user.nome || '',
          modulo: 'compras', acao: 'edicao', referencia_id: id,
          dados_novos: { fornecedor_id, data, total: totalCalculado, pagamento: pagamentoNormalizado, parcelas: parcelasFinal },
          req
        });
      } catch (e) { console.error('[compras] audit:', e.message); }

      if (typeof atualizarStatusContasPagarPorEmpresa === 'function') {
        try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[compras-editar] status-cp:', e.message); }
      }

      return ok(res, { mensagem: 'Compra atualizada com sucesso' });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro real ao editar compra:', error);
      return erro(res, 500, 'Erro ao editar compra');
    } finally {
      client.release();
    }
  });

  return router;
};
