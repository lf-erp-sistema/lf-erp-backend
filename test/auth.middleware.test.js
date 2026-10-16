'use strict';

// createAuthHelpers(pool).obterSenhaAlteradaEm mantém um cache em memória de
// módulo (TTL 30s) — igual ao padrão de obterConfigEmpresa (financeiroOps.js)
// e obterPlanoEmpresa (plano.js). Cada teste pega uma instância nova do
// módulo via jest.resetModules() pra não vazar estado entre testes.
function freshCreateAuthHelpers() {
  jest.resetModules();
  const { createAuthHelpers } = require('../middleware/auth');
  return createAuthHelpers;
}

describe('createAuthHelpers(pool).obterSenhaAlteradaEm — A2-SEC-001', () => {
  test('usuario sem senha_alterada_em (NULL) retorna 0', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ senha_alterada_em: null }] }) };
    const { obterSenhaAlteradaEm } = freshCreateAuthHelpers()(pool);
    expect(await obterSenhaAlteradaEm(1)).toBe(0);
  });

  test('retorna o timestamp (epoch ms) de senha_alterada_em quando presente', async () => {
    const dataTroca = '2026-05-01T12:00:00.000Z';
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ senha_alterada_em: dataTroca }] }) };
    const { obterSenhaAlteradaEm } = freshCreateAuthHelpers()(pool);
    expect(await obterSenhaAlteradaEm(1)).toBe(new Date(dataTroca).getTime());
  });

  test('segunda chamada para o mesmo usuário dentro do TTL não consulta o banco de novo', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ senha_alterada_em: null }] }) };
    const { obterSenhaAlteradaEm } = freshCreateAuthHelpers()(pool);
    await obterSenhaAlteradaEm(7);
    await obterSenhaAlteradaEm(7);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('usuários diferentes não compartilham a mesma entrada de cache', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ senha_alterada_em: null }] }) };
    const { obterSenhaAlteradaEm } = freshCreateAuthHelpers()(pool);
    await obterSenhaAlteradaEm(1);
    await obterSenhaAlteradaEm(2);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
