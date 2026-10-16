'use strict';
jest.mock('../utils/permissoes', () => ({ requirePermissao: () => (req, res, next) => next() }));
const express = require('express');
const request = require('supertest');
const { createManutencaoDiaria } = require('../utils/manutencaoDiaria');
const { createSharedRateLimiter } = require('../utils/sharedRateLimiter');
function daily({ data = null, locked = true, fail = false } = {}) {
  const client = { release: jest.fn(), query: jest.fn(async sql => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    if (sql.includes('SELECT ultima_data')) return { rows: data ? [{ ultima_data: data }] : [] };
    if (sql.includes('SELECT id, nome')) return { rows: [{ id: 7, nome: 'Loja' }] };
    return { rows: [] };
  }) };
  const receber = jest.fn(async () => { if (fail) throw new Error('falha'); }), pagar = jest.fn();
  const executar = createManutencaoDiaria({ pool: { connect: async () => client }, hoje: () => '2026-10-16',
    atualizarReceber: receber, atualizarPagar: pagar });
  return { executar, client, receber, pagar };
}
test('manutenção recupera data perdida e registra conclusão somente após sucesso', async () => {
  const f = daily({ data: '2026-10-15' });
  expect(await f.executar()).toBe(true);
  expect(f.receber).toHaveBeenCalledWith('Loja', 7); expect(f.pagar).toHaveBeenCalledWith('Loja', 7);
  expect(f.client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO manutencao_execucoes'))).toBe(true);
  expect(f.client.release).toHaveBeenCalledTimes(1);
});
test.each([{ data: '2026-10-16' }, { locked: false }])('manutenção não duplica execução concluída ou concorrente (%j)', async options => {
  const f = daily(options); expect(await f.executar()).toBe(false);
  expect(f.receber).not.toHaveBeenCalled(); expect(f.pagar).not.toHaveBeenCalled();
  expect(f.client.release).toHaveBeenCalledTimes(1);
});
test('manutenção com falha libera lock sem registrar conclusão, permitindo retry', async () => {
  const f = daily({ fail: true }); await expect(f.executar()).rejects.toThrow('falha');
  expect(f.client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO manutencao_execucoes'))).toBe(false);
  expect(f.client.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_unlock'))).toBe(true);
  expect(f.client.release).toHaveBeenCalledTimes(1);
});
test('rate limiter expurga em lotes e resume chave arbitrariamente longa por hash', async () => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [{ request_count: 1, window_started_at: new Date() }] }) };
  const limiter = createSharedRateLimiter(pool);
  await limiter.cleanup(); expect(pool.query.mock.calls[0][0]).toContain('LIMIT 1000');
  expect(pool.query.mock.calls[0][0]).toContain("INTERVAL '48 hours'");
  await limiter.consume('usuario:'.repeat(1000), 60_000, 10);
  expect(pool.query.mock.calls[1][1][0]).toMatch(/^sha256:[a-f0-9]{64}$/);
});
test('importação aceita JSON de mais de 1MB só após autenticação; outras rotas mantêm limite', async () => {
  const { jsonPadrao, jsonUpload } = require('../middleware/jsonBody');
  const app = express(); app.use(jsonPadrao);
  const auth = jest.fn((req, res, next) => req.headers.authorization ? next() : res.sendStatus(403));
  app.post('/conciliacao/importar', auth, jsonUpload, (req, res) => res.json({ length: req.body.conteudo.length }));
  app.post('/normal', (req, res) => res.sendStatus(200));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ erro: err.type }));
  const payload = { conteudo: 'a'.repeat(1100000) };
  expect((await request(app).post('/conciliacao/importar').send(payload)).status).toBe(403);
  expect((await request(app).post('/conciliacao/importar').set('Authorization', 'teste').send(payload)).status).toBe(200);
  expect((await request(app).post('/normal').send(payload)).status).toBe(413);
});
test('BI executa tendência apenas uma vez e não converte falha em zeros', async () => {
  let fail = false;
  const pool = { query: jest.fn(async () => { if (fail) throw new Error('offline'); return { rows: [{ total: 0 }] }; }) };
  const app = express();
  app.use(require('../routes/bi.routes')({ auth: (req, res, next) => next(), pool,
    requirePermissao: () => (req, res, next) => next(), validarAcessoEmpresa: async () => ({ id: 7, nome: 'Loja' }) }));
  expect((await request(app).get('/resumo-executivo')).status).toBe(200);
  expect(pool.query.mock.calls.filter(([sql]) => sql.includes("'12 months'::interval"))).toHaveLength(1);
  expect(pool.query).toHaveBeenCalledTimes(9);
  fail = true; expect((await request(app).get('/resumo-executivo')).status).toBe(500);
});
