'use strict';

// GET /caixa/sessao-ativa devolvia saldo_calculado contendo SÓ os
// movimentos de caixa (abertura/sangria/suprimento), sem as vendas em
// dinheiro/pix do dia — diferente de POST /fechar, que soma os dois
// (saldoMovimentos + totalVendas). O card "Saldo em caixa" no frontend
// mostrava um valor menor do que o fechamento realmente ia apurar, criando
// risco de confusão na conferência de caixa (achado B2-DATA-006, Auditoria
// de Segurança 2026-10-16).

jest.mock('../utils/permissoes', () => ({
  requirePermissao: () => (req, res, next) => next(),
}));

const caixaRoutes = require('../routes/caixa.routes');

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

function buildRouter(pool) {
  return caixaRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue({ id: 1, nome: 'Minha Loja' }),
    normalizarDecimal: (v) => Number(v) || 0,
  });
}

describe('GET /caixa/sessao-ativa — saldo_calculado inclui vendas dinheiro/pix', () => {
  test('saldo_calculado = movimentos + vendas, igual ao que POST /fechar apura — B2-DATA-006', async () => {
    const pool = {
      query: jest.fn((sql) => {
        if (sql.includes("status = 'aberto'")) return Promise.resolve({ rows: [{ id: 10, aberto_em: '2026-01-10T08:00:00Z', saldo_abertura: '100.00' }] });
        if (sql.includes('SUM(valor)')) return Promise.resolve({ rows: [{ saldo: '150.00' }] }); // movimentos: 150
        if (sql.includes('FROM caixa_movimentos WHERE sessao_id')) return Promise.resolve({ rows: [] });
        if (sql.includes('FROM vendas')) return Promise.resolve({ rows: [{ total_vendas: '80.50', qtd_vendas: '3' }] }); // vendas: 80.50
        return Promise.resolve({ rows: [] });
      }),
    };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'get', '/sessao-ativa')({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.saldo_calculado).toBe(230.5); // 150 + 80.50
    expect(res.jsonBody.vendas_dinheiro_pix.total).toBe(80.5); // breakdown continua separado
  });
});
