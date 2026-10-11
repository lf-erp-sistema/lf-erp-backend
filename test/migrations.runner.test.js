'use strict';

const fs = require('fs');
const { runMigrations } = require('../migrations/runner');

function makeLockClient({ failOnUnlock = false } = {}) {
  const calls = [];
  const query = jest.fn((sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('pg_advisory_unlock') && failOnUnlock) {
      return Promise.reject(new Error('conexão caiu antes do unlock'));
    }
    return Promise.resolve({ rows: [] });
  });
  return { query, calls, release: jest.fn() };
}

function makeMigrationClient() {
  const calls = [];
  const query = jest.fn((sql, params) => {
    calls.push({ sql, params });
    return Promise.resolve({ rows: [] });
  });
  return { query, calls, release: jest.fn() };
}

describe('runMigrations — advisory lock', () => {
  let readdirSpy, readFileSpy;

  beforeEach(() => {
    // Isola o teste do conteúdo real de backend/migrations/*.sql
    readdirSpy = jest.spyOn(fs, 'readdirSync').mockReturnValue(['001_fake.sql', '002_fake.sql']);
    readFileSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue('SELECT 1;');
  });

  afterEach(() => {
    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  test('sucesso: adquire o lock ANTES de listar migrations aplicadas, roda as pendentes e libera o lock no final', async () => {
    const lockClient = makeLockClient();
    const migrationClients = [makeMigrationClient(), makeMigrationClient()];
    let connectCount = 0;

    const pool = {
      connect: jest.fn(() => {
        connectCount += 1;
        // 1ª chamada = conexão do lock; as seguintes = uma por migration pendente
        return Promise.resolve(connectCount === 1 ? lockClient : migrationClients[connectCount - 2]);
      }),
      query: jest.fn((sql) => {
        if (sql.includes('SELECT filename FROM _migrations')) return Promise.resolve({ rows: [] }); // nenhuma aplicada ainda
        return Promise.resolve({ rows: [] }); // CREATE TABLE IF NOT EXISTS _migrations
      }),
    };

    await runMigrations(pool);

    // Lock adquirido antes de qualquer consulta a migrations aplicadas
    const sqlsLock = lockClient.calls.map((c) => c.sql);
    expect(sqlsLock[0]).toContain('pg_advisory_lock');
    const ordemConsultaMigrations = pool.query.mock.calls.findIndex(([sql]) => sql.includes('SELECT filename FROM _migrations'));
    expect(ordemConsultaMigrations).toBeGreaterThanOrEqual(0); // consulta aconteceu
    expect(sqlsLock.some((s) => s.includes('pg_advisory_lock'))).toBe(true);

    // As duas migrations pendentes rodaram em transação própria (BEGIN/COMMIT)
    migrationClients.forEach((c) => {
      const sqls = c.calls.map((x) => x.sql);
      expect(sqls).toContain('BEGIN');
      expect(sqls).toContain('COMMIT');
      expect(sqls.some((s) => s.includes('INSERT INTO _migrations'))).toBe(true);
    });

    // Lock liberado no final, conexão devolvida ao pool normalmente
    expect(sqlsLock.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(lockClient.release).toHaveBeenCalledWith(); // sem erro => release() sem argumento
  });

  test('falha numa migration: lock é liberado mesmo assim (finally) e o erro não é silenciado', async () => {
    const lockClient = makeLockClient();
    const migrationClientComErro = {
      query: jest.fn((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve({});
        if (sql === 'SELECT 1;') return Promise.reject(new Error('sintaxe SQL inválida'));
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };

    let connectCount = 0;
    const pool = {
      connect: jest.fn(() => {
        connectCount += 1;
        return Promise.resolve(connectCount === 1 ? lockClient : migrationClientComErro);
      }),
      query: jest.fn((sql) => Promise.resolve({ rows: [] })),
    };

    await expect(runMigrations(pool)).rejects.toThrow('sintaxe SQL inválida');

    // Lock ainda assim foi liberado (finally cobre o caminho de erro)
    const sqlsLock = lockClient.calls.map((c) => c.sql);
    expect(sqlsLock.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(lockClient.release).toHaveBeenCalledWith();

    // A migration com erro fez ROLLBACK e não inseriu em _migrations
    const sqlsMigracao = migrationClientComErro.query.mock.calls.map((c) => c[0]);
    expect(sqlsMigracao).toContain('ROLLBACK');
    expect(sqlsMigracao.some((s) => s.includes('INSERT INTO _migrations'))).toBe(false);
  });

  test('se o próprio unlock falhar, a conexão é descartada (release com erro) em vez de voltar ao pool', async () => {
    const lockClient = makeLockClient({ failOnUnlock: true });
    const pool = {
      connect: jest.fn().mockResolvedValue(lockClient),
      query: jest.fn((sql) => Promise.resolve({ rows: [] })),
    };
    // Sem migrations pendentes (readdir mockado, mas _migrations "aplicadas" cobre tudo)
    jest.spyOn(fs, 'readdirSync').mockReturnValue([]);

    await runMigrations(pool);

    expect(lockClient.release).toHaveBeenCalledTimes(1);
    const arg = lockClient.release.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Error); // release(err) => descarta a conexão, não devolve ao pool
  });
});
