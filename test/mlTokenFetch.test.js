'use strict';

// Impede carregamento real de pixCrypto (aviso PIX_ENCRYPTION_KEY) e simplifica safeDecrypt
jest.mock('../utils/pixCrypto', () => ({
  encryptField: v => v,
  decryptField: v => v
}));

const crypto  = require('crypto');
const express = require('express');
const request = require('supertest');

const STATE_SECRET = 'test-ml-state-secret-xk9';
process.env.MARKETPLACE_STATE_SECRET = STATE_SECRET;
process.env.MARKETPLACE_REDIRECT_URI = 'https://test.example.com/marketplace/oauth/callback';

// Config fictícia que pool.query retorna para getConfig (plaintext — safeDecrypt é no-op no mock)
const ML_CFG = {
  empresa_id: 99, plataforma: 'mercadolivre',
  app_id: 'app_test', client_secret: 'secret_test',
  access_token: null, refresh_token: null,
  token_expires_at: null, seller_id: null, ativo: true
};

function buildState(empresa_id = 99) {
  const p = JSON.stringify({ empresa_id, plataforma: 'mercadolivre', ts: Date.now() });
  const s = crypto.createHmac('sha256', STATE_SECRET).update(p).digest('hex');
  return Buffer.from(JSON.stringify({ p, s })).toString('base64url');
}

// Constrói app com pool mockado para o fluxo do callback OAuth
// (rate limiter do callback + getConfig + UPDATE após sucesso). O rate
// limiter (achado F2-SEC-004) consulta rate_limit_buckets antes de qualquer
// query de negócio em TODA requisição — precisa responder a essa query
// específica por padrão de SQL, não por ordem de chamada.
function buildCallbackApp(queryImpl) {
  let chamadaNegocio = 0;
  const pool = {
    query: queryImpl || jest.fn((sql) => {
      if (typeof sql === 'string' && sql.includes('rate_limit_buckets')) {
        return Promise.resolve({ rows: [{ request_count: 1, window_started_at: new Date() }] });
      }
      chamadaNegocio += 1;
      if (chamadaNegocio === 1) return Promise.resolve({ rows: [ML_CFG], rowCount: 1 }); // getConfig
      return Promise.resolve({ rows: [], rowCount: 1 }); // UPDATE após sucesso
    })
  };
  const app = express();
  app.use(express.json());
  const router = require('../routes/marketplace.routes.js')({
    auth: (_req, _res, next) => next(),
    writeRateLimiter: (_req, _res, next) => next(),
    pool,
    validarAcessoEmpresa: jest.fn(),
    normalizarDecimal: v => v, normalizarInt: v => Number(v), normalizarDataISO: v => v,
    hoje: () => '2026-09-06',
    registrarMovimentacaoEstoque: jest.fn(),
    criarParcelasContasReceber: jest.fn()
  });
  app.use('/marketplace', router);
  return { app, pool };
}

afterEach(() => {
  delete global.fetch;
  jest.useRealTimers();
});

// ── OAuth callback — authorization_code (mlTokenFetch direto) ─────────────────

describe('mlTokenFetch — OAuth callback (authorization_code)', () => {
  test('timeout: AbortError resulta em página de erro genérica sem expor secrets', async () => {
    global.fetch = jest.fn((_url, opts) => {
      // Verifica que AbortController está configurado
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      return Promise.reject(e);
    });
    const { app } = buildCallbackApp();
    const res = await request(app)
      .get('/marketplace/oauth/callback')
      .query({ code: 'test-code', state: buildState() });

    expect(res.text).toMatch(/erro/i);
    expect(res.text).not.toContain('secret_test');
    expect(res.text).not.toContain('app_test');
  });

  test('erro de rede: ECONNREFUSED resulta em página de erro sem expor secrets', async () => {
    global.fetch = jest.fn(() =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:443'))
    );
    const { app } = buildCallbackApp();
    const res = await request(app)
      .get('/marketplace/oauth/callback')
      .query({ code: 'test-code', state: buildState() });

    expect(res.text).toMatch(/erro/i);
    expect(res.text).not.toContain('secret_test');
  });

  test('resposta não OK: ML retorna 401 sem access_token → mensagem de erro na autenticação', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: false, status: 401,
      json: () => Promise.resolve({ error: 'invalid_grant', message: 'Access denied' })
    }));
    const { app } = buildCallbackApp();
    const res = await request(app)
      .get('/marketplace/oauth/callback')
      .query({ code: 'test-code', state: buildState() });

    // sem access_token → rota exibe "Erro na autenticação"
    expect(res.text).toMatch(/erro na autenti/i);
    expect(res.text).not.toContain('secret_test');
    // body com error/message do ML pode aparecer escapado — não deve conter tokens reais
    expect(res.text).not.toContain('secret_test');
  });

  test('sucesso: access_token retornado resulta em "Autorização concluída"', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        access_token: 'ml_at_test_123',
        refresh_token: 'ml_rt_test_456',
        user_id: 987654321
      })
    }));
    const { app } = buildCallbackApp();
    const res = await request(app)
      .get('/marketplace/oauth/callback')
      .query({ code: 'test-code', state: buildState() });

    expect(res.text).toContain('Autorização concluída');
    // tokens não devem vazar para o HTML
    expect(res.text).not.toContain('ml_at_test_123');
    expect(res.text).not.toContain('ml_rt_test_456');
  });
});

// ── refreshMlToken — via sync-estoque (token expirado aciona refresh) ─────────

describe('mlTokenFetch — refreshMlToken (via sync-estoque com token expirado)', () => {
  test('timeout no refresh resulta em 400 "Token ML expirado" sem expor refresh_token em logs', async () => {
    const expiredTs = new Date(Date.now() - 10000).toISOString();

    global.fetch = jest.fn((_url, opts) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      return Promise.reject(e);
    });

    const pool = { query: jest.fn()
      .mockResolvedValueOnce({   // vinculo
        rows: [{ id: 1, listing_id: 'ML-001', empresa_id: 99, produto_id: 1, plataforma: 'mercadolivre' }],
        rowCount: 1
      })
      .mockResolvedValueOnce({   // prodResult
        rows: [{ estoque: 5 }], rowCount: 1
      })
      .mockResolvedValueOnce({   // getConfig (token expirado, com refresh_token)
        rows: [{ ...ML_CFG, access_token: 'old_tok', refresh_token: 'rt_secret', token_expires_at: expiredTs }],
        rowCount: 1
      })
    };

    const app = express();
    app.use(express.json());
    const router = require('../routes/marketplace.routes.js')({
      auth: (req, _res, next) => { req.user = { tipo: 'admin', id: 1, empresa_id: 99 }; next(); },
      writeRateLimiter: (_req, _res, next) => next(),
      pool,
      validarAcessoEmpresa: jest.fn().mockResolvedValue({ id: 99, nome: 'EmpresaTeste' }),
      normalizarDecimal: v => v, normalizarInt: v => Number(v), normalizarDataISO: v => v,
      hoje: () => '2026-09-06',
      registrarMovimentacaoEstoque: jest.fn(),
      criarParcelasContasReceber: jest.fn()
    });
    app.use('/marketplace', router);

    const res = await request(app)
      .post('/marketplace/sync-estoque')
      .send({ produto_id: 1, plataforma: 'mercadolivre' });

    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/token ml expirado/i);
    // refresh_token e client_secret não devem ter vazado
    expect(JSON.stringify(res.body)).not.toContain('rt_secret');
    expect(JSON.stringify(res.body)).not.toContain('secret_test');
  });
});
