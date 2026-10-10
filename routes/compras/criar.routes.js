'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const {
  normalizarDecimal, normalizarInt, normalizarDataISO, hoje, addDias, validarECalcularTotalItens
} = require('../../utils/normalizadores');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 1/3 de compras.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): criação de compra.
module.exports = function comprasCriarRoutes({
  auth, pool, writeRateLimiter, validarAcessoEmpresa, podeGerenciarCompras,
  registrarMovimentacaoEstoque, atualizarStatusContasPagarPorEmpresa, registrarAuditoria
}) {
  const router = express.Router();

  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'compras', 'criar'), async (req, res) => {
    if (!podeGerenciarCompras(req)) {
      return erro(res, 403, 'Sem permissão para compras');
    }

    const {
      empresa,
      fornecedor_id,
      data,
      pagamento,
      parcelas,
      observacao,
      primeiro_vencimento,
      itens,
      idempotency_key
    } = req.body;

    if (!fornecedor_id || !data || !pagamento || !Array.isArray(itens) || itens.length === 0) {
      return erro(res, 400, 'Dados da compra incompletos');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return erro(res, 403, 'Sem acesso');
    }

    // Idempotência: retorna a compra existente se a key já foi processada
    if (idempotency_key) {
      const keyStr = String(idempotency_key).slice(0, 128);
      const existente = await pool.query(
        `SELECT id FROM compras WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $3)) AND idempotency_key = $2 LIMIT 1`,
        [empresaResolvida.id, keyStr, empresaResolvida.nome]
      );
      if (existente.rowCount > 0) {
        return ok(res, { compra_id: existente.rows[0].id, dados: { compra_id: existente.rows[0].id }, idempotente: true });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const fornecedorResult = await client.query(
        `SELECT * FROM fornecedores WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL`,
        [fornecedor_id, empresaResolvida.id, empresaResolvida.nome]
      );

      if (fornecedorResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Fornecedor não encontrado');
      }

      const fornecedor = fornecedorResult.rows[0];

      const totalCalculado = validarECalcularTotalItens(itens);

      if (totalCalculado === null) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Itens da compra inválidos');
      }

      const FORMAS_PAGAMENTO_COMPRA_VALIDAS = [
        'dinheiro', 'pix', 'cartao', 'cartao_credito', 'cartao_debito',
        'boleto', 'promissoria', 'duplicata mercantil',
        'transferencia', 'cheque', 'prazo', 'outros', 'outro'
      ];
      const pagamentoNormalizado = String(pagamento || '').toLowerCase();
      if (pagamentoNormalizado && !FORMAS_PAGAMENTO_COMPRA_VALIDAS.includes(pagamentoNormalizado)) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Forma de pagamento inválida');
      }
      const geraContaPagar =
        pagamentoNormalizado === 'boleto' ||
        pagamentoNormalizado === 'promissoria' ||
        pagamentoNormalizado === 'duplicata mercantil';
      const parcelasFinal = geraContaPagar ? Math.max(1, Math.min(120, normalizarInt(parcelas || 1) || 1)) : 1;

      const keyFinal = idempotency_key ? String(idempotency_key).slice(0, 128) : null;
      const compraResult = await client.query(
        `INSERT INTO compras
        (empresa, empresa_id, fornecedor_id, data, total, observacao, gerar_conta_pagar, pagamento, status, criado_por, idempotency_key, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'finalizada', $9, $10, NOW(), NOW())
        RETURNING *`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          fornecedor_id,
          normalizarDataISO(data) || hoje(),
          totalCalculado,
          observacao || '',
          geraContaPagar,
          pagamentoNormalizado || 'dinheiro',
          req.user.id,
          keyFinal
        ]
      );

      const compra = compraResult.rows[0];

      // Pré-busca todos os produtos em 1 SELECT FOR UPDATE com ids ordenados (evita deadlock)
      const idsProdutos = [...new Set(itens.map(i => Number(i.produto_id)))].sort((a, b) => a - b);
      const produtosResult = await client.query(
        `SELECT * FROM produtos WHERE id = ANY($1::int[]) AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL FOR UPDATE`,
        [idsProdutos, empresaResolvida.id, empresaResolvida.nome]
      );
      const produtosMap = Object.fromEntries(produtosResult.rows.map(p => [Number(p.id), p]));

      // ── Loop acumula dados em JS puro (zero queries) ──────────────────────
      const compraItensRows = [];   // para INSERT compra_itens
      const prodUpdMap      = {};   // para UPDATE produtos (deduplicado por produto_id)
      const movRows         = [];   // para INSERT movimentacoes_estoque

      for (const item of itens) {
        const produtoId     = Number(item.produto_id);
        const quantidade    = normalizarInt(item.quantidade);
        const custoUnitario = normalizarDecimal(item.custo_unitario ?? item.preco_unitario ?? item.custo);
        const subtotalItem  = Number((quantidade * custoUnitario).toFixed(2));

        if (quantidade <= 0) {
          await client.query('ROLLBACK');
          return erro(res, 400, `Quantidade do produto ${produtoId} deve ser maior que zero`);
        }
        if (custoUnitario <= 0) {
          await client.query('ROLLBACK');
          return erro(res, 400, `Custo unitário do produto ${produtoId} deve ser maior que zero`);
        }

        const produto = produtosMap[produtoId];
        if (!produto) {
          await client.query('ROLLBACK');
          return erro(res, 404, `Produto ${produtoId} não encontrado`);
        }

        const estoqueAtual  = normalizarInt(produto.estoque);
        const novoEstoque   = estoqueAtual + quantidade;
        const custoAtual    = Number(produto.custo_medio || produto.custo || 0);
        const novoCustoMedio = novoEstoque > 0
          ? Number(((estoqueAtual * custoAtual + quantidade * custoUnitario) / novoEstoque).toFixed(2))
          : custoUnitario;
        const precoProduto   = Number(produto.preco || 0);
        const lucroUnitario  = Number((precoProduto - novoCustoMedio).toFixed(2));
        const margemLucroRaw = precoProduto > 0
          ? Number(((lucroUnitario / precoProduto) * 100).toFixed(2)) : 0;
        const margemLucro = Math.min(Math.max(margemLucroRaw, -9999), 9999);

        compraItensRows.push([
          compra.id, empresaResolvida.nome, empresaResolvida.id,
          produto.id, produto.nome, quantidade, custoUnitario, subtotalItem
        ]);

        // Mantém só o último update por produto (produto duplicado na mesma compra)
        prodUpdMap[produtoId] = {
          id: produto.id, novoEstoque, custoUnitario, novoCustoMedio, lucroUnitario, margemLucro
        };

        movRows.push([
          empresaResolvida.nome, empresaResolvida.id, produto.id, null,
          'entrada_compra', quantidade,
          `Entrada por compra #${compra.id}`, 'compra', compra.id, req.user.id
        ]);

        // Atualiza mapa para itens duplicados do mesmo produto na mesma compra
        produtosMap[produtoId] = { ...produto, estoque: novoEstoque, custo_medio: novoCustoMedio };
      }

      // ── Batch INSERT compra_itens (chunked — evita limite 65535 params PG) ─
      {
        const COLS = 8;
        const CHUNK_SIZE = 1000; // 1000 × 8 = 8000 params por chunk
        for (let ci = 0; ci < compraItensRows.length; ci += CHUNK_SIZE) {
          const chunk = compraItensRows.slice(ci, ci + CHUNK_SIZE);
          let idx = 1;
          const placeholders = chunk.map(() =>
            `(${Array.from({ length: COLS }, () => `$${idx++}`).join(',')})`
          ).join(',');
          await client.query(
            `INSERT INTO compra_itens
               (compra_id, empresa, empresa_id, produto_id, produto_nome, quantidade, custo_unitario, subtotal)
             VALUES ${placeholders}`,
            chunk.flat()
          );
        }
      }

      // ── UPDATE produtos — sequential, deduplicado por produto_id ─────────
      for (const upd of Object.values(prodUpdMap)) {
        await client.query(
          `UPDATE produtos
             SET estoque=$1, custo=$2, custo_unitario=$3, custo_medio=$4,
                 lucro_unitario=$5, margem_lucro=$6, atualizado_em=NOW()
           WHERE id=$7 AND (empresa_id=$8 OR (empresa_id IS NULL AND empresa=$9))`,
          [
            upd.novoEstoque, upd.custoUnitario, upd.custoUnitario,
            upd.novoCustoMedio, upd.lucroUnitario, upd.margemLucro,
            upd.id, empresaResolvida.id, empresaResolvida.nome
          ]
        );
      }

      // ── Batch INSERT movimentacoes_estoque (chunked — evita limite 65535 params PG) ──
      if (typeof registrarMovimentacaoEstoque === 'function' && movRows.length > 0) {
        const COLS = 10; // data_movimentacao = NOW() inline
        const CHUNK_SIZE = 1000; // 1000 × 10 = 10000 params por chunk
        for (let mi = 0; mi < movRows.length; mi += CHUNK_SIZE) {
          const chunk = movRows.slice(mi, mi + CHUNK_SIZE);
          let idx = 1;
          const placeholders = chunk.map(() =>
            `(${Array.from({ length: COLS }, () => `$${idx++}`).join(',')},NOW())`
          ).join(',');
          await client.query(
            `INSERT INTO movimentacoes_estoque
               (empresa, empresa_id, produto_id, grade_id, tipo, quantidade,
                observacao, referencia_tipo, referencia_id, usuario_id, data_movimentacao)
             VALUES ${placeholders}`,
            chunk.flat()
          );
        }
      }

      // ── Batch INSERT contas_pagar (1 query, multi-row VALUES) ─────────────
      if (geraContaPagar) {
        const dataPrimeiroVencimento =
          normalizarDataISO(primeiro_vencimento || data) || normalizarDataISO(data) || hoje();
        const intervaloDias = 30;
        const valorBase     = Number((totalCalculado / parcelasFinal).toFixed(2));

        const contasRows = [];
        let acumulado = 0;
        for (let i = 1; i <= parcelasFinal; i++) {
          const valorParcela = i === parcelasFinal
            ? Number((totalCalculado - acumulado).toFixed(2))
            : valorBase;
          acumulado = Number((acumulado + valorParcela).toFixed(2));
          const vencimento  = i === 1
            ? dataPrimeiroVencimento
            : addDias(dataPrimeiroVencimento, (i - 1) * intervaloDias);
          contasRows.push([
            empresaResolvida.nome, empresaResolvida.id,
            fornecedor.id, fornecedor.nome, compra.id,
            `Parcela ${i}/${parcelasFinal} - Compra #${compra.id}`,
            i, parcelasFinal, valorParcela, vencimento,
            pagamentoNormalizado, observacao || '', req.user.id
          ]);
        }

        // 13 colunas parametrizadas + data_pagamento=NULL, status='pendente', criado_em=NOW(), atualizado_em=NOW() inline
        let idx = 1;
        const placeholders = contasRows.map(() =>
          `($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},NULL,'pendente',$${idx++},$${idx++},$${idx++},NOW(),NOW())`
        ).join(',');
        // SJ-B2: incluir valor_original igual a valor para permitir auditoria de saldo devedor
        const contasRowsComOriginal = contasRows.map(row => {
          const valor = row[8]; // índice do campo valor
          return [...row.slice(0, 9), valor, ...row.slice(9)];
        });
        await client.query(
          `INSERT INTO contas_pagar
             (empresa, empresa_id, fornecedor_id, fornecedor_nome, compra_id,
              descricao, parcela, total_parcelas, valor, valor_original, data_vencimento,
              data_pagamento, status, forma_pagamento, observacao, criado_por,
              criado_em, atualizado_em)
           VALUES ${placeholders}`,
          contasRowsComOriginal.flat()
        );
      }

      await client.query('COMMIT');

      try {
        await registrarAuditoria({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          usuario_id: req.user.id,
          usuario_nome: req.user.nome || '',
          modulo: 'compras',
          acao: 'cadastro',
          referencia_id: compra.id,
          dados_novos: {
            fornecedor_id,
            fornecedor_nome: fornecedor.nome,
            data,
            total: totalCalculado,
            pagamento: pagamentoNormalizado,
            parcelas: parcelasFinal,
            gerar_conta_pagar: geraContaPagar,
            itens: itens.map((i) => ({
              produto_id: i.produto_id,
              quantidade: i.quantidade,
              custo_unitario: i.custo_unitario || i.preco_unitario || i.custo
            }))
          },
          req
        });
      } catch (e) { console.error('[compras] audit:', e.message); }

      // Fire-and-forget — não bloqueia a resposta ao usuário
      if (typeof atualizarStatusContasPagarPorEmpresa === 'function') {
        atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id)
          .catch((e) => console.error('[compras-criar] status-cp:', e.message));
      }

      return ok(res, {
        compra_id: compra.id,
        dados: {
          compra_id: compra.id
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro real ao criar compra:', error);
      return erro(res, 500, 'Erro ao criar compra');
    } finally {
      client.release();
    }
  });

  return router;
};
