'use strict';

// POST/PUT /crm/oportunidades gravavam cliente_id do body sem validar posse
// contra a empresa — diferente do padrão já usado em orcamentos/pedidos.
// Impacto direto limitado (o GET /:id já filtra o JOIN por empresa_id), mas
// cria uma referência cross-tenant órfã, inconsistente com o padrão
// estabelecido (achado F2-SEC-007, Auditoria de Segurança 2026-10-16).

jest.mock('../utils/permissoes', () => ({
  requirePermissao: () => (req, res, next) => next(),
}));

const crmRoutes = require('../routes/crm.routes');

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
  return crmRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue(EMPRESA),
    normalizarDecimal: (v) => Number(v) || 0,
    normalizarInt: (v) => Number(v) || null,
    normalizarDataISO: (v) => v,
    hoje: () => '2026-01-10',
    ...overrides,
  });
}

function buildPool(clienteEncontrado) {
  return {
    query: jest.fn((sql) => {
      if (sql.includes('FROM clientes WHERE')) return Promise.resolve({ rowCount: clienteEncontrado ? 1 : 0, rows: clienteEncontrado ? [{ id: 1 }] : [] });
      if (sql.includes('INSERT INTO crm_oportunidades')) return Promise.resolve({ rows: [{ id: 50 }] });
      if (sql.includes('UPDATE crm_oportunidades')) return Promise.resolve({ rowCount: 1, rows: [{ id: 50 }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  };
}

describe('POST /crm/oportunidades — validação de posse de cliente_id', () => {
  test('cliente_id de outra empresa -> 404, nenhum INSERT', async () => {
    const pool = buildPool(false);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/oportunidades')({ body: { titulo: 'Negócio X', cliente_id: 999 }, user: { id: 1 } }, res);
    expect(res.statusCode).toBe(404);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO crm_oportunidades'))).toBe(false);
  });

  test('cliente_id da própria empresa: passa da validação e cria', async () => {
    const pool = buildPool(true);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/oportunidades')({ body: { titulo: 'Negócio X', cliente_id: 1 }, user: { id: 1 } }, res);
    expect(res.statusCode).toBe(201);
  });

  test('sem cliente_id: não valida (campo opcional)', async () => {
    const pool = buildPool(false);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/oportunidades')({ body: { titulo: 'Negócio X' }, user: { id: 1 } }, res);
    expect(res.statusCode).toBe(201);
  });
});

describe('PUT /crm/oportunidades/:id — validação de posse de cliente_id', () => {
  test('cliente_id de outra empresa -> 404, nenhum UPDATE', async () => {
    const pool = buildPool(false);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/oportunidades/:id')({ params: { id: '50' }, body: { cliente_id: 999 } }, res);
    expect(res.statusCode).toBe(404);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('UPDATE crm_oportunidades'))).toBe(false);
  });
});
