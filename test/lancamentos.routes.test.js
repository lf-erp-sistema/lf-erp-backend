'use strict';

// GET /financeiro/lancamentos/:empresa usava normalizarInt sem importá-lo
// (routes/lancamentos.routes.js), lançando ReferenceError em toda chamada e
// quebrando totalmente a tela de Lançamentos Financeiros em produção
// (achado B2-BUG-004, Auditoria de Segurança 2026-10-16).

jest.mock('../utils/permissoes', () => ({
  obterPermissoes: jest.fn().mockResolvedValue({ financeiro: { pode_ver: true } }),
  requirePermissao: () => (req, res, next) => next(),
}));

const lancamentosRoutes = require('../routes/lancamentos.routes');

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

function buildRouter(pool, overrides = {}) {
  return lancamentosRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue({ id: 1, nome: 'Minha Loja' }),
    podeGerenciarFinanceiro: jest.fn().mockReturnValue(true),
    atualizarStatusContasReceberPorEmpresa: jest.fn(),
    registrarLogFinanceiro: jest.fn(),
    ...overrides,
  });
}

describe('GET /financeiro/lancamentos/:empresa', () => {
  test('não lança ReferenceError (normalizarInt) e devolve paginação — B2-BUG-004', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ total: 0, receitas: 0, despesas: 0 }] }),
    };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'get', '/financeiro/lancamentos/:empresa')(
      { params: { empresa: 'Minha Loja' }, query: {} }, res
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.paginacao).toEqual(expect.objectContaining({ pagina: 1, limite: 50 }));
  });

  test('query.page e query.limit são normalizados para inteiro corretamente', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ total: 0, receitas: 0, despesas: 0 }] }),
    };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'get', '/financeiro/lancamentos/:empresa')(
      { params: { empresa: 'Minha Loja' }, query: { page: '2', limit: '10' } }, res
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.paginacao).toEqual(expect.objectContaining({ pagina: 2, limite: 10 }));
  });
});
