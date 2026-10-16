'use strict';

// PUT /compras/:id bloqueava edição só quando havia contas_pagar com
// status='pago', deixando passar (e depois apagar, junto das pendentes) uma
// contas_pagar com baixa PARCIAL já registrada ao fornecedor — mesma classe
// de bug já corrigida do lado de vendas (vendaPossuiParcelaPaga). Achado
// B2-DATA-003, Auditoria de Segurança 2026-10-16.

jest.mock('../utils/permissoes', () => ({
  requirePermissao: () => (req, res, next) => next(),
}));

const comprasEditarRoutes = require('../routes/compras/editar.routes');

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

// Client fake mínimo: só precisa levar a rota até a checagem de
// contas_pagar — qualquer SQL anterior (BEGIN/SELECT compras FOR UPDATE)
// responde OK; a query de contas_pagar devolve a contagem configurada.
function makeFakeClient(totalContasProtegidas) {
  const calls = [];
  const query = jest.fn((sql) => {
    calls.push(sql);
    if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
      return Promise.resolve({});
    }
    if (sql.includes('FROM compras WHERE')) {
      return Promise.resolve({ rowCount: 1, rows: [{ id: 10, empresa_id: 1, empresa: 'Minha Loja' }] });
    }
    if (sql.includes('FROM contas_pagar')) {
      return Promise.resolve({ rows: [{ total: totalContasProtegidas }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { query, calls, release: jest.fn() };
}

function buildReq(overrides = {}) {
  return {
    params: { id: '10' },
    body: {
      empresa: 'Minha Loja', fornecedor_id: 5, data: '2026-01-10',
      pagamento: 'boleto', parcelas: 1, itens: [{ produto_id: 1, quantidade: 2, custo_unitario: 5 }],
    },
    user: { id: 1, empresa_id: 1, empresa: 'Minha Loja' },
    ...overrides,
  };
}

function buildRouter(client, overrides = {}) {
  return comprasEditarRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool: { connect: jest.fn().mockResolvedValue(client) },
    validarAcessoEmpresa: jest.fn().mockResolvedValue(EMPRESA),
    podeGerenciarCompras: jest.fn().mockReturnValue(true),
    registrarMovimentacaoEstoque: jest.fn(),
    atualizarStatusContasPagarPorEmpresa: jest.fn(),
    registrarAuditoria: jest.fn(),
    ...overrides,
  });
}

describe('PUT /compras/:id — guarda de contas_pagar paga/parcial', () => {
  test('contas_pagar com status pago: bloqueia edição (comportamento preexistente)', async () => {
    const client = makeFakeClient(1);
    const router = buildRouter(client);
    const res = mockRes();
    await getHandler(router, 'put', '/:id')(buildReq(), res);
    expect(res.statusCode).toBe(400);
    expect(client.calls).toContain('ROLLBACK');
    const queryComStatus = client.query.mock.calls.find(([sql]) => sql.includes('FROM contas_pagar'));
    expect(queryComStatus[0]).toContain("'parcial'");
  });

  test('nenhuma conta paga/parcial: passa da guarda e chega a buscar o fornecedor', async () => {
    const client = makeFakeClient(0);
    const router = buildRouter(client);
    const res = mockRes();
    await getHandler(router, 'put', '/:id')(buildReq(), res);
    // Client fake minimalista não simula o resto do fluxo (fornecedor/produtos
    // não encontrados é esperado aqui) — o que importa é que passou da guarda
    // de contas_pagar e avançou até a busca de fornecedor.
    expect(client.calls.some((sql) => sql.includes('FROM fornecedores'))).toBe(true);
  });
});
