'use strict';

// POST /checkout/webhook reimplementava a verificação de assinatura Asaas
// manualmente em vez de usar verificarWebhookAsaas (utils/asaas.js), já
// consolidada e reusada por pagamentos.routes.js/admin.routes.js — risco de
// drift (achado C2-INT-003, Auditoria de Segurança 2026-10-16). Confirma que
// a rota agora delega a verificação e respeita seu retorno.

jest.mock('../utils/asaas', () => ({
  resolverClienteAsaas: jest.fn(),
  criarBoleto: jest.fn(),
  verificarWebhookAsaas: jest.fn(),
}));

const { verificarWebhookAsaas } = require('../utils/asaas');
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

function buildRouter(pool) {
  return checkoutRoutes({
    auth: jest.fn(), writeRateLimiter: (req, res, next) => next(), pool,
    validarAcessoEmpresa: jest.fn(), normalizarDecimal: (v) => v, normalizarInt: (v) => v, hoje: () => '2026-01-10',
  });
}

describe('POST /checkout/webhook — delega a verificarWebhookAsaas consolidada', () => {
  test('verificarWebhookAsaas retorna false (já respondeu 401/503): rota não processa o payment', async () => {
    verificarWebhookAsaas.mockImplementation((req, res) => { res.status(401).json({ erro: 'Unauthorized' }); return false; });
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/webhook')({ body: {}, headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('verificarWebhookAsaas retorna true: rota processa o evento PAYMENT_RECEIVED normalmente', async () => {
    verificarWebhookAsaas.mockReturnValue(true);
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/webhook')({
      body: { event: 'PAYMENT_RECEIVED', payment: { externalReference: 'tok-123' } },
      headers: {},
    }, res);
    expect(res.statusCode).toBe(200);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE checkout_links'), ['tok-123']);
  });
});
