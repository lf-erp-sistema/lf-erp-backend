'use strict';

// PUT /contas-receber/:id (caminho "apenas_esta") permitia reescrever valor/
// vencimento de uma conta já paga ou com baixa parcial registrada, sem a
// mesma guarda de status que o caminho em lote e o DELETE já tinham —
// achado B2-DATA-002, Auditoria de Segurança 2026-10-16.

jest.mock('../utils/permissoes', () => ({
  requirePermissao: () => (req, res, next) => next(),
}));

const crudRoutes = require('../routes/contas-receber/crud.routes');

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
  return crudRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue(EMPRESA),
    registrarLogFinanceiro: jest.fn(),
    ...overrides,
  });
}

function buildReq(contaOverrides = {}, bodyOverrides = {}) {
  return {
    params: { id: '10' },
    user: { empresa_id: 1, empresa: 'Minha Loja' },
    body: { valor: 99.9, ...bodyOverrides },
    _conta: { id: 10, status: 'pendente', empresa_id: 1, empresa: 'Minha Loja', venda_id: null, ...contaOverrides },
  };
}

function buildPool(req) {
  return { query: jest.fn().mockResolvedValue({ rows: [req._conta], rowCount: 1 }) };
}

describe('PUT /contas-receber/:id — escopo apenas_esta', () => {
  test('conta paga: tentar editar valor -> 400, nenhum UPDATE é executado', async () => {
    const req = buildReq({ status: 'pago' });
    const pool = buildPool(req);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/contas-receber/:id')(req, res);
    expect(res.statusCode).toBe(400);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('UPDATE contas_receber'))).toBe(false);
  });

  test('conta parcial: tentar editar vencimento -> 400', async () => {
    const req = buildReq({ status: 'parcial' }, { valor: undefined, data_vencimento: '2026-12-01' });
    const pool = buildPool(req);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/contas-receber/:id')(req, res);
    expect(res.statusCode).toBe(400);
  });

  test('conta parcial_atrasado: tentar editar valor -> 400', async () => {
    const req = buildReq({ status: 'parcial_atrasado' });
    const pool = buildPool(req);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/contas-receber/:id')(req, res);
    expect(res.statusCode).toBe(400);
  });

  test('conta paga: editar SOMENTE observação continua permitido', async () => {
    const req = buildReq({ status: 'pago' }, { valor: undefined, observacao: 'nota interna' });
    const pool = buildPool(req);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/contas-receber/:id')(req, res);
    expect(res.statusCode).toBe(200);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('UPDATE contas_receber'))).toBe(true);
  });

  test('conta pendente: editar valor é permitido normalmente', async () => {
    const req = buildReq({ status: 'pendente' });
    const pool = buildPool(req);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/contas-receber/:id')(req, res);
    expect(res.statusCode).toBe(200);
    const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE contas_receber'));
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toContain('empresa_id');
  });
});
