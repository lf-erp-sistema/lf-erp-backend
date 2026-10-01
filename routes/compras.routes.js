const express = require('express');
const { requirePermissao } = require('../utils/permissoes');

const {
  normalizarDecimal,
  normalizarInt,
  normalizarDataISO,
  hoje,
  addDias,
  validarECalcularTotalItens
} = require('../utils/normalizadores');
const { erro, ok } = require('../utils/routeHelpers');

module.exports = function ({
  auth,
  pool,
  writeRateLimiter,
  validarAcessoEmpresa,
  podeGerenciarCompras,
  registrarMovimentacaoEstoque,
  atualizarStatusContasPagarPorEmpresa,
  registrarAuditoria
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

  // ── POST /compras/importar-xml ──────────────────────────────────────────────
  // Faz o parse de um XML de NF-e do fornecedor e retorna os dados estruturados.
  // Não cria nada no banco — apenas extrai e retorna para o frontend confirmar.

  function xmlSanitize(xml) {
    if (!xml) return '';
    // Remove comentários XML
    let s = xml.replace(/<!--[\s\S]*?-->/g, '');
    // Expande seções CDATA: <![CDATA[content]]> → content
    s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    return s;
  }

  function xmlTag(xml, tag) {
    if (!xml) return null;
    const s = xmlSanitize(xml);
    // Aceita tanto <tag> quanto <ns:tag> (namespace prefix)
    const openRe = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:[\\s>])`);
    const openMatch = openRe.exec(s);
    if (!openMatch) return null;
    const closeAngle = s.indexOf('>', openMatch.index);
    if (closeAngle === -1) return null;
    // self-closing tag?
    if (s[closeAngle - 1] === '/') return null;
    const closeRe = new RegExp(`</(?:[\\w.-]+:)?${tag}>`);
    const rest = s.slice(closeAngle + 1);
    const closeMatch = closeRe.exec(rest);
    if (!closeMatch) return null;
    return rest.slice(0, closeMatch.index).trim() || null;
  }

  function xmlTagAll(xml, tag) {
    if (!xml) return [];
    const s = xmlSanitize(xml);
    const results = [];
    const openRe  = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:[\\s>])`, 'g');
    const closeRe = new RegExp(`</(?:[\\w.-]+:)?${tag}>`);
    let openMatch;
    while ((openMatch = openRe.exec(s)) !== null && results.length < 1000) {
      const closeAngle = s.indexOf('>', openMatch.index);
      if (closeAngle === -1) break;
      if (s[closeAngle - 1] === '/') continue; // self-closing
      const rest = s.slice(closeAngle + 1);
      const closeMatch = closeRe.exec(rest);
      if (!closeMatch) break;
      results.push(rest.slice(0, closeMatch.index).trim());
      openRe.lastIndex = closeAngle + 1 + closeMatch.index + closeMatch[0].length;
    }
    return results;
  }

  const FORMA_PGTO_NF = {
    '01': 'dinheiro', '02': 'cheque', '03': 'cartao credito',
    '04': 'cartao debito', '05': 'credito loja', '10': 'vale alimentacao',
    '11': 'vale refeicao', '12': 'vale presente', '13': 'vale combustivel',
    '14': 'duplicata mercantil', '15': 'boleto', '17': 'pix', '90': 'sem pagamento', '99': 'outros'
  };

  router.post('/importar-xml', auth, writeRateLimiter, requirePermissao(pool, 'compras', 'criar'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { conteudo } = req.body;
      if (!conteudo) return erro(res, 400, 'Conteúdo XML não informado');
      const MAX_XML_BYTES = 5 * 1024 * 1024; // 5 MB
      if (Buffer.byteLength(String(conteudo), 'utf8') > MAX_XML_BYTES) {
        return erro(res, 400, 'XML excede o limite máximo de 5 MB');
      }

      // ── Emitente (fornecedor) ────────────────────────────────────────────
      const emitBloco = xmlTag(conteudo, 'emit');
      const cnpjFornecedor = emitBloco ? (xmlTag(emitBloco, 'CNPJ') || xmlTag(emitBloco, 'CPF') || '') : '';
      const nomeFornecedor = emitBloco ? (xmlTag(emitBloco, 'xNome') || '') : '';

      // ── Identificação ────────────────────────────────────────────────────
      const ideBloco = xmlTag(conteudo, 'ide');
      const numeroNF = ideBloco ? (xmlTag(ideBloco, 'nNF') || '') : '';
      const dhEmi    = ideBloco ? (xmlTag(ideBloco, 'dhEmi') || xmlTag(ideBloco, 'dEmi') || '') : '';
      const dataEmissao = dhEmi ? dhEmi.slice(0, 10) : null;

      // ── Total ────────────────────────────────────────────────────────────
      const totalBloco = xmlTag(conteudo, 'ICMSTot');
      const totalNF = totalBloco ? parseFloat(xmlTag(totalBloco, 'vNF') || '0') : 0;

      // ── Forma de pagamento ───────────────────────────────────────────────
      const detPagBloco = xmlTag(conteudo, 'detPag') || xmlTag(conteudo, 'pag') || '';
      const tPag = xmlTag(detPagBloco, 'tPag') || '99';
      const formaPagamento = FORMA_PGTO_NF[tPag] || 'outros';

      // ── Itens ────────────────────────────────────────────────────────────
      const detBlocos = xmlTagAll(conteudo, 'det');
      const itens = detBlocos.map((det) => {
        const prod = xmlTag(det, 'prod') || det;
        const codigo  = xmlTag(prod, 'cProd') || '';
        const nome    = xmlTag(prod, 'xProd') || 'Produto';
        const ncm     = xmlTag(prod, 'NCM') || '';
        const unidade = xmlTag(prod, 'uCom') || 'UN';
        const qty     = parseFloat(xmlTag(prod, 'qCom') || '1');
        const vUnit   = parseFloat(xmlTag(prod, 'vUnCom') || '0');
        const vTotal  = parseFloat(xmlTag(prod, 'vProd') || String(qty * vUnit));
        return { codigo, nome, ncm, unidade, quantidade: qty, custo_unitario: vUnit, total: vTotal };
      }).filter(i => i.quantidade > 0);

      if (!itens.length) return erro(res, 400, 'Nenhum item encontrado no XML');

      // Tenta encontrar fornecedor pelo CNPJ
      let fornecedorId = null;
      let fornecedorNome = nomeFornecedor;
      if (cnpjFornecedor) {
        const cnpjLimpo = cnpjFornecedor.replace(/\D/g, '');
        const fRes = await pool.query(
          `SELECT id, nome FROM fornecedores
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
             AND replace(replace(replace(cnpj,'.',''),'-',''),'/','') = $3
             AND deletado_em IS NULL
           LIMIT 1`,
          [empresaResolvida.id, empresaResolvida.nome, cnpjLimpo]
        );
        if (fRes.rowCount > 0) {
          fornecedorId   = fRes.rows[0].id;
          fornecedorNome = fRes.rows[0].nome;
        }
      }

      return ok(res, {
        fornecedor_cnpj: cnpjFornecedor,
        fornecedor_nome: fornecedorNome,
        fornecedor_id:   fornecedorId,
        numero_nf:       numeroNF,
        data_emissao:    dataEmissao,
        total:           totalNF,
        forma_pagamento: formaPagamento,
        itens
      });
    } catch (error) {
      console.error('[compras] importar-xml:', error.message);
      return erro(res, 500, 'Erro ao processar o XML da nota fiscal');
    }
  });

  return router;
};
