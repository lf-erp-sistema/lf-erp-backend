'use strict';

const {
  normalizarTexto, deveGerarFinanceiroVenda, normalizarPagamentosSplit
} = require('./vendasOps');

// Extraído de routes/vendas.routes.js (achado ARCH-02 da Auditoria 360, 2026-10-06):
// o núcleo transacional de criação de venda vivia dentro do handler HTTP (POST /vendas),
// impossível de testar sem subir o Express inteiro. Esta função é a mesma lógica,
// byte a byte, só parametrizada (sem req/res) -- chamável pela rota OU por teste direto.
//
// Rejeições de negócio esperadas (caixa fechado, limite de plano, cliente não encontrado,
// desconto negativo, total não bate) voltam como { ok: false, status, mensagem } -- a
// rota devolve isso direto ao cliente, igual ao "return erro(...)" que existia inline no
// handler original, SEM logar como erro (não é bug, é validação normal).
// Qualquer outra falha (ex. estoque insuficiente lançado por inserirItensVendaEBaixarEstoque,
// erro de conexão) continua sendo uma exceção real, propagada pra rota logar e responder 500 --
// exatamente como o catch genérico do handler original já fazia.
function createVendasService({
  pool,
  normalizarDecimal,
  normalizarInt,
  normalizarDataISO,
  hoje,
  validarLimiteVendasMes,
  criarParcelasContasReceber,
}) {
  async function criarVenda({ client, empresaResolvida, usuarioId, body, inserirItensVendaEBaixarEstoque }) {
    const {
      cliente_id,
      cliente_nome,
      subtotal,
      desconto,
      acrescimo,
      total,
      pagamento,
      pagamentos,
      parcelas,
      status_pagamento,
      data,
      observacao,
      conta_receber,
      itens,
      idempotency_key
    } = body;

    if (!Array.isArray(itens) || itens.length === 0) {
      return { ok: false, status: 400, mensagem: 'Dados da venda incompletos' };
    }

    const idempotencyKey = idempotency_key || null;

    const sessaoCaixa = await pool.query(
      `SELECT id FROM caixa_sessoes WHERE empresa_id = $1 AND fechado_em IS NULL LIMIT 1`,
      [empresaResolvida.id]
    );
    if (sessaoCaixa.rowCount === 0) {
      return { ok: false, status: 400, mensagem: 'Caixa não está aberto. Abra o caixa antes de registrar uma venda.' };
    }

    const limiteVendas = await validarLimiteVendasMes(empresaResolvida);
    if (!limiteVendas.permitido) {
      return { ok: false, status: 403, mensagem: limiteVendas.mensagem };
    }

    await client.query('BEGIN');

    // Deduplicação por idempotency_key dentro da transação — evita race condition entre requests paralelos
    if (idempotencyKey) {
      try {
        const existing = await client.query(
          `SELECT id FROM vendas WHERE idempotency_key = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1 FOR UPDATE`,
          [idempotencyKey, empresaResolvida.id, empresaResolvida.nome]
        );
        if (existing.rows.length > 0) {
          await client.query('ROLLBACK');
          return { ok: true, deduplicated: true, venda: { id: existing.rows[0].id } };
        }
      } catch (_e) {
        // Coluna idempotency_key ainda não existe no schema — ignorar verificação (migration pendente)
      }
    }

    let clienteNomeFinal = cliente_nome || '';
    let clienteIdFinal = cliente_id || null;

    if (clienteIdFinal) {
      const clienteResult = await client.query(
        `SELECT * FROM clientes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL`,
        [clienteIdFinal, empresaResolvida.id, empresaResolvida.nome]
      );

      if (clienteResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return { ok: false, status: 404, mensagem: 'Cliente não encontrado' };
      }

      clienteNomeFinal = clienteResult.rows[0].nome;
    }

    const subtotalFinal = normalizarDecimal(subtotal) ?? 0;
    const descontoFinal = normalizarDecimal(desconto) ?? 0;
    const acrescimoFinal = normalizarDecimal(acrescimo) ?? 0;
    const totalFinal = normalizarDecimal(total) ?? 0;

    // FIX 2: rejeitar desconto/acréscimo negativos
    if (descontoFinal < 0) { await client.query('ROLLBACK'); return { ok: false, status: 400, mensagem: 'Desconto não pode ser negativo' }; }
    if (acrescimoFinal < 0) { await client.query('ROLLBACK'); return { ok: false, status: 400, mensagem: 'Acréscimo não pode ser negativo' }; }

    const {
      pagamentosArray,
      pagamentoPrincipal,
      totalPromissoria,
      statusPagamento: statusFinal
    } = normalizarPagamentosSplit({ pagamentos, pagamento, total: totalFinal, status_pagamento, parcelas });

    // Dados de parcelas da entrada Promissória (se houver)
    const promissoriaEntry = pagamentosArray.find(
      (p) => ['promissoria', 'promissória'].includes(normalizarTexto(p.forma))
    );

    const vendaResult = await client.query(
      `INSERT INTO vendas
      (empresa, empresa_id, cliente_id, cliente_nome, subtotal, desconto, acrescimo, total, pagamento, pagamentos, parcelas, status_pagamento, data, observacao, criado_por, criado_em, atualizado_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
      RETURNING *`,
      [
        empresaResolvida.nome,
        empresaResolvida.id,
        clienteIdFinal,
        clienteNomeFinal,
        subtotalFinal,
        descontoFinal,
        acrescimoFinal,
        totalFinal,
        pagamentoPrincipal,
        JSON.stringify(pagamentosArray),
        Math.max(1, promissoriaEntry ? normalizarInt(promissoriaEntry.parcelas || 1) : normalizarInt(parcelas || 1)),
        statusFinal,
        normalizarDataISO(data) || hoje(),
        observacao || '',
        usuarioId
      ]
    );

    const venda = vendaResult.rows[0];

    const somaItens = await inserirItensVendaEBaixarEstoque({
      client,
      vendaId: venda.id,
      empresaResolvida,
      itens,
      usuarioId,
      clienteId: cliente_id ? Number(cliente_id) : null
    });

    // Confere se o total informado bate com a soma real dos itens (com tolerância de arredondamento)
    const totalEsperado = Number((somaItens - descontoFinal + acrescimoFinal).toFixed(2));
    const toleranciaTotal = 0.05;
    if (Math.abs(totalEsperado - totalFinal) > toleranciaTotal) {
      await client.query('ROLLBACK');
      return {
        ok: false, status: 400,
        mensagem: `Total da venda (R$ ${totalFinal.toFixed(2)}) não corresponde à soma dos itens com desconto/acréscimo (R$ ${totalEsperado.toFixed(2)}).`
      };
    }

    // Gera contas a receber apenas para a parcela Promissória do split
    if (totalPromissoria > 0) {
      await criarParcelasContasReceber({
        client,
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        venda_id: venda.id,
        cliente_id: clienteIdFinal,
        cliente_nome: clienteNomeFinal,
        total: totalPromissoria,
        quantidade_parcelas: Math.max(1, normalizarInt(promissoriaEntry?.parcelas || parcelas || 1)),
        data_primeiro_vencimento: normalizarDataISO(promissoriaEntry?.vencimento || data) || hoje(),
        intervalo_dias: 30,
        observacao: observacao || '',
        criado_por: usuarioId,
        forma_pagamento: 'Promissória'
      });
    } else if (deveGerarFinanceiroVenda({ conta_receber, pagamento: pagamentoPrincipal, status_pagamento: statusFinal, parcelas })) {
      // Retrocompatibilidade: venda sem split mas com conta_receber explícita
      await criarParcelasContasReceber({
        client,
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        venda_id: venda.id,
        cliente_id: clienteIdFinal,
        cliente_nome: clienteNomeFinal,
        total: totalFinal,
        quantidade_parcelas: Math.max(1, normalizarInt(parcelas || 1)),
        data_primeiro_vencimento: normalizarDataISO(data) || hoje(),
        intervalo_dias: 30,
        observacao: observacao || '',
        criado_por: usuarioId,
        forma_pagamento: pagamentoPrincipal || 'Promissória'
      });
    }

    await client.query('COMMIT');

    return {
      ok: true,
      deduplicated: false,
      venda,
      clienteIdFinal,
      clienteNomeFinal,
      subtotalFinal,
      descontoFinal,
      acrescimoFinal,
      totalFinal,
      pagamentoPrincipal
    };
  }

  return { criarVenda };
}

module.exports = { createVendasService };
