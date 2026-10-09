'use strict';

jest.mock('../utils/permissoes', () => ({
  obterPermissoes: jest.fn().mockResolvedValue({ produtos: { pode_ver: true } }),
}));

const { requirePermissao } = jest.requireActual('../utils/permissoes');
const usuariosRoutes = require('../routes/usuarios.routes');

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
  return usuariosRoutes({
    auth: (req, res, next) => next(),
    writeRateLimiter: (req, res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue({ id: 1, nome: 'Minha Loja' }),
    validarLimitePlano: jest.fn().mockResolvedValue({ permitido: true }),
    validarForcaSenha: require('../middleware/auth').validarForcaSenha,
    requirePermissao, // middleware real, mas nunca é invocado (getHandler pula pra última função da pilha)
    registrarAuditoria: jest.fn(),
    ...overrides,
  });
}

const ADMIN = { id: 1, tipo: 'admin', nome: 'Admin' };
const GERENTE = { id: 2, tipo: 'gerente', nome: 'Gerente' };
const FUNCIONARIO = { id: 3, tipo: 'funcionario', nome: 'Func' };

describe('POST /usuarios (criar)', () => {
  function buildReq(overrides = {}) {
    return {
      user: ADMIN,
      body: { empresa: 'Minha Loja', nome: 'Novo', usuario: 'novo', senha: 'SenhaForte1', tipo: 'funcionario' },
      ...overrides,
    };
  }

  test('funcionário sem permissão de gestão -> 403', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/usuarios')(buildReq({ user: FUNCIONARIO }), res);
    expect(res.statusCode).toBe(403);
  });

  test('dados obrigatórios ausentes -> 400', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/usuarios')(buildReq({ body: { empresa: 'Minha Loja' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('tipo inválido -> 400', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/usuarios')(buildReq({ body: { ...buildReq().body, tipo: 'ceo' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('senha fraca -> 400', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/usuarios')(buildReq({ body: { ...buildReq().body, senha: 'fraca' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('sem acesso à empresa -> 403', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool, { validarAcessoEmpresa: jest.fn().mockResolvedValue(null) });
    const res = mockRes();
    await getHandler(router, 'post', '/usuarios')(buildReq(), res);
    expect(res.statusCode).toBe(403);
  });

  test('limite de plano excedido -> 403', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool, { validarLimitePlano: jest.fn().mockResolvedValue({ permitido: false, mensagem: 'Limite de usuários atingido' }) });
    const res = mockRes();
    await getHandler(router, 'post', '/usuarios')(buildReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody.erro).toBe('Limite de usuários atingido');
  });

  test('usuário duplicado (ON CONFLICT DO NOTHING) -> 400 e ROLLBACK', async () => {
    const calls = [];
    const client = {
      query: jest.fn((sql) => {
        calls.push(sql);
        if (sql.includes('INSERT INTO usuarios')) return Promise.resolve({ rowCount: 0, rows: [] });
        return Promise.resolve({});
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'post', '/usuarios')(buildReq(), res);
    expect(res.statusCode).toBe(400);
    expect(calls).toContain('ROLLBACK');
  });

  test('sucesso: insere, comita e audita "cadastro" sem incluir a senha', async () => {
    const client = {
      query: jest.fn((sql) => {
        if (sql.includes('INSERT INTO usuarios')) return Promise.resolve({ rowCount: 1, rows: [{ id: 42 }] });
        return Promise.resolve({});
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
    const registrarAuditoria = jest.fn();
    const router = buildRouter(pool, { registrarAuditoria });
    const res = mockRes();
    await getHandler(router, 'post', '/usuarios')(buildReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ id: 42 });
    const chamada = registrarAuditoria.mock.calls[0][0];
    expect(chamada.acao).toBe('cadastro');
    expect(JSON.stringify(chamada.dados_novos)).not.toMatch(/SenhaForte1|senha/i);
  });
});

describe('PUT /usuarios/:id (editar)', () => {
  function buildReq(overrides = {}) {
    return {
      user: ADMIN,
      params: { id: '5' },
      body: { empresa: 'Minha Loja', nome: 'Editado', usuario: 'editado', tipo: 'gerente' },
      ...overrides,
    };
  }

  function poolComUsuarioAtual(extra = {}) {
    return {
      query: jest.fn((sql, params) => {
        if (sql.includes('SELECT * FROM usuarios')) {
          return Promise.resolve({ rowCount: 1, rows: [{ id: 5, nome_completo: 'Antigo', usuario: 'antigo', tipo: 'funcionario', senha: '$2b$10$segredo', ...extra }] });
        }
        if (sql.includes('usuario = $1 AND id <> $2')) return Promise.resolve({ rowCount: 0, rows: [] });
        return Promise.resolve({ rowCount: 1, rows: [] });
      }),
    };
  }

  test('gerente sem permissão de gestão (funcionário) -> 403', async () => {
    const pool = poolComUsuarioAtual();
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id')(buildReq({ user: FUNCIONARIO }), res);
    expect(res.statusCode).toBe(403);
  });

  test('tipo inválido -> 400', async () => {
    const pool = poolComUsuarioAtual();
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id')(buildReq({ body: { ...buildReq().body, tipo: 'ceo' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('usuário não encontrado -> 404', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id')(buildReq(), res);
    expect(res.statusCode).toBe(404);
  });

  test('login já usado por outro usuário -> 400', async () => {
    const pool = {
      query: jest.fn((sql) => {
        if (sql.includes('SELECT * FROM usuarios')) return Promise.resolve({ rowCount: 1, rows: [{ id: 5, nome_completo: 'Antigo', usuario: 'antigo', tipo: 'funcionario' }] });
        if (sql.includes('usuario = $1 AND id <> $2')) return Promise.resolve({ rowCount: 1, rows: [{ id: 99 }] });
        return Promise.resolve({ rowCount: 1, rows: [] });
      }),
    };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id')(buildReq(), res);
    expect(res.statusCode).toBe(400);
  });

  test('sucesso sem trocar senha: audita "edicao" com senha_alterada=false e sem vazar hash de senha', async () => {
    const pool = poolComUsuarioAtual();
    const registrarAuditoria = jest.fn();
    const router = buildRouter(pool, { registrarAuditoria });
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id')(buildReq(), res);
    expect(res.statusCode).toBe(200);
    const chamada = registrarAuditoria.mock.calls[0][0];
    expect(chamada.acao).toBe('edicao');
    expect(chamada.dados_novos.senha_alterada).toBe(false);
    expect(JSON.stringify(chamada.dados_anteriores)).not.toMatch(/\$2b\$10\$segredo/);
    expect(JSON.stringify(chamada.dados_novos)).not.toMatch(/\$2b\$10\$segredo/);
  });

  test('sucesso trocando a senha: audita senha_alterada=true e AINDA ASSIM não inclui a senha/hash no log', async () => {
    const pool = poolComUsuarioAtual();
    const registrarAuditoria = jest.fn();
    const router = buildRouter(pool, { registrarAuditoria });
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id')(buildReq({ body: { ...buildReq().body, senha: 'NovaSenhaForte1' } }), res);
    expect(res.statusCode).toBe(200);
    const chamada = registrarAuditoria.mock.calls[0][0];
    expect(chamada.dados_novos.senha_alterada).toBe(true);
    expect(JSON.stringify(chamada.dados_anteriores)).not.toMatch(/segredo/);
    expect(JSON.stringify(chamada.dados_novos)).not.toMatch(/NovaSenhaForte1|\$2b\$/);
  });

  test('senha nova fraca -> 400', async () => {
    const pool = poolComUsuarioAtual();
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id')(buildReq({ body: { ...buildReq().body, senha: 'fraca' } }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /usuarios/:id (excluir)', () => {
  function buildReq(overrides = {}) {
    return { user: ADMIN, params: { id: '7' }, query: {}, ...overrides };
  }

  test('sem permissão de gestão -> 403', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'delete', '/usuarios/:id')(buildReq({ user: FUNCIONARIO }), res);
    expect(res.statusCode).toBe(403);
  });

  test('tentar excluir o próprio usuário -> 400', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'delete', '/usuarios/:id')(buildReq({ user: { ...ADMIN, id: 7 }, params: { id: '7' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('usuário não encontrado -> 404', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'delete', '/usuarios/:id')(buildReq(), res);
    expect(res.statusCode).toBe(404);
  });

  test('sucesso: exclui e audita "exclusao" com dados anteriores sem senha', async () => {
    const pool = {
      query: jest.fn((sql) => {
        if (sql.includes('SELECT id, nome_completo, usuario, tipo')) {
          return Promise.resolve({ rowCount: 1, rows: [{ id: 7, nome_completo: 'Joao', usuario: 'joao', tipo: 'funcionario' }] });
        }
        return Promise.resolve({ rowCount: 1 });
      }),
    };
    const registrarAuditoria = jest.fn();
    const router = buildRouter(pool, { registrarAuditoria });
    const res = mockRes();
    await getHandler(router, 'delete', '/usuarios/:id')(buildReq(), res);
    expect(res.statusCode).toBe(200);
    const chamada = registrarAuditoria.mock.calls[0][0];
    expect(chamada.acao).toBe('exclusao');
    expect(chamada.dados_anteriores).toEqual({ nome: 'Joao', usuario: 'joao', tipo: 'funcionario' });
  });
});

describe('PUT /usuarios/:id/permissoes', () => {
  function buildReq(overrides = {}) {
    return {
      user: ADMIN,
      params: { id: '5' },
      body: { permissoes: { produtos: { pode_ver: true, pode_criar: true, pode_editar: false, pode_deletar: false } } },
      ...overrides,
    };
  }

  test('sem permissão de gestão -> 403', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id/permissoes')(buildReq({ user: FUNCIONARIO }), res);
    expect(res.statusCode).toBe(403);
  });

  test('usuário não encontrado -> 404', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id/permissoes')(buildReq(), res);
    expect(res.statusCode).toBe(404);
  });

  test('corpo sem "permissoes" -> 400', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 5 }] }) };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id/permissoes')(buildReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  test('sucesso: grava permissão individual, apaga quando usar_padrao, e audita o antes/depois', async () => {
    const queries = [];
    const pool = {
      query: jest.fn((sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('WHERE id = $1 AND (empresa_id')) return Promise.resolve({ rowCount: 1, rows: [{ id: 5 }] });
        if (sql.includes('FROM permissoes_usuario WHERE usuario_id')) {
          return Promise.resolve({ rowCount: 1, rows: [{ modulo: 'clientes', pode_ver: true, pode_criar: false, pode_editar: false, pode_deletar: false }] });
        }
        return Promise.resolve({ rowCount: 1 });
      }),
    };
    const registrarAuditoria = jest.fn();
    const router = buildRouter(pool, { registrarAuditoria });
    const res = mockRes();
    await getHandler(router, 'put', '/usuarios/:id/permissoes')(buildReq({
      body: {
        permissoes: {
          produtos: { pode_ver: true, pode_criar: true, pode_editar: false, pode_deletar: false },
          clientes: { usar_padrao: true },
        },
      },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(queries.some((q) => q.sql.includes('ON CONFLICT (usuario_id, empresa_id, modulo)'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('DELETE FROM permissoes_usuario'))).toBe(true);
    const chamada = registrarAuditoria.mock.calls[0][0];
    expect(chamada.acao).toBe('alteracao_permissoes');
    expect(chamada.dados_anteriores.clientes.pode_ver).toBe(true);
    expect(chamada.dados_novos.produtos.pode_criar).toBe(true);
  });
});

describe('GET /usuarios/:id/permissoes', () => {
  test('mescla permissão individual sobre o padrão do tipo e marca override', async () => {
    const pool = {
      query: jest.fn((sql) => {
        if (sql.includes('SELECT tipo FROM usuarios')) return Promise.resolve({ rowCount: 1, rows: [{ tipo: 'funcionario' }] });
        if (sql.includes('FROM permissoes_usuario')) {
          return Promise.resolve({ rows: [{ modulo: 'produtos', pode_ver: true, pode_criar: true, pode_editar: true, pode_deletar: false }] });
        }
        if (sql.includes('FROM permissoes_padrao')) {
          return Promise.resolve({ rows: [{ modulo: 'produtos', pode_ver: true, pode_criar: false, pode_editar: false, pode_deletar: false }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'get', '/usuarios/:id/permissoes')({ user: ADMIN, params: { id: '5' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.permissoes.produtos.pode_criar).toBe(true); // override individual
    expect(res.jsonBody.permissoes.produtos.override).toBe(true);
    expect(res.jsonBody.permissoes.clientes.pode_ver).toBe(false); // sem padrão nem individual
    expect(res.jsonBody.permissoes.clientes.override).toBe(false);
  });
});

describe('Lixeira — whitelist de tabela (defesa contra injeção via identificador)', () => {
  test('GET /lixeira: sem permissão de gestão -> 403', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'get', '/lixeira')({ user: FUNCIONARIO }, res);
    expect(res.statusCode).toBe(403);
  });

  test('PUT /lixeira/recuperar/:tabela/:id: tabela fora da whitelist -> 400, nunca chega a montar a query', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'put', '/lixeira/recuperar/:tabela/:id')(
      { user: ADMIN, params: { tabela: 'usuarios', id: '1' } }, res
    );
    expect(res.statusCode).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('DELETE /lixeira/excluir/:tabela/:id: tabela com tentativa de injeção -> 400', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'delete', '/lixeira/excluir/:tabela/:id')(
      { user: ADMIN, params: { tabela: 'produtos; DROP TABLE usuarios;--', id: '1' } }, res
    );
    expect(res.statusCode).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('DELETE /lixeira/excluir: gerente (não-admin, não-saas-owner) é bloqueado mesmo com permissão de módulo', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'delete', '/lixeira/excluir/:tabela/:id')(
      { user: GERENTE, params: { tabela: 'produtos', id: '1' } }, res
    );
    expect(res.statusCode).toBe(403);
  });

  test('PUT /lixeira/recuperar: sucesso restaura o registro e audita "recuperar"', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 1, nome: 'Produto X' }] }) };
    const registrarAuditoria = jest.fn();
    const router = buildRouter(pool, { registrarAuditoria });
    const res = mockRes();
    await getHandler(router, 'put', '/lixeira/recuperar/:tabela/:id')(
      { user: ADMIN, params: { tabela: 'produtos', id: '1' } }, res
    );
    expect(res.statusCode).toBe(200);
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({ acao: 'recuperar', modulo: 'produtos' }));
  });
});

describe('GET /permissoes/minhas', () => {
  test('admin recebe isAdmin=true sem consultar permissões individuais', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'get', '/permissoes/minhas')({ user: ADMIN }, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.isAdmin).toBe(true);
    expect(res.jsonBody.permissoes).toBeNull();
  });

  test('funcionário recebe isAdmin=false com permissões resolvidas', async () => {
    const pool = { query: jest.fn() };
    const router = buildRouter(pool);
    const res = mockRes();
    await getHandler(router, 'get', '/permissoes/minhas')({ user: { ...FUNCIONARIO, empresa_id: 1 } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.isAdmin).toBe(false);
    expect(res.jsonBody.permissoes).toEqual({ produtos: { pode_ver: true } });
  });
});
