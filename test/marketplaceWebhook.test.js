'use strict';

const express  = require('express');
const request  = require('supertest');

// Pool mínimo — testes não atingem o banco de negócio, mas o rate limiter
// compartilhado (createWebhookRateLimit, C-INT-002) consulta rate_limit_buckets
// em toda requisição; o mock precisa responder a essa query específica
// permitindo a passagem (request_count baixo) antes de qualquer outra asserção.
function buildPool() {
  const query = jest.fn((sql) => {
    if (typeof sql === 'string' && sql.includes('rate_limit_buckets')) {
      return Promise.resolve({ rows: [{ request_count: 1, window_started_at: new Date() }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return { query };
}

function buildApp() {
  const pool = buildPool();
  const app  = express();
  app.use(express.json());

  const router = require('../routes/marketplace.routes.js')({
    auth: (_req, _res, next) => next(),
    writeRateLimiter: (_req, _res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn(),
    normalizarDecimal: (v) => v,
    normalizarInt: (v) => v,
    normalizarDataISO: (v) => v,
    hoje: () => '2026-09-06',
    registrarMovimentacaoEstoque: jest.fn(),
    criarParcelasContasReceber: jest.fn()
  });
  app.use('/marketplace', router);
  return { app, pool };
}

describe('webhook Shopee — fail closed', () => {
  test('retorna 501 para payload Shopee (integração não habilitada)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/marketplace/webhook/shopee')
      .send({ topic: 'ORDER_STATUS_CHANGE', data: { order_sn: 'SH123' } });

    expect(res.status).toBe(501);
    expect(res.body.ok).toBe(false);
  });

  test('não processa pedido nem consulta banco de negócio para payload Shopee', async () => {
    const { app, pool } = buildApp();
    await request(app)
      .post('/marketplace/webhook/shopee')
      .send({ topic: 'ORDER_STATUS_CHANGE' });

    // Única query esperada é a do rate limiter compartilhado (toda requisição
    // passa por ele antes da rota); nenhuma query de negócio (ex. gravar pedido)
    const sqlsChamados = pool.query.mock.calls.map((c) => c[0]);
    expect(sqlsChamados.every((sql) => String(sql).includes('rate_limit_buckets'))).toBe(true);
  });

  test('plataforma inválida retorna 400', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/marketplace/webhook/desconhecida')
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('webhook Mercado Livre — autenticação mantida', () => {
  test('retorna 401 quando x-signature está ausente', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/marketplace/webhook/mercadolivre')
      .send({ user_id: '12345', topic: 'orders_v2', resource: '/orders/999' });

    expect(res.status).toBe(401);
  });
});
