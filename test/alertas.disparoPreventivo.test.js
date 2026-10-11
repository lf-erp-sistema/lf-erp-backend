'use strict';

const alertasRoutes = require('../routes/alertas.routes');

// Extrai a pilha de middlewares de uma rota (não só o último) -- precisamos
// disparar o gate (auth + requirePermissao + writeRateLimiter) e o handler
// final em sequência, igual o Express faria de verdade.
function getStack(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    if (paths.includes(path) && layer.route.methods[method]) {
      return layer.route.stack.map((l) => l.handle);
    }
  }
  throw new Error(`Rota não encontrada: ${method.toUpperCase()} ${path}`);
}

function mockRes() {
  const res = {
    statusCode: 200,
    jsonBody: null,
    _resolve: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; if (this._resolve) this._resolve(); return this; },
  };
  return res;
}

function dispatch(stack, req, res) {
  return new Promise((resolve, reject) => {
    res._resolve = resolve;
    let i = 0;
    function next(err) {
      if (err) return reject(err);
      const fn = stack[i++];
      if (!fn) return resolve();
      Promise.resolve(fn(req, res, next)).catch(reject);
    }
    next();
  });
}

function fakeAuthOk(user) {
  return (req, res, next) => { req.user = user; next(); };
}

function fakeAuthSemToken(req, res) {
  res.status(403).json({ sucesso: false, erro: 'Sem acesso', codigo: 'SEM_TOKEN' });
}

function makePool({ individualPerm = null, padraoPerm = null, empresaRow = { id: 1, nome: 'Loja' }, cobrancaAtiva = true, contasReceberRows = [] } = {}) {
  const calls = [];
  const query = jest.fn((sql, params) => {
    calls.push(sql);
    if (sql.includes('FROM permissoes_usuario')) {
      return Promise.resolve(individualPerm ? { rowCount: 1, rows: [individualPerm] } : { rowCount: 0, rows: [] });
    }
    if (sql.includes('FROM permissoes_padrao')) {
      return Promise.resolve(padraoPerm ? { rowCount: 1, rows: [padraoPerm] } : { rowCount: 0, rows: [] });
    }
    if (sql.includes('FROM empresas WHERE id')) {
      return Promise.resolve(empresaRow ? { rowCount: 1, rows: [empresaRow] } : { rowCount: 0, rows: [] });
    }
    if (sql.includes('cobranca_preventiva_ativa FROM alertas_config')) {
      return Promise.resolve({ rowCount: 1, rows: [{ cobranca_preventiva_ativa: cobrancaAtiva }] });
    }
    if (sql.includes('FROM contas_receber cr')) {
      return Promise.resolve({ rowCount: contasReceberRows.length, rows: contasReceberRows });
    }
    return Promise.resolve({ rowCount: 0, rows: [] });
  });
  return { query, calls };
}

function buildRouter(overrides = {}) {
  const pool = overrides.pool || makePool();
  return {
    router: alertasRoutes({
      auth: overrides.auth || fakeAuthOk({ id: 1, tipo: 'admin', empresa_id: 1, empresa: 'Loja' }),
      writeRateLimiter: overrides.writeRateLimiter || ((req, res, next) => next()),
      pool,
      validarAcessoEmpresa: overrides.validarAcessoEmpresa || jest.fn().mockResolvedValue({ id: 1, nome: 'Loja' }),
    }),
    pool,
  };
}

describe('POST /alertas/disparar-preventivo — autorização', () => {
  const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = 'segredo-cron-de-teste'; });
  afterEach(() => { process.env.CRON_SECRET = ORIGINAL_CRON_SECRET; });

  test('cron válido (X-Cron-Secret correto) consegue executar sem JWT', async () => {
    const { router } = buildRouter({ auth: fakeAuthSemToken }); // auth nunca deveria ser chamado aqui
    const stack = getStack(router, 'post', '/disparar-preventivo');
    const req = {
      headers: { 'x-cron-secret': 'segredo-cron-de-teste' },
      body: { empresa_id: 1, somente_hoje: false },
      query: {},
    };
    const res = mockRes();
    await dispatch(stack, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.sucesso).toBe(true);
  });

  test('usuário autenticado SEM permissão financeiro/editar recebe 403, sem chegar no handler', async () => {
    const pool = makePool(); // sem override individual nem padrão => nega
    const { router } = buildRouter({
      auth: fakeAuthOk({ id: 2, tipo: 'funcionario', empresa_id: 1, empresa: 'Loja' }),
      pool,
    });
    const stack = getStack(router, 'post', '/disparar-preventivo');
    const req = { headers: {}, body: { somente_hoje: false }, query: {} };
    const res = mockRes();
    await dispatch(stack, req, res);
    expect(res.statusCode).toBe(403);
    expect(pool.calls.some((s) => s.includes('FROM contas_receber'))).toBe(false);
  });

  test('usuário com financeiro/editar (admin) consegue executar no caminho manual', async () => {
    const pool = makePool({ contasReceberRows: [] });
    const { router } = buildRouter({
      auth: fakeAuthOk({ id: 1, tipo: 'admin', empresa_id: 1, empresa: 'Loja' }),
      pool,
    });
    const stack = getStack(router, 'post', '/disparar-preventivo');
    const req = { headers: {}, body: { somente_hoje: false }, query: {} };
    const res = mockRes();
    await dispatch(stack, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.sucesso).toBe(true);
  });

  test('requisição sem cron válido e sem JWT válido recebe 401/403', async () => {
    const { router } = buildRouter({ auth: fakeAuthSemToken });
    const stack = getStack(router, 'post', '/disparar-preventivo');
    const req = { headers: {}, body: {}, query: {} }; // sem x-cron-secret, auth rejeita
    const res = mockRes();
    await dispatch(stack, req, res);
    expect([401, 403]).toContain(res.statusCode);
  });

  test('rate limiter (writeRateLimiter) é acionado no caminho manual mas não no caminho cron', async () => {
    const writeRateLimiterManual = jest.fn((req, res, next) => next());
    const { router: routerManual } = buildRouter({
      auth: fakeAuthOk({ id: 1, tipo: 'admin', empresa_id: 1, empresa: 'Loja' }),
      writeRateLimiter: writeRateLimiterManual,
      pool: makePool({ contasReceberRows: [] }),
    });
    const stackManual = getStack(routerManual, 'post', '/disparar-preventivo');
    await dispatch(stackManual, { headers: {}, body: { somente_hoje: false }, query: {} }, mockRes());
    expect(writeRateLimiterManual).toHaveBeenCalledTimes(1);

    const writeRateLimiterCron = jest.fn((req, res, next) => next());
    const { router: routerCron } = buildRouter({
      auth: fakeAuthSemToken,
      writeRateLimiter: writeRateLimiterCron,
      pool: makePool({ contasReceberRows: [] }),
    });
    const stackCron = getStack(routerCron, 'post', '/disparar-preventivo');
    await dispatch(stackCron, {
      headers: { 'x-cron-secret': 'segredo-cron-de-teste' },
      body: { empresa_id: 1, somente_hoje: false },
      query: {},
    }, mockRes());
    expect(writeRateLimiterCron).not.toHaveBeenCalled();
  });
});
