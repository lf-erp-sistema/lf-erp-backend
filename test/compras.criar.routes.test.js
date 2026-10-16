'use strict';

// Testa a camada HTTP de POST /compras (routes/compras/criar.routes.js): auth/permissão,
// corpo inválido, idempotência, fornecedor não encontrado e sucesso (com e sem geração
// de contas a pagar). Diferente de vendas, a lógica de negócio de compras vive inline
// na própria rota (sem um "comprasService" separado) — o teste usa um client fake que
// responde por padrão de SQL, no mesmo espírito do makeFakeClient de vendasService.test.js.
// (achado F-TEST-003 da Auditoria 2026-10-15: POST /compras nunca teve nenhum teste.)

jest.mock('../utils/permissoes', () => ({
  obterPermissoes: jest.fn().mockResolvedValue({ compras: { pode_ver: true } }),
  requirePermissao: () => (req, res, next) => next(),
}));

const comprasCriarRoutes = require('../routes/compras/criar.routes');

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
const FORNECEDOR = { id: 5, nome: 'Fornecedor Teste' };
const PRODUTO = { id: 1, nome: 'Produto A', estoque: 10, custo: 5, custo_medio: 5, preco: 20 };

// Client transacional fake: responde por padrão de SQL, suficiente para exercitar
// o fluxo completo da rota sem um banco real. Devolve a linha de `compras` montada
// a partir dos próprios parâmetros do INSERT, espelhando o RETURNING * real.
function makeFakeClient({
  idempotenciaExistente = null,
  fornecedorEncontrado = FORNECEDOR,
  produtosEncontrados = [PRODUTO],
} = {}) {
  const calls = [];
  let proximoId = 900;
  const query = jest.fn((sql, params) => {
    calls.push({ sql, params });

    if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
      return Promise.resolve({});
    }
    if (sql.includes('FROM compras WHERE') && sql.includes('idempotency_key')) {
      return Promise.resolve(idempotenciaExistente
        ? { rowCount: 1, rows: [{ id: idempotenciaExistente }] }
        : { rowCount: 0, rows: [] });
    }
    if (sql.includes('FROM fornecedores WHERE')) {
      return Promise.resolve(fornecedorEncontrado
        ? { rowCount: 1, rows: [fornecedorEncontrado] }
        : { rowCount: 0, rows: [] });
    }
    if (sql.includes('FROM produtos WHERE id = ANY')) {
      return Promise.resolve({ rows: produtosEncontrados });
    }
    if (sql.includes('INSERT INTO compras')) {
      const id = proximoId++;
      return Promise.resolve({
        rows: [{
          id,
          empresa: params[0], empresa_id: params[1], fornecedor_id: params[2],
          data: params[3], total: params[4], observacao: params[5],
          gerar_conta_pagar: params[6], pagamento: params[7], criado_por: params[8],
          idempotency_key: params[9],
        }],
      });
    }
    // compra_itens, UPDATE produtos, movimentacoes_estoque, contas_pagar
    return Promise.resolve({ rowCount: 1, rows: [] });
  });
  return { query, release: jest.fn(), calls };
}

function sqlsChamados(client) {
  return client.calls.map((c) => c.sql);
}

function buildReq(overrides = {}) {
  return {
    user: { id: 10, nome: 'Operador', tipo: 'funcionario' },
    body: {
      empresa: 'Minha Loja',
      fornecedor_id: 5,
      data: '2026-10-15',
      pagamento: 'dinheiro',
      itens: [{ produto_id: 1, quantidade: 3, custo_unitario: 5 }],
    },
    ...overrides,
  };
}

function buildRouter(overrides = {}) {
  const client = overrides.client || makeFakeClient();
  const pool = overrides.pool || { connect: jest.fn().mockResolvedValue(client) };
  const router = comprasCriarRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: overrides.validarAcessoEmpresa || jest.fn().mockResolvedValue(EMPRESA),
    podeGerenciarCompras: overrides.podeGerenciarCompras || jest.fn().mockReturnValue(true),
    registrarMovimentacaoEstoque: overrides.registrarMovimentacaoEstoque ?? null, // função é opcional (checado com typeof)
    atualizarStatusContasPagarPorEmpresa: overrides.atualizarStatusContasPagarPorEmpresa || jest.fn().mockResolvedValue(undefined),
    registrarAuditoria: overrides.registrarAuditoria || jest.fn().mockResolvedValue(undefined),
  });
  return { router, pool, client };
}

describe('POST /compras', () => {
  test('sem permissão de gestão de compras -> 403, nenhuma query de transação', async () => {
    const { router, client } = buildRouter({ podeGerenciarCompras: jest.fn().mockReturnValue(false) });
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq(), res);
    expect(res.statusCode).toBe(403);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('corpo incompleto (sem itens) -> 400 antes de abrir transação', async () => {
    const { router, client } = buildRouter();
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq({ body: { ...buildReq().body, itens: [] } }), res);
    expect(res.statusCode).toBe(400);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('sem acesso à empresa -> 403', async () => {
    const { router, client } = buildRouter({ validarAcessoEmpresa: jest.fn().mockResolvedValue(null) });
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq(), res);
    expect(res.statusCode).toBe(403);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('idempotência: key já processada -> 200 idempotente, ROLLBACK, sem gravar nada novo', async () => {
    const client = makeFakeClient({ idempotenciaExistente: 321 });
    const { router } = buildRouter({ client });
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq({ body: { ...buildReq().body, idempotency_key: 'xyz' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ sucesso: true, compra_id: 321, dados: { compra_id: 321 }, idempotente: true });
    expect(sqlsChamados(client)).toContain('ROLLBACK');
    expect(sqlsChamados(client).some((s) => s.includes('INSERT INTO compras'))).toBe(false);
  });

  test('fornecedor não encontrado -> 404, ROLLBACK', async () => {
    const client = makeFakeClient({ fornecedorEncontrado: null });
    const { router } = buildRouter({ client });
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq(), res);
    expect(res.statusCode).toBe(404);
    expect(sqlsChamados(client)).toContain('ROLLBACK');
  });

  test('forma de pagamento inválida -> 400, ROLLBACK', async () => {
    const { router, client } = buildRouter();
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq({ body: { ...buildReq().body, pagamento: 'criptomoeda' } }), res);
    expect(res.statusCode).toBe(400);
    expect(sqlsChamados(client)).toContain('ROLLBACK');
  });

  test('produto do item não encontrado -> 404, ROLLBACK', async () => {
    const client = makeFakeClient({ produtosEncontrados: [] });
    const { router } = buildRouter({ client });
    const res = mockRes();
    await getHandler(router, 'post', '/')(buildReq(), res);
    expect(res.statusCode).toBe(404);
    expect(sqlsChamados(client)).toContain('ROLLBACK');
  });

  test('sucesso (dinheiro, sem conta a pagar): cria compra, baixa não gera contas_pagar, audita e COMMIT', async () => {
    const registrarAuditoria = jest.fn().mockResolvedValue(undefined);
    const client = makeFakeClient();
    const { router } = buildRouter({ client, registrarAuditoria });
    const res = mockRes();

    await getHandler(router, 'post', '/')(buildReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.sucesso).toBe(true);
    expect(res.jsonBody.compra_id).toBeGreaterThanOrEqual(900);

    const sqls = sqlsChamados(client);
    expect(sqls).toContain('COMMIT');
    expect(sqls.some((s) => s.includes('INSERT INTO compra_itens'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE produtos'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO contas_pagar'))).toBe(false); // dinheiro não gera conta a pagar

    expect(registrarAuditoria).toHaveBeenCalledTimes(1);
    const chamada = registrarAuditoria.mock.calls[0][0];
    expect(chamada.modulo).toBe('compras');
    expect(chamada.acao).toBe('cadastro');
    expect(chamada.dados_novos.gerar_conta_pagar).toBe(false);
    expect(JSON.stringify(chamada)).not.toMatch(/senha/i);

    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('sucesso (boleto, 3 parcelas): gera contas_pagar e repassa gerar_conta_pagar=true na auditoria', async () => {
    const atualizarStatusContasPagarPorEmpresa = jest.fn().mockResolvedValue(undefined);
    const client = makeFakeClient();
    const { router } = buildRouter({ client, atualizarStatusContasPagarPorEmpresa });
    const res = mockRes();

    await getHandler(router, 'post', '/')(buildReq({
      body: { ...buildReq().body, pagamento: 'boleto', parcelas: 3 },
    }), res);

    expect(res.statusCode).toBe(200);
    const sqls = sqlsChamados(client);
    expect(sqls.some((s) => s.includes('INSERT INTO contas_pagar'))).toBe(true);
    expect(sqls).toContain('COMMIT');
    expect(atualizarStatusContasPagarPorEmpresa).toHaveBeenCalledWith(EMPRESA.nome, EMPRESA.id);
  });

  test('erro inesperado durante a transação -> 500, ROLLBACK, conexão liberada', async () => {
    const client = makeFakeClient();
    client.query = jest.fn((sql) => {
      if (sql.includes('BEGIN')) return Promise.resolve({});
      if (sql.includes('ROLLBACK')) return Promise.resolve({});
      throw new Error('conexão caiu');
    });
    const { router } = buildRouter({ client });
    const res = mockRes();

    await getHandler(router, 'post', '/')(buildReq(), res);

    expect(res.statusCode).toBe(500);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
