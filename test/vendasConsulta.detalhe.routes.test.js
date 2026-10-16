'use strict';

// GET /vendas/detalhe/:id usava uma expressão de status_exibicao de 3 ramos,
// sem o caso 'parcial' + vencida -> 'parcial_atrasado' já presente em todas
// as outras rotas que exibem contas_receber — mostrava "Atrasado" em vez de
// "Parcial em atraso" para uma parcela parcialmente paga e vencida (achado
// B2-DATA-005, Auditoria de Segurança 2026-10-16).

jest.mock('../utils/permissoes', () => ({
  requirePermissao: () => (req, res, next) => next(),
}));

const vendasConsultaRoutes = require('../routes/vendas/consulta.routes');

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
  return vendasConsultaRoutes({
    auth: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue({ id: 1, nome: 'Minha Loja' }),
    adicionarFiltroEmpresaSaaS: jest.fn((sql) => sql),
    normalizarInt: (v) => Number(v) || null,
    hoje: () => '2026-01-10',
    ...overrides,
  });
}

describe('GET /vendas/detalhe/:id — status_exibicao de contas_receber', () => {
  test('usa a mesma expressão de 4 ramos (inclui parcial_atrasado) das demais rotas — B2-DATA-005', async () => {
    const pool = {
      query: jest.fn((sql) => {
        if (sql.includes('FROM vendas WHERE')) return Promise.resolve({ rowCount: 1, rows: [{ id: 1, empresa_id: 1, empresa: 'Minha Loja' }] });
        return Promise.resolve({ rows: [] });
      }),
    };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'get', '/detalhe/:id')({ params: { id: '1' }, user: {} }, res);
    const crCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM contas_receber'));
    expect(crCall[0]).toContain("THEN 'parcial_atrasado'");
    expect(crCall[0]).toMatch(/WHEN LOWER\(COALESCE\(status, 'pendente'\)\) = 'parcial' THEN 'parcial'/);
  });
});
