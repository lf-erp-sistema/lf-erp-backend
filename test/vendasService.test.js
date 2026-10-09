'use strict';

const { hoje, addDias, normalizarDecimal, normalizarInt, normalizarDataISO } = require('../utils/normalizadores');
const { createVendasService } = require('../utils/vendasService');

// Fábrica do client transacional fake. Suporta BEGIN/COMMIT/ROLLBACK, a dedupe por
// idempotency_key, a busca de cliente e o INSERT INTO vendas (devolve uma linha
// construída a partir dos próprios parâmetros, pra espelhar o RETURNING * real).
function makeFakeClient({ idempotencyExistente = null, clienteEncontrado = undefined } = {}) {
  const calls = [];
  let proximoId = 100;
  const query = jest.fn((sql, params) => {
    calls.push({ sql, params });

    if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
      return Promise.resolve({});
    }
    if (sql.includes('FROM vendas WHERE idempotency_key')) {
      return Promise.resolve(idempotencyExistente
        ? { rows: [{ id: idempotencyExistente }] }
        : { rows: [] });
    }
    if (sql.includes('FROM clientes WHERE id')) {
      if (clienteEncontrado === undefined) return Promise.resolve({ rowCount: 1, rows: [{ nome: 'Cliente do Banco' }] });
      return Promise.resolve(clienteEncontrado ? { rowCount: 1, rows: [clienteEncontrado] } : { rowCount: 0, rows: [] });
    }
    if (sql.includes('INSERT INTO vendas')) {
      const id = proximoId++;
      return Promise.resolve({
        rows: [{
          id,
          empresa: params[0], empresa_id: params[1], cliente_id: params[2], cliente_nome: params[3],
          subtotal: params[4], desconto: params[5], acrescimo: params[6], total: params[7],
          pagamento: params[8], pagamentos: params[9], parcelas: params[10], status_pagamento: params[11],
          data: params[12], observacao: params[13], criado_por: params[14],
        }],
      });
    }
    return Promise.resolve({ rows: [] });
  });
  return { query, calls };
}

function sqlsChamados(client) {
  return client.calls.map((c) => c.sql);
}

function build(overrides = {}) {
  const pool = overrides.pool || { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 1 }] }) };
  const validarLimiteVendasMes = overrides.validarLimiteVendasMes || jest.fn().mockResolvedValue({ permitido: true });
  const criarParcelasContasReceber = overrides.criarParcelasContasReceber || jest.fn().mockResolvedValue([]);
  const service = createVendasService({
    pool, normalizarDecimal, normalizarInt, normalizarDataISO, hoje,
    validarLimiteVendasMes, criarParcelasContasReceber,
  });
  return { ...service, pool, validarLimiteVendasMes, criarParcelasContasReceber };
}

const EMPRESA = { id: 1, nome: 'Minha Loja' };

function itemSimples(overrides = {}) {
  return { produto_id: 1, quantidade: 2, preco_unitario: 50, ...overrides };
}

describe('criarVenda — validações antes da transação', () => {
  test('itens ausentes/vazios -> rejeição 400, nunca chega a checar caixa', async () => {
    const pool = { query: jest.fn() };
    const { criarVenda } = build({ pool });
    const client = makeFakeClient();
    const resultado = await criarVenda({ client, empresaResolvida: EMPRESA, usuarioId: 1, body: { itens: [] }, inserirItensVendaEBaixarEstoque: jest.fn() });
    expect(resultado).toEqual({ ok: false, status: 400, mensagem: 'Dados da venda incompletos' });
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  test('caixa não aberto -> rejeição 400, nunca inicia transação (sem BEGIN)', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const { criarVenda } = build({ pool });
    const client = makeFakeClient();
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 1,
      body: { itens: [itemSimples()], total: 100 }, inserirItensVendaEBaixarEstoque: jest.fn(),
    });
    expect(resultado).toEqual({ ok: false, status: 400, mensagem: 'Caixa não está aberto. Abra o caixa antes de registrar uma venda.' });
    expect(client.query).not.toHaveBeenCalled();
  });

  test('limite de vendas do mês excedido -> rejeição 403 com a mensagem do validador', async () => {
    const validarLimiteVendasMes = jest.fn().mockResolvedValue({ permitido: false, mensagem: 'Limite mensal de vendas atingido' });
    const { criarVenda } = build({ validarLimiteVendasMes });
    const client = makeFakeClient();
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 1,
      body: { itens: [itemSimples()], total: 100 }, inserirItensVendaEBaixarEstoque: jest.fn(),
    });
    expect(resultado).toEqual({ ok: false, status: 403, mensagem: 'Limite mensal de vendas atingido' });
  });
});

describe('criarVenda — dentro da transação', () => {
  test('idempotency_key já usada -> devolve a venda existente deduplicada, com ROLLBACK e sem tocar nos itens', async () => {
    const { criarVenda } = build();
    const client = makeFakeClient({ idempotencyExistente: 777 });
    const inserirItens = jest.fn();
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 1,
      body: { itens: [itemSimples()], total: 100, idempotency_key: 'chave-abc' },
      inserirItensVendaEBaixarEstoque: inserirItens,
    });
    expect(resultado).toEqual({ ok: true, deduplicated: true, venda: { id: 777 } });
    expect(sqlsChamados(client)).toContain('ROLLBACK');
    expect(inserirItens).not.toHaveBeenCalled();
  });

  test('cliente_id informado mas não encontrado -> rejeição 404 e ROLLBACK', async () => {
    const { criarVenda } = build();
    const client = makeFakeClient({ clienteEncontrado: false });
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 1,
      body: { itens: [itemSimples()], total: 100, cliente_id: 999 },
      inserirItensVendaEBaixarEstoque: jest.fn(),
    });
    expect(resultado).toEqual({ ok: false, status: 404, mensagem: 'Cliente não encontrado' });
    expect(sqlsChamados(client)).toContain('ROLLBACK');
  });

  test('cliente_id encontrado: usa o nome do banco, não o nome enviado no corpo', async () => {
    const { criarVenda } = build();
    const client = makeFakeClient({ clienteEncontrado: { nome: 'Nome Real No Banco' } });
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 1,
      body: { itens: [itemSimples()], total: 100, cliente_id: 5, cliente_nome: 'Nome Que O Front Mandou' },
      inserirItensVendaEBaixarEstoque: jest.fn().mockResolvedValue(100),
    });
    expect(resultado.ok).toBe(true);
    expect(resultado.clienteNomeFinal).toBe('Nome Real No Banco');
  });

  test('desconto negativo -> rejeição 400 e ROLLBACK, antes de inserir a venda', async () => {
    const { criarVenda } = build();
    const client = makeFakeClient();
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 1,
      body: { itens: [itemSimples()], total: 100, desconto: -5 },
      inserirItensVendaEBaixarEstoque: jest.fn(),
    });
    expect(resultado).toEqual({ ok: false, status: 400, mensagem: 'Desconto não pode ser negativo' });
    expect(sqlsChamados(client).some((s) => s.includes('INSERT INTO vendas'))).toBe(false);
  });

  test('acréscimo negativo -> rejeição 400 e ROLLBACK', async () => {
    const { criarVenda } = build();
    const client = makeFakeClient();
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 1,
      body: { itens: [itemSimples()], total: 100, acrescimo: -1 },
      inserirItensVendaEBaixarEstoque: jest.fn(),
    });
    expect(resultado).toEqual({ ok: false, status: 400, mensagem: 'Acréscimo não pode ser negativo' });
  });

  test('total não corresponde à soma dos itens -> rejeição 400 e ROLLBACK (venda já foi inserida, mas é desfeita)', async () => {
    const { criarVenda } = build();
    const client = makeFakeClient();
    const inserirItens = jest.fn().mockResolvedValue(999); // soma bem diferente do total informado
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 1,
      body: { itens: [itemSimples()], total: 100 },
      inserirItensVendaEBaixarEstoque: inserirItens,
    });
    expect(resultado.ok).toBe(false);
    expect(resultado.status).toBe(400);
    expect(resultado.mensagem).toMatch(/não corresponde à soma dos itens/);
    expect(sqlsChamados(client)).toContain('ROLLBACK');
  });

  test('erro inesperado dentro de inserirItensVendaEBaixarEstoque (ex. estoque insuficiente) propaga como exceção, não como rejeição', async () => {
    const { criarVenda } = build();
    const client = makeFakeClient();
    const inserirItens = jest.fn().mockRejectedValue(new Error('Estoque insuficiente para Produto X'));
    await expect(criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 1,
      body: { itens: [itemSimples()], total: 100 },
      inserirItensVendaEBaixarEstoque: inserirItens,
    })).rejects.toThrow('Estoque insuficiente para Produto X');
  });
});

describe('criarVenda — sucesso e geração de contas a receber', () => {
  test('venda simples à vista (Dinheiro, pago): não gera conta a receber, comita a transação', async () => {
    const { criarVenda, criarParcelasContasReceber } = build();
    const client = makeFakeClient();
    const inserirItens = jest.fn().mockResolvedValue(100);
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 7,
      body: { itens: [itemSimples()], total: 100, pagamento: 'Dinheiro' },
      inserirItensVendaEBaixarEstoque: inserirItens,
    });
    expect(resultado.ok).toBe(true);
    expect(resultado.deduplicated).toBe(false);
    expect(resultado.venda.id).toBeGreaterThanOrEqual(100);
    expect(resultado.totalFinal).toBe(100);
    expect(resultado.pagamentoPrincipal).toBe('Dinheiro');
    expect(criarParcelasContasReceber).not.toHaveBeenCalled();
    expect(sqlsChamados(client)).toContain('COMMIT');
  });

  test('pagamento via Promissória com split: gera parcelas com forma "Promissória" e total/quantidade corretos', async () => {
    const { criarVenda, criarParcelasContasReceber } = build();
    const client = makeFakeClient();
    const inserirItens = jest.fn().mockResolvedValue(300);
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 7,
      body: {
        itens: [itemSimples({ quantidade: 6, preco_unitario: 50 })],
        total: 300, pagamento: 'Promissoria', parcelas: 3,
        cliente_id: null, cliente_nome: 'Cliente Promissória', observacao: 'Venda a prazo',
      },
      inserirItensVendaEBaixarEstoque: inserirItens,
    });
    expect(resultado.ok).toBe(true);
    expect(criarParcelasContasReceber).toHaveBeenCalledTimes(1);
    const chamada = criarParcelasContasReceber.mock.calls[0][0];
    expect(chamada.forma_pagamento).toBe('Promissória');
    expect(chamada.total).toBe(300);
    expect(chamada.quantidade_parcelas).toBe(3);
    expect(chamada.venda_id).toBe(resultado.venda.id);
  });

  test('retrocompatibilidade: status_pagamento "pendente" sem split gera conta a receber com a forma de pagamento principal', async () => {
    const { criarVenda, criarParcelasContasReceber } = build();
    const client = makeFakeClient();
    const inserirItens = jest.fn().mockResolvedValue(100);
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 7,
      body: { itens: [itemSimples()], total: 100, pagamento: 'Dinheiro', status_pagamento: 'pendente' },
      inserirItensVendaEBaixarEstoque: inserirItens,
    });
    expect(resultado.ok).toBe(true);
    expect(criarParcelasContasReceber).toHaveBeenCalledTimes(1);
    const chamada = criarParcelasContasReceber.mock.calls[0][0];
    expect(chamada.forma_pagamento).toBe('Dinheiro');
    expect(chamada.total).toBe(100);
  });

  test('tolerância de arredondamento de R$0,05 entre soma dos itens e total informado é aceita', async () => {
    const { criarVenda } = build();
    const client = makeFakeClient();
    const inserirItens = jest.fn().mockResolvedValue(100.04); // 4 centavos de diferença, dentro da tolerância
    const resultado = await criarVenda({
      client, empresaResolvida: EMPRESA, usuarioId: 7,
      body: { itens: [itemSimples()], total: 100 },
      inserirItensVendaEBaixarEstoque: inserirItens,
    });
    expect(resultado.ok).toBe(true);
  });
});
