'use strict';

// POST /fidelidade/acumular não validava cliente_id contra a empresa antes
// de chamar acumularPontosFidelidade — diferente de /resgatar, que já fazia
// essa checagem (SELECT ... WHERE id=$1 AND empresa_id=$2 FOR UPDATE). Sem
// ela, um cliente_id de outra empresa gravava um registro cross-tenant em
// fidelidade_movimentos sob o empresa_id do atacante (achado D2-SEC-002,
// Auditoria de Segurança 2026-10-16).

jest.mock('../utils/fidelidade', () => ({
  acumularPontosFidelidade: jest.fn().mockResolvedValue(),
}));

const { acumularPontosFidelidade } = require('../utils/fidelidade');
const fidelidadeRoutes = require('../routes/fidelidade.routes');

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

function buildRouter(pool, overrides = {}) {
  return fidelidadeRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue(EMPRESA),
    normalizarDecimal: (v) => Number(v) || 0,
    normalizarInt: (v) => Number(v) || null,
    hoje: () => '2026-01-10',
    requirePermissao: () => (req, res, next) => next(),
    ...overrides,
  });
}

function buildPool(clienteEncontrado) {
  return {
    query: jest.fn((sql) => {
      if (sql.includes('FROM fidelidade_config')) return Promise.resolve({ rows: [{ ativo: true, pontos_por_real: 1 }] });
      if (sql.includes('FROM clientes WHERE')) return Promise.resolve({ rowCount: clienteEncontrado ? 1 : 0, rows: clienteEncontrado ? [{ id: 1 }] : [] });
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('POST /fidelidade/acumular — validação de posse de cliente_id', () => {
  test('cliente_id de outra empresa -> 404, acumularPontosFidelidade nunca é chamada', async () => {
    const pool = buildPool(false);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/acumular')({ body: { cliente_id: 999, pontos: 10 } }, res);
    expect(res.statusCode).toBe(404);
    expect(acumularPontosFidelidade).not.toHaveBeenCalled();
  });

  test('cliente_id da própria empresa: passa da validação e acumula', async () => {
    const pool = buildPool(true);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/acumular')({ body: { cliente_id: 1, pontos: 10 } }, res);
    expect(res.statusCode).toBe(200);
    expect(acumularPontosFidelidade).toHaveBeenCalledWith(pool, expect.objectContaining({ clienteId: 1 }));
  });
});
