'use strict';

// Testa a camada HTTP de POST /vendas (routes/vendas/criar.routes.js): auth/permissão,
// resolução de empresa, mapeamento de erro/sucesso/dedup e orquestração dos efeitos
// colaterais (auditoria, status de contas a receber, comissão, fidelidade, webhook
// contábil). A lógica de negócio de criarVenda() já é testada em profundidade e
// isoladamente em vendasService.test.js — aqui ela é mockada (achado F-TEST-003 da
// Auditoria 2026-10-15: POST /vendas nunca tinha teste no nível de rota HTTP).

const mockCriarVenda = jest.fn();
jest.mock('../utils/vendasService', () => ({
  createVendasService: () => ({ criarVenda: mockCriarVenda }),
}));

const mockCalcularComissaoVenda = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/comissoes', () => ({
  calcularComissaoVenda: (...args) => mockCalcularComissaoVenda(...args),
}));

const mockAcumularPontosFidelidade = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/fidelidade', () => ({
  acumularPontosFidelidade: (...args) => mockAcumularPontosFidelidade(...args),
}));

const mockDispararWebhookComRetry = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/webhookContabil', () => ({
  dispararWebhookComRetry: (...args) => mockDispararWebhookComRetry(...args),
}));

// vendas/criar.routes.js importa requirePermissao diretamente de utils/permissoes
// (diferente de usuarios.routes.js, que recebe via injeção de dependência) — o mock
// precisa fornecer uma versão funcional; getHandler() pula direto pro último
// handler da pilha, então o middleware real nunca é de fato invocado no teste.
jest.mock('../utils/permissoes', () => ({
  obterPermissoes: jest.fn().mockResolvedValue({ vendas: { pode_ver: true } }),
  requirePermissao: () => (req, res, next) => next(),
}));

const vendasCriarRoutes = require('../routes/vendas/criar.routes');

function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    if (paths.includes(path) && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`Rota não encontrada: ${method.toUpperCase()} ${path}`);
}

function mockRes() {
  return {
    statusCode: 200,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
  };
}

const EMPRESA = { id: 1, nome: 'Minha Loja' };

function buildReq(overrides = {}) {
  return {
    user: { id: 10, nome: 'Operador PDV', tipo: 'funcionario' },
    body: {
      empresa: 'Minha Loja',
      cliente_id: null,
      pagamento: 'Dinheiro',
      status_pagamento: 'pago',
      itens: [{ produto_id: 1, quantidade: 2, preco_unitario: 10 }],
      total: 20,
    },
    ...overrides,
  };
}

function buildRouter(overrides = {}) {
  const client = overrides.client || { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
  const pool = overrides.pool || { connect: jest.fn().mockResolvedValue(client) };
  const router = vendasCriarRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: overrides.validarAcessoEmpresa || jest.fn().mockResolvedValue(EMPRESA),
    podeGerenciarVendas: overrides.podeGerenciarVendas || jest.fn().mockReturnValue(true),
    validarLimiteVendasMes: jest.fn().mockResolvedValue({ permitido: true }),
    normalizarDecimal: (v) => Number(v),
    normalizarInt: (v) => parseInt(v, 10) || 0,
    normalizarDataISO: (v) => v,
    hoje: () => '2026-10-15',
    criarParcelasContasReceber: jest.fn().mockResolvedValue([]),
    atualizarStatusContasReceberPorEmpresa: overrides.atualizarStatusContasReceberPorEmpresa || jest.fn().mockResolvedValue(undefined),
    registrarAuditoria: overrides.registrarAuditoria || jest.fn().mockResolvedValue(undefined),
    inserirItensVendaEBaixarEstoque: jest.fn().mockResolvedValue(undefined),
  });
  return { router, pool, client };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCalcularComissaoVenda.mockResolvedValue(undefined);
  mockAcumularPontosFidelidade.mockResolvedValue(undefined);
  mockDispararWebhookComRetry.mockResolvedValue(undefined);
});

describe('POST /vendas', () => {
  test('sem permissão de gestão de vendas -> 403, criarVenda nunca chamado', async () => {
    const { router } = buildRouter({ podeGerenciarVendas: jest.fn().mockReturnValue(false) });
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq(), res);
    expect(res.statusCode).toBe(403);
    expect(mockCriarVenda).not.toHaveBeenCalled();
  });

  test('sem acesso à empresa -> 403, criarVenda nunca chamado', async () => {
    const { router } = buildRouter({ validarAcessoEmpresa: jest.fn().mockResolvedValue(null) });
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq(), res);
    expect(res.statusCode).toBe(403);
    expect(mockCriarVenda).not.toHaveBeenCalled();
  });

  test('corpo inválido (criarVenda rejeita) -> propaga status e mensagem, sem efeitos colaterais', async () => {
    mockCriarVenda.mockResolvedValue({ ok: false, status: 400, mensagem: 'Dados da venda incompletos' });
    const { router } = buildRouter();
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq({ body: { empresa: 'Minha Loja', itens: [] } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.erro).toBe('Dados da venda incompletos');
    expect(mockCalcularComissaoVenda).not.toHaveBeenCalled();
    expect(mockAcumularPontosFidelidade).not.toHaveBeenCalled();
    expect(mockDispararWebhookComRetry).not.toHaveBeenCalled();
  });

  test('caixa fechado (criarVenda rejeita com 400 específico) -> propaga mensagem de negócio', async () => {
    mockCriarVenda.mockResolvedValue({
      ok: false, status: 400,
      mensagem: 'Caixa não está aberto. Abra o caixa antes de registrar uma venda.',
    });
    const { router } = buildRouter();
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq(), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.erro).toMatch(/Caixa não está aberto/);
  });

  test('idempotência: venda já criada com a mesma key -> 200 deduplicated, sem reexecutar efeitos colaterais', async () => {
    mockCriarVenda.mockResolvedValue({ ok: true, deduplicated: true, venda: { id: 777 } });
    const { router } = buildRouter();
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq({ body: { ...buildReq().body, idempotency_key: 'abc123' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ success: true, venda_id: 777, deduplicated: true });
    expect(mockCalcularComissaoVenda).not.toHaveBeenCalled();
    expect(mockAcumularPontosFidelidade).not.toHaveBeenCalled();
    expect(mockDispararWebhookComRetry).not.toHaveBeenCalled();
  });

  test('sucesso: cria venda, responde venda_id, audita sem vazar dados sensíveis e dispara efeitos colaterais em background', async () => {
    mockCriarVenda.mockResolvedValue({
      ok: true,
      deduplicated: false,
      venda: { id: 555 },
      clienteIdFinal: 9,
      clienteNomeFinal: 'Cliente Teste',
      subtotalFinal: 20,
      descontoFinal: 0,
      acrescimoFinal: 0,
      totalFinal: 20,
      pagamentoPrincipal: 'Dinheiro',
    });
    const registrarAuditoria = jest.fn().mockResolvedValue(undefined);
    const atualizarStatusContasReceberPorEmpresa = jest.fn().mockResolvedValue(undefined);
    const { router, client } = buildRouter({ registrarAuditoria, atualizarStatusContasReceberPorEmpresa });
    const res = mockRes();

    await getHandler(router, 'post', '/')(buildReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ sucesso: true, dados: { venda_id: 555 } });

    // Auditoria chamada com a venda certa e sem a senha/hash de ninguém no payload
    expect(registrarAuditoria).toHaveBeenCalledTimes(1);
    const chamada = registrarAuditoria.mock.calls[0][0];
    expect(chamada.referencia_id).toBe(555);
    expect(chamada.modulo).toBe('vendas');
    expect(chamada.acao).toBe('cadastro');
    expect(JSON.stringify(chamada)).not.toMatch(/senha/i);

    // Status de contas a receber recalculado para a empresa certa
    expect(atualizarStatusContasReceberPorEmpresa).toHaveBeenCalledWith(EMPRESA.nome, EMPRESA.id);

    // Efeitos em background disparados com os parâmetros corretos (fire-and-forget)
    expect(mockCalcularComissaoVenda).toHaveBeenCalledWith(expect.anything(), {
      vendaId: 555, usuarioId: 10, empresaId: EMPRESA.id,
    });
    expect(mockAcumularPontosFidelidade).toHaveBeenCalledWith(expect.anything(), {
      empresaId: EMPRESA.id, clienteId: 9, vendaId: 555, totalVenda: 20,
    });
    expect(mockDispararWebhookComRetry).toHaveBeenCalledWith(
      expect.anything(), EMPRESA.id, 'venda.criada',
      expect.objectContaining({ id: 555, total: 20 })
    );

    // Conexão do pool sempre liberada
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('sucesso sem cliente vinculado -> não acumula fidelidade', async () => {
    mockCriarVenda.mockResolvedValue({
      ok: true,
      deduplicated: false,
      venda: { id: 556 },
      clienteIdFinal: null,
      clienteNomeFinal: '',
      subtotalFinal: 20,
      descontoFinal: 0,
      acrescimoFinal: 0,
      totalFinal: 20,
      pagamentoPrincipal: 'Dinheiro',
    });
    const { router } = buildRouter();
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq(), res);
    expect(res.statusCode).toBe(200);
    expect(mockAcumularPontosFidelidade).not.toHaveBeenCalled();
  });

  test('erro inesperado dentro de criarVenda -> 500, ROLLBACK e conexão liberada', async () => {
    mockCriarVenda.mockRejectedValue(new Error('conexão caiu'));
    const { router, client } = buildRouter();
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq(), res);
    expect(res.statusCode).toBe(500);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
