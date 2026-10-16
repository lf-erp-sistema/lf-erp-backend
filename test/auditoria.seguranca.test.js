'use strict';
process.env.JWT_SECRET = 'somente-testes-auditoria-seguranca-2026';
const { createValidatedAuth } = require('../middleware/validatedAuth');
const { EventEmitter } = require('events');

function res() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }
const user = { id: 1, tipo: 'admin', empresa_id: 7, empresa: 'Loja', senha_v: 0 };
function fixture(row = { ...user }) {
  const pool = { query: jest.fn().mockResolvedValue({ rows: row ? [row] : [] }) };
  const plano = jest.fn().mockResolvedValue({ assinatura_status: 'ativo', bloqueada: false });
  const auth = createValidatedAuth({ authJwt: (req, response, next) => next(), pool,
    obterPlanoEmpresa: plano, hoje: () => '2026-10-16' });
  const req = { user: { ...user }, empresa_id: 7, empresa_nome: 'Loja', authToken: 'token-ficticio' };
  return { auth, req, pool, plano };
}
test.each([
  ['usuário excluído', null], ['token revogado em outra instância', { ...user, revogado: true }],
  ['admin rebaixado', { ...user, tipo: 'funcionario' }],
  ['senha alterada', { ...user, senha_alterada_em: '2026-10-16T00:00:00Z' }],
  ['empresa alterada', { ...user, empresa_id: 8 }],
  ['owner removido', { ...user, is_saas_owner: true }],
])('nega sessão com %s antes do handler protegido', async (_, row) => {
  const f = fixture(row), response = res(), next = jest.fn();
  await f.auth(f.req, response, next);
  expect(response.statusCode).toBe(403); expect(next).not.toHaveBeenCalled();
});
test('autoriza usuário atual e verifica blacklist compartilhada em cada requisição', async () => {
  const f = fixture(), next = jest.fn();
  await f.auth(f.req, res(), next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(f.pool.query.mock.calls[0][0]).toContain('jwt_blacklist');
  f.pool.query.mockResolvedValue({ rows: [{ ...user, revogado: true }] });
  const response = res(); await f.auth(f.req, response, next);
  expect(response.statusCode).toBe(403); expect(next).toHaveBeenCalledTimes(1);
});
test('erro de banco retorna 503 sem liberar acesso', async () => {
  const f = fixture(), response = res(), next = jest.fn();
  f.pool.query.mockRejectedValue(new Error('offline'));
  await f.auth(f.req, response, next);
  expect(response.statusCode).toBe(503); expect(next).not.toHaveBeenCalled();
});
test.each(['cancelado', 'inativo'])('nega assinatura %s', async assinatura_status => {
  const f = fixture(), response = res(), next = jest.fn();
  f.plano.mockResolvedValue({ assinatura_status });
  await f.auth(f.req, response, next);
  expect(response.statusCode).toBe(403); expect(next).not.toHaveBeenCalled();
});
function last(router, method, route) { return router.stack.find(l => l.route?.path === route && l.route.methods[method]).route.stack.at(-1).handle; }
test('gerente não cria administrador nem delega permissões', async () => {
  const pool = { query: jest.fn(), connect: jest.fn() };
  const router = require('../routes/usuarios.routes')({ auth() {}, writeRateLimiter() {}, pool,
    requirePermissao: () => () => {}, validarForcaSenha: () => ({ valido: true }) });
  for (const [method, route, body] of [
    ['post', '/usuarios', { nome: 'Teste', usuario: 'teste', senha: 'Senha123', tipo: 'admin' }],
    ['put', '/usuarios/:id/permissoes', { permissoes: {} }],
  ]) {
    const response = res();
    await last(router, method, route)({ params: { id: 1 }, user: { tipo: 'gerente' }, body }, response);
    expect(response.statusCode).toBe(403);
  }
  expect(pool.query).not.toHaveBeenCalled(); expect(pool.connect).not.toHaveBeenCalled();
});
test('reset do portal invalida token anterior e permite novo token na versão atual', async () => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [{ portal_ativo: true, portal_senha_alterada_em: '2026-10-16T12:00:00Z' }], rowCount: 1 }) };
  const router = require('../routes/portal.routes')({ auth() {}, writeRateLimiter() {}, pool });
  const middleware = router.stack.find(l => l.route?.path === '/resumo').route.stack[0].handle;
  const jwt = require('jsonwebtoken');
  for (const senha_v of [0, new Date('2026-10-16T12:00:00Z').getTime()]) {
    const token = jwt.sign({ id: 9, tipo: 'cliente', empresa_id: 7, senha_v }, process.env.JWT_SECRET + '_portal_v1', { expiresIn: '12h' });
    const response = res(), next = jest.fn();
    await middleware({ headers: { authorization: 'Bearer ' + token } }, response, next);
    expect(next.mock.calls.length).toBe(senha_v ? 1 : 0);
    expect(response.statusCode).toBe(senha_v ? 200 : 403);
  }
  expect(pool.query.mock.calls[0][0]).toContain('empresa_id = $2');
});

test.each([false, true])('delegação e revogação de sessões são transacionais (falha=%s)', async fail => {
  const client = { release: jest.fn(), query: jest.fn(async sql => {
    if (fail && sql.includes('INSERT INTO permissoes_usuario')) throw new Error('falha');
    return { rows: [], rowCount: 1 };
  }) };
  const pool = { connect: async () => client, query: jest.fn().mockResolvedValue({ rows: [{ id: 2 }], rowCount: 1 }) };
  const router = require('../routes/usuarios.routes')({ auth() {}, writeRateLimiter() {}, pool,
    requirePermissao: () => () => {}, validarAcessoEmpresa: async () => ({ id: 7, nome: 'Loja' }), registrarAuditoria: async () => {} });
  const response = res();
  await last(router, 'put', '/usuarios/:id/permissoes')({ params: { id: 2 }, user: { id: 1, tipo: 'admin' },
    body: { permissoes: { clientes: { pode_ver: true } } } }, response);
  expect(response.statusCode).toBe(fail ? 500 : 200);
  const sqls = client.query.mock.calls.map(([sql]) => sql);
  expect(sqls).toContain(fail ? 'ROLLBACK' : 'COMMIT');
  if (!fail) expect(sqls.some(sql => sql.includes('senha_alterada_em = NOW()'))).toBe(true);
  else expect(sqls).not.toContain('COMMIT');
  expect(client.release).toHaveBeenCalledTimes(1);
});
test('SSE compartilha consulta por empresa e fecha conexão revogada', async () => {
  jest.useFakeTimers();
  try {
    const auth = () => {}; auth.validarSessao = jest.fn().mockResolvedValue(null);
    const pool = { query: jest.fn(async sql => ({ rows: sql.includes('COUNT(') ? [{ total: 0 }] : [], rowCount: 0 })) };
    const router = require('../routes/notificacoes.routes')({ auth, pool, validarAcessoEmpresa: async () => ({ id: 7 }), podeGerenciarFinanceiro: () => true });
    const handler = last(router, 'get', '/sse-notificacoes');
    function stream() {
      const response = new EventEmitter();
      Object.assign(response, { setHeader() {}, flushHeaders() {}, write: jest.fn(),
        end: jest.fn(() => { response.writableEnded = true; response.emit('close'); }) });
      return response;
    }
    const a = stream(), b = stream();
    const req = () => ({ user: { exp: Math.floor(Date.now() / 1000) + 3600 }, authToken: 'token' });
    await handler(req(), a); await handler(req(), b);
    expect(pool.query).toHaveBeenCalledTimes(4);
    auth.validarSessao.mockResolvedValue('revogado');
    await jest.advanceTimersByTimeAsync(25_000);
    expect(a.end).toHaveBeenCalled(); expect(b.end).toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(4);
  } finally { jest.useRealTimers(); }
});
