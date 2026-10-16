'use strict';

// POST/PUT /orcamentos não validavam produto_id/grade_id contra a empresa
// antes do INSERT em orcamento_itens, e o GET /:id não filtrava o JOIN com
// produtos/produto_grades por empresa_id — um produto_id de outra empresa
// vazava unidade/atributos de grade (achado D2-SEC-001, Auditoria de
// Segurança 2026-10-16).

const orcamentosRoutes = require('../routes/orcamentos.routes');

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
  return orcamentosRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue(EMPRESA),
    normalizarDecimal: (v) => Number(v) || 0,
    normalizarInt: (v) => Number(v) || null,
    normalizarDataISO: (v) => v,
    requirePermissao: () => (req, res, next) => next(),
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
    if (sql.includes('FROM produto_grades')) return Promise.resolve({ rows: [] });
    if (sql.includes('INSERT INTO orcamentos')) {
      return Promise.resolve({ rows: [{ id: 50, empresa_id: 1, empresa: 'Minha Loja' }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { query, calls, release: jest.fn() };
}

function buildPool(client, produtoIdsValidos) {
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn((sql, params) => {
      if (sql.includes('FROM produtos WHERE')) {
        const idsPedidos = params[0];
        return Promise.resolve({ rows: idsPedidos.filter((id) => produtoIdsValidos.includes(id)).map((id) => ({ id })) });
      }
      if (sql.includes('FROM produto_grades')) return Promise.resolve({ rows: [] });
      if (sql.includes('proximo FROM orcamentos')) return Promise.resolve({ rows: [{ proximo: 1 }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  };
}

describe('POST /orcamentos — validação de posse de produto_id', () => {
  test('produto_id de outra empresa -> 404, nenhum INSERT é executado', async () => {
    const client = makeFakeClient([]); // nenhum produto é "válido" (pertence a outra empresa)
    const pool = buildPool(client, []);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/')({
      body: { itens: [{ produto_id: 999, preco_unitario: 10, quantidade: 1 }] },
    }, res);
    expect(res.statusCode).toBe(404);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('produto_id da própria empresa: passa da validação e cria o orçamento', async () => {
    const client = makeFakeClient([1]);
    const pool = buildPool(client, [1]);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/')({
      body: { itens: [{ produto_id: 1, preco_unitario: 10, quantidade: 1 }] },
      user: { id: 1 },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(client.calls.some((c) => c.sql.includes('INSERT INTO orcamento_itens'))).toBe(true);
  });
});

describe('GET /orcamentos/:id — JOIN de itens filtrado por empresa', () => {
  test('JOIN com produtos/produto_grades inclui AND empresa_id = $2 (defesa em profundidade)', async () => {
    const pool = {
      query: jest.fn((sql) => {
        if (sql.includes('FROM orcamentos WHERE')) return Promise.resolve({ rowCount: 1, rows: [{ id: 50 }] });
        return Promise.resolve({ rows: [] });
      }),
    };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'get', '/:id')({ params: { id: '50' } }, res);
    const itensCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM orcamento_itens'));
    expect(itensCall[0]).toMatch(/LEFT JOIN produtos p ON p\.id = oi\.produto_id AND p\.empresa_id = \$2/);
    expect(itensCall[0]).toMatch(/LEFT JOIN produto_grades pg ON pg\.id = oi\.grade_id AND pg\.empresa_id = \$2/);
    expect(itensCall[1]).toEqual([50, 1]);
  });
});
