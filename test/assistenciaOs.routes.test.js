'use strict';

// POST/PUT /assistencia/os não validavam produto_id contra a empresa antes
// do INSERT em ordens_servico_itens, e o GET /os/:id não filtrava o JOIN com
// produtos por empresa_id — vazava `nome` E `estoque` de produto de outro
// tenant, a combinação mais sensível dos 4 casos do achado D2-SEC-001
// (Auditoria de Segurança 2026-10-16).

jest.mock('../utils/permissoes', () => ({
  requirePermissao: () => (req, res, next) => next(),
}));

const assistenciaOsRoutes = require('../routes/assistencia/os.routes');

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
  return assistenciaOsRoutes({
    writeRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue(EMPRESA),
    normalizarDecimal: (v) => Number(v) || 0,
    normalizarInt: (v) => Number(v) || null,
    normalizarDataISO: (v) => v,
    hoje: () => '2026-01-10',
    criarParcelasContasReceber: jest.fn(),
    ...overrides,
  });
}

function makeFakeClient(produtoIdsValidos) {
  const calls = [];
  const query = jest.fn((sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) return Promise.resolve({});
    if (sql.includes('FROM produtos WHERE')) {
      const idsPedidos = params[0];
      return Promise.resolve({ rows: idsPedidos.filter((id) => produtoIdsValidos.includes(id)).map((id) => ({ id })) });
    }
    if (sql.includes('COALESCE(MAX(CAST')) return Promise.resolve({ rows: [{ prox: 1 }] });
    if (sql.includes('INSERT INTO ordens_servico (')) return Promise.resolve({ rows: [{ id: 90 }] });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { query, calls, release: jest.fn() };
}

function buildPool(client) {
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn((sql) => {
      if (sql.includes('COALESCE(MAX(CAST')) return Promise.resolve({ rows: [{ prox: 1 }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  };
}

describe('POST /assistencia/os — validação de posse de produto_id', () => {
  test('produto_id de outra empresa -> 404, nenhum INSERT em ordens_servico', async () => {
    const client = makeFakeClient([]);
    const pool = buildPool(client);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/os')({
      body: { empresa: 'Minha Loja', itens: [{ produto_id: 999, quantidade: 1, valor_unitario: 10 }] },
      user: { id: 1 },
    }, res);
    expect(res.statusCode).toBe(404);
    expect(client.calls.some((c) => c.sql.includes('INSERT INTO ordens_servico ('))).toBe(false);
  });

  test('produto_id da própria empresa: passa da validação e cria a OS', async () => {
    const client = makeFakeClient([1]);
    const pool = buildPool(client);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/os')({
      body: { empresa: 'Minha Loja', itens: [{ produto_id: 1, quantidade: 1, valor_unitario: 10 }] },
      user: { id: 1 },
    }, res);
    expect(res.statusCode).toBe(201);
  });
});

describe('GET /assistencia/os/:id — JOIN de itens filtrado por empresa', () => {
  test('JOIN com produtos inclui AND empresa_id = $2 (evita vazar nome+estoque de outro tenant)', async () => {
    const pool = {
      query: jest.fn((sql) => {
        if (sql.includes('FROM ordens_servico os')) return Promise.resolve({ rows: [{ id: 90 }] });
        return Promise.resolve({ rows: [] });
      }),
    };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'get', '/os/:id')({ params: { id: '90' }, query: {} }, res);
    const itensCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM ordens_servico_itens'));
    expect(itensCall[0]).toMatch(/LEFT JOIN produtos p ON p\.id = osi\.produto_id AND p\.empresa_id = \$2/);
    expect(itensCall[1]).toEqual([90, 1]);
  });
});
