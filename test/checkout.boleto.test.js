'use strict';

jest.mock('../utils/asaas', () => ({
  resolverClienteAsaas: jest.fn(),
  criarBoleto: jest.fn(),
}));
jest.mock('../utils/pixCrypto', () => ({ decryptField: jest.fn() }));

const { resolverClienteAsaas, criarBoleto } = require('../utils/asaas');
const { decryptField } = require('../utils/pixCrypto');
const checkoutRoutes = require('../routes/checkout.routes');

function getHandler(router, method, path) {
  const layer = router.stack.find((item) => item.route && item.route.path === path && item.route.methods[method]);
  if (!layer) throw new Error(`Rota não encontrada: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}

function mockRes() {
  return {
    statusCode: 200,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
  };
}

function criarRouter(client) {
  return checkoutRoutes({
    auth: jest.fn(), writeRateLimiter: jest.fn(),
    pool: { connect: jest.fn().mockResolvedValue(client) },
    validarAcessoEmpresa: jest.fn(), normalizarDecimal: Number,
    normalizarInt: Number, hoje: jest.fn(),
  });
}

describe('POST /checkout/p/:token/boleto', () => {
  beforeEach(() => jest.clearAllMocks());

  test('bloqueia o link em transação antes de criar a cobrança', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{
          token: 'token-seguro', valor: 75, descricao: 'Pedido', cliente_nome: 'Cliente',
          asaas_api_key: 'campo-cifrado', asaas_sandbox: true, boleto_url: null,
        }], rowCount: 1 })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: jest.fn(),
    };
    decryptField.mockReturnValue('asaas-key');
    resolverClienteAsaas.mockResolvedValue('cus_123');
    criarBoleto.mockResolvedValue({ id: 'pay_123', invoiceUrl: 'https://boleto.test/123', linhaDigitavel: '123' });

    const handler = getHandler(criarRouter(client), 'post', '/p/:token/boleto');
    const res = mockRes();
    await handler({ params: { token: 'token-seguro' }, body: {} }, res);

    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls[1][0]).toContain('FOR UPDATE OF cl');
    expect(client.query.mock.calls.at(-1)[0]).toBe('COMMIT');
    expect(criarBoleto).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  test('reaproveita boleto existente sem chamar a Asaas', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ boleto_url: 'https://boleto.test/existente', boleto_linha: '456' }], rowCount: 1 })
        .mockResolvedValueOnce({}),
      release: jest.fn(),
    };

    const handler = getHandler(criarRouter(client), 'post', '/p/:token/boleto');
    const res = mockRes();
    await handler({ params: { token: 'token-seguro' }, body: {} }, res);

    expect(criarBoleto).not.toHaveBeenCalled();
    expect(client.query.mock.calls.at(-1)[0]).toBe('COMMIT');
    expect(res.jsonBody.boleto_url).toBe('https://boleto.test/existente');
  });
});
