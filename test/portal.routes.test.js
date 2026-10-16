'use strict';

// POST /portal/login revelava, antes de qualquer verificação de senha, se um
// CPF/CNPJ estava cadastrado como cliente em mais de uma empresa do SaaS
// (status 409 vs 401) — oráculo de enumeração cross-tenant sem senha (achado
// A2-SEC-003, Auditoria de Segurança 2026-10-16). Os rate limiters do portal
// também eram Maps em memória do processo; agora usam o limiter
// compartilhado via banco (achado A2-SEC-004).

process.env.JWT_SECRET = 'segredo-de-teste-bem-longo-para-jwt-1234567890';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const portalRoutes = require('../routes/portal.routes');

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

// Hash real de 'SenhaCerta1' e 'SenhaErrada1' pré-computados (bcrypt é lento,
// evita recalcular em cada teste) via bcrypt.hashSync.
const HASH_CERTA = bcrypt.hashSync('SenhaCerta1', 4);
const HASH_OUTRA = bcrypt.hashSync('OutraSenha1', 4);

function buildRouter(pool, overrides = {}) {
  return portalRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool,
    ...overrides,
  });
}

function buildPoolLogin(rows) {
  return {
    query: jest.fn((sql) => {
      if (sql.includes('rate_limit_buckets')) {
        return Promise.resolve({ rows: [{ request_count: 1, window_started_at: new Date() }] });
      }
      if (sql.includes('FROM clientes c')) return Promise.resolve({ rowCount: rows.length, rows });
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('POST /portal/login — oráculo de enumeração cross-tenant (A2-SEC-003)', () => {
  test('CPF em 2 empresas, senha não bate com NENHUM candidato -> 401 (nunca revela 409)', async () => {
    const pool = buildPoolLogin([
      { id: 1, empresa_id: 10, empresa_nome: 'Loja A', senha_portal: HASH_CERTA },
      { id: 2, empresa_id: 20, empresa_nome: 'Loja B', senha_portal: HASH_OUTRA },
    ]);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { cpf_cnpj: '12345678901', senha: 'SenhaQualquer1' } }, res);
    expect(res.statusCode).toBe(401);
  });

  test('CPF em 2 empresas, senha bate com exatamente 1 candidato -> 200, loga nessa empresa', async () => {
    const pool = buildPoolLogin([
      { id: 1, empresa_id: 10, empresa_nome: 'Loja A', nome: 'Cliente A', senha_portal: HASH_CERTA },
      { id: 2, empresa_id: 20, empresa_nome: 'Loja B', nome: 'Cliente B', senha_portal: HASH_OUTRA },
    ]);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { cpf_cnpj: '12345678901', senha: 'SenhaCerta1' } }, res);
    expect(res.statusCode).toBe(200);
    const payload = jwt.verify(res.jsonBody.token, process.env.JWT_SECRET + '_portal_v1');
    expect(payload.empresa_id).toBe(10);
  });

  test('CPF em 2 empresas, senha bate com AMBOS os candidatos (colisão real) -> 409 só então', async () => {
    const pool = buildPoolLogin([
      { id: 1, empresa_id: 10, empresa_nome: 'Loja A', senha_portal: HASH_CERTA },
      { id: 2, empresa_id: 20, empresa_nome: 'Loja B', senha_portal: HASH_CERTA },
    ]);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { cpf_cnpj: '12345678901', senha: 'SenhaCerta1' } }, res);
    expect(res.statusCode).toBe(409);
  });

  test('CPF não encontrado -> 401 com dummy compare (sem distinguir de senha errada)', async () => {
    const pool = buildPoolLogin([]);
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { cpf_cnpj: '00000000000', senha: 'qualquer' } }, res);
    expect(res.statusCode).toBe(401);
  });
});

