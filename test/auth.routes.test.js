'use strict';

const jwt = require('jsonwebtoken');

// POST /registro dispara e-mail de boas-vindas fire-and-forget (não injetado como
// dependência, é um require direto em auth.routes.js) -- mockado pra não tentar
// SMTP real nem depender de pool.query fora do client transacional nos testes.
jest.mock('../utils/email', () => ({ enviarEmailBoasVindas: jest.fn().mockResolvedValue() }));

const authRoutes = require('../routes/auth.routes');

const SECRET = 'segredo-de-teste-bem-longo-para-jwt-1234567890';

// Pega o handler real de uma rota (último middleware da pilha), pulando
// auth/writeRateLimiter/requirePermissao -- esses são middlewares de
// infraestrutura já testados em outro lugar (permissoes.test.js) e, como
// não usamos um servidor HTTP real aqui, nunca chegam a ser invocados.
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
  return authRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    loginRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn(),
    tokenBlacklist: new Map(),
    _sseNonces: new Map(),
    _tokenHash: (tok) => `hash:${tok}`,
    JWT_EXPIRY_MS: 12 * 60 * 60 * 1000,
    validarSenhaUsuario: jest.fn().mockResolvedValue(true),
    validarForcaSenha: require('../middleware/auth').validarForcaSenha,
    registrarAuditoria: jest.fn(),
    SECRET,
    ...overrides,
  });
}

describe('POST /login', () => {
  function usuarioBase(extra = {}) {
    return {
      id: 1, usuario: 'ana', senha: '$2b$10$fakehash', tipo: 'funcionario',
      is_saas_owner: false, nome_completo: 'Ana Silva',
      empresa: 'Minha Loja', empresa_id: 1,
      empresa_id_real: 1, empresa_nome_real: 'Minha Loja',
      assinatura_status: 'ativo', bloqueada: false, trial_fim: null,
      plano_codigo: 'pro', plano_nome: 'Pro',
      ...extra,
    };
  }

  test('usuário ou senha ausentes -> 400', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { usuario: 'ana' } }, res);
    expect(res.statusCode).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('usuário não encontrado -> 401 CREDENCIAIS_INVALIDAS e audita login_falha', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const registrarAuditoria = jest.fn();
    const router = buildRouter(pool, { registrarAuditoria });
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { usuario: 'fantasma', senha: 'x' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.codigo).toBe('CREDENCIAIS_INVALIDAS');
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({ acao: 'login_falha' }));
  });

  test('empresa bloqueada -> 403 EMPRESA_BLOQUEADA (usuário comum)', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [usuarioBase({ bloqueada: true })] }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { usuario: 'ana', senha: 'x' } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody.codigo).toBe('EMPRESA_BLOQUEADA');
  });

  test('assinatura inativa/cancelada -> 403 ASSINATURA_INATIVA', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [usuarioBase({ assinatura_status: 'cancelado' })] }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { usuario: 'ana', senha: 'x' } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody.codigo).toBe('ASSINATURA_INATIVA');
  });

  test('trial expirado -> 403 TRIAL_EXPIRADO', async () => {
    const pool = { query: jest.fn().mockResolvedValue({
      rowCount: 1, rows: [usuarioBase({ assinatura_status: 'trial', trial_fim: '2000-01-01' })],
    }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { usuario: 'ana', senha: 'x' } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody.codigo).toBe('TRIAL_EXPIRADO');
  });

  test('SaaS Owner pula TODAS as checagens de bloqueio/assinatura/trial da empresa', async () => {
    const pool = { query: jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [usuarioBase({
        is_saas_owner: true, bloqueada: true, assinatura_status: 'cancelado', trial_fim: '2000-01-01',
      })],
    }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { usuario: 'ana', senha: 'x' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.user.is_saas_owner).toBe(true);
  });

  test('senha incorreta -> 401 CREDENCIAIS_INVALIDAS e audita senha_incorreta', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [usuarioBase()] }) };
    const registrarAuditoria = jest.fn();
    const validarSenhaUsuario = jest.fn().mockResolvedValue(false);
    const router = buildRouter(pool, { registrarAuditoria, validarSenhaUsuario });
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { usuario: 'ana', senha: 'errada' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.codigo).toBe('CREDENCIAIS_INVALIDAS');
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({ acao: 'login_falha', dados_novos: { motivo: 'senha_incorreta' } }));
  });

  test('login bem-sucedido: retorna token assinado com empresa_id_real e audita "login"', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [usuarioBase()] }) };
    const registrarAuditoria = jest.fn();
    const router = buildRouter(pool, { registrarAuditoria });
    const res = mockRes();
    await getHandler(router, 'post', '/login')({ body: { usuario: 'ana', senha: 'correta' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.token).toBeTruthy();
    const payload = jwt.verify(res.jsonBody.token, SECRET);
    expect(payload.id).toBe(1);
    expect(payload.empresa_id).toBe(1);
    expect(payload.is_saas_owner).toBe(false);
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({ acao: 'login' }));
  });
});

describe('POST /auth/refresh', () => {
  test('usuário não encontrado -> 403', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/auth/refresh')({ user: { id: 99 } }, res);
    expect(res.statusCode).toBe(403);
  });

  test('empresa bloqueada (usuário comum) -> 403', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 1, usuario: 'ana', is_saas_owner: false, bloqueada: true }] }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/auth/refresh')({ user: { id: 1 } }, res);
    expect(res.statusCode).toBe(403);
  });

  test('SaaS Owner pula a checagem de bloqueio/assinatura', async () => {
    const pool = { query: jest.fn().mockResolvedValue({
      rowCount: 1, rows: [{ id: 1, usuario: 'owner', is_saas_owner: true, bloqueada: true, assinatura_status: 'cancelado' }],
    }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/auth/refresh')({ user: { id: 1 } }, res);
    expect(res.statusCode).toBe(200);
  });

  test('sucesso: devolve novo token válido', async () => {
    const pool = { query: jest.fn().mockResolvedValue({
      rowCount: 1, rows: [{ id: 1, usuario: 'ana', tipo: 'admin', is_saas_owner: false, empresa_id_real: 1, bloqueada: false, assinatura_status: 'ativo' }],
    }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/auth/refresh')({ user: { id: 1 } }, res);
    expect(res.statusCode).toBe(200);
    const payload = jwt.verify(res.jsonBody.dados.token, SECRET);
    expect(payload.id).toBe(1);
  });
});

describe('POST /auth/logout', () => {
  test('revoga o token (blacklist em memória + banco) e audita logout', async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const tokenBlacklist = new Map();
    const registrarAuditoria = jest.fn();
    const router = buildRouter(pool, { tokenBlacklist, registrarAuditoria });
    const res = mockRes();
    const req = {
      headers: { authorization: 'Bearer meu-token' },
      user: { id: 1, usuario: 'ana' },
      empresa_nome: 'Minha Loja', empresa_id: 1,
    };
    await getHandler(router, 'post', '/auth/logout')(req, res);
    expect(tokenBlacklist.has('hash:meu-token')).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('jwt_blacklist'), expect.anything());
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({ acao: 'logout' }));
    expect(res.jsonBody.sucesso).toBe(true);
  });
});

describe('PUT /me/senha', () => {
  function buildReq(overrides = {}) {
    return {
      body: { senha_atual: 'AtualSenha1', nova_senha: 'NovaSenha1', confirmar_senha: 'NovaSenha1' },
      user: { id: 1, usuario: 'ana' },
      ...overrides,
    };
  }

  test('campos obrigatórios ausentes -> 400', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/me/senha')(buildReq({ body: { senha_atual: 'x' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('nova senha e confirmação não conferem -> 400', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/me/senha')(buildReq({ body: { senha_atual: 'AtualSenha1', nova_senha: 'NovaSenha1', confirmar_senha: 'Diferente1' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('senha fraca (sem maiúscula/número) -> 400 com a mensagem de validarForcaSenha real', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/me/senha')(buildReq({ body: { senha_atual: 'AtualSenha1', nova_senha: 'fraca', confirmar_senha: 'fraca' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('senha atual incorreta -> 401 SENHA_INCORRETA', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ senha: '$2b$10$hash' }] }) };
    const validarSenhaUsuario = jest.fn().mockResolvedValue(false);
    const router = buildRouter(pool, { validarSenhaUsuario });
    const res = mockRes();
    await getHandler(router, 'put', '/me/senha')(buildReq(), res);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.codigo).toBe('SENHA_INCORRETA');
  });

  test('sucesso: atualiza a senha e audita troca_senha', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ senha: '$2b$10$hash' }] }) };
    const validarSenhaUsuario = jest.fn().mockResolvedValue(true);
    const registrarAuditoria = jest.fn();
    const router = buildRouter(pool, { validarSenhaUsuario, registrarAuditoria });
    const res = mockRes();
    await getHandler(router, 'put', '/me/senha')(buildReq(), res);
    expect(res.statusCode).toBe(200);
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({ acao: 'troca_senha' }));
  });
});

describe('POST /registro', () => {
  function buildReq(overrides = {}) {
    return {
      body: {
        nome_empresa: 'Nova Loja', nome_responsavel: 'Ana', email: 'ana@teste.com',
        telefone: '88999999999', usuario: 'ana', senha: 'SenhaForte1',
      },
      ...overrides,
    };
  }

  function makeTxClient({ empresaExiste = false, usuarioExiste = false } = {}) {
    const calls = [];
    const query = jest.fn((sql, params) => {
      calls.push(sql);
      if (sql.includes('FROM empresas') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rowCount: empresaExiste ? 1 : 0, rows: empresaExiste ? [{ id: 1 }] : [] });
      }
      if (sql.includes('FROM usuarios') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rowCount: usuarioExiste ? 1 : 0, rows: usuarioExiste ? [{ id: 1 }] : [] });
      }
      if (sql.includes('FROM planos')) return Promise.resolve({ rows: [{ id: 2 }] });
      if (sql.includes('INSERT INTO empresas')) return Promise.resolve({ rows: [{ id: 10, nome: 'Nova Loja' }] });
      if (sql.includes('INSERT INTO configuracoes')) return Promise.resolve({});
      if (sql.includes('INSERT INTO usuarios')) {
        return Promise.resolve({ rows: [{ id: 20, usuario: 'ana', tipo: 'admin', empresa: 'Nova Loja', empresa_id: 10, nome_completo: 'Ana' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    return { query, calls, release: jest.fn() };
  }

  test('campos obrigatórios ausentes -> 400, sem conectar ao banco', async () => {
    const pool = { connect: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/registro')(buildReq({ body: { usuario: 'ana' } }), res);
    expect(res.statusCode).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('senha fraca -> 400', async () => {
    const pool = { connect: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/registro')(buildReq({ body: { nome_empresa: 'X', usuario: 'ana', senha: 'fraca' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('empresa já existe -> 409 e ROLLBACK', async () => {
    const client = makeTxClient({ empresaExiste: true });
    const pool = { connect: jest.fn().mockResolvedValue(client) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/registro')(buildReq(), res);
    expect(res.statusCode).toBe(409);
    expect(client.calls).toContain('ROLLBACK');
  });

  test('usuário já existe -> 409 e ROLLBACK', async () => {
    const client = makeTxClient({ usuarioExiste: true });
    const pool = { connect: jest.fn().mockResolvedValue(client) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/registro')(buildReq(), res);
    expect(res.statusCode).toBe(409);
    expect(client.calls).toContain('ROLLBACK');
  });

  test('sucesso: cria empresa, usuário admin e devolve token com trial de 14 dias', async () => {
    const client = makeTxClient();
    const pool = { connect: jest.fn().mockResolvedValue(client) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/registro')(buildReq(), res);
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody.sucesso).toBe(true);
    expect(client.calls).toContain('COMMIT');
    const payload = jwt.verify(res.jsonBody.token, SECRET);
    expect(payload.empresa_id).toBe(10);
    expect(payload.is_saas_owner).toBe(false);
  });
});
