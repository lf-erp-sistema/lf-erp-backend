'use strict';

const express  = require('express');
const request  = require('supertest');

const apiPublicaRoutes = require('../routes/api-publica.routes');

// ── Fixtures ───────────────────────────────────────────────────────────────

const VALID_RAW_KEY = 'test-key-abc123';
const EMPRESA_ID    = 42;
const EMPRESA_NOME  = 'Empresa Teste';
const IDEM_KEY      = 'pedido-001';

const PRODUTO_OK = { id: 1, nome: 'Produto A', preco: 10.00, custo: 5.00, estoque: 100, ativo: true, tem_grade: false, e_kit: false };

// ── Mock factory ───────────────────────────────────────────────────────────

function buildPool({ overrides = {} } = {}) {
  // Controla qual chamada ao padrão "FROM vendas WHERE idempotency_key" está sendo feita.
  // Primeira chamada = early check (fora de transação).
  // Segunda chamada  = recuperação após 23505 (no catch).
  // Se overrides.existingVenda for array, usa índice; se for objeto, devolve sempre o mesmo.
  let idemCallIdx = 0;

  const query = jest.fn(async (sql) => {
    // Shared public API rate limiter
    if (sql.includes('INSERT INTO rate_limit_buckets')) {
      return { rows: [{ request_count: 1, window_started_at: new Date().toISOString() }], rowCount: 1 };
    }
    // authApiKey lookup
    if (sql.includes('empresa_api_keys') && sql.includes('SELECT')) {
      return overrides.apiKey ?? { rows: [{ empresa_id: EMPRESA_ID, empresa_nome: EMPRESA_NOME }] };
    }
    // ultimo_uso (fire-and-forget)
    if (sql.includes('ultimo_uso')) return { rows: [] };
    // Early check + recovery SELECT — mesmo padrão SQL, distinguido pelo índice de chamada
    if (sql.includes('FROM vendas') && sql.includes('idempotency_key')) {
      const result = overrides.existingVenda;
      if (Array.isArray(result)) {
        return result[idemCallIdx++] ?? { rows: [], rowCount: 0 };
      }
      return result ?? { rows: [], rowCount: 0 };
    }
    // cliente validation
    if (sql.includes('FROM clientes')) {
      return overrides.cliente ?? { rowCount: 1, rows: [{ nome: 'João' }] };
    }
    // produtos pre-fetch
    if (sql.includes('FROM produtos') && sql.includes('ANY(')) {
      return overrides.produtos ?? { rows: [PRODUTO_OK], rowCount: 1 };
    }
    // INSERT into venda_itens (before vendas to avoid substring ambiguity)
    if (sql.includes('INSERT INTO venda_itens')) return { rows: [], rowCount: 1 };
    // INSERT into vendas RETURNING *
    if (sql.includes('INSERT INTO vendas')) {
      if (overrides.insertVendasError) throw overrides.insertVendasError;
      return overrides.insertVenda ?? { rows: [{ id: 99, total: 20.00, cliente_nome: 'João', data: '2026-09-06' }], rowCount: 1 };
    }
    // UPDATE produtos estoque
    if (sql.includes('UPDATE produtos')) {
      return overrides.updateEstoque ?? { rows: [], rowCount: 1 };
    }
    // BEGIN / COMMIT / ROLLBACK
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/.test(sql.trim())) return { rows: [] };

    return { rows: [], rowCount: 0 };
  });

  const client = { query, release: jest.fn() };
  return { query, connect: jest.fn().mockResolvedValue(client), _client: client };
}

function buildApp({ poolOverrides = {}, registrarEstoqueImpl } = {}) {
  const pool = buildPool({ overrides: poolOverrides });
  const normalizarDecimal = (v) => Number(parseFloat(String(v || 0)).toFixed(2));
  const normalizarInt     = (v) => parseInt(v, 10) || 0;
  const hoje              = () => '2026-09-06';
  const registrarMovimentacaoEstoque = registrarEstoqueImpl ?? jest.fn().mockResolvedValue(undefined);

  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiPublicaRoutes({
    pool,
    writeRateLimiter: (_req, _res, next) => next(),
    normalizarDecimal,
    normalizarInt,
    hoje,
    registrarMovimentacaoEstoque
  }));

  return { app, pool, registrarMovimentacaoEstoque };
}

function vendaBody(overrides = {}) {
  return { itens: [{ produto_id: 1, quantidade: 2 }], pagamento: 'pix', ...overrides };
}

// Helper: encadeia X-Api-Key + Idempotency-Key numa request
function withAuth(req, key = IDEM_KEY) {
  return req.set('X-Api-Key', VALID_RAW_KEY).set('Idempotency-Key', key);
}

// ── Testes ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/vendas', () => {

  // ── Autenticação ────────────────────────────────────────────────────────

  test('T01 — sem X-Api-Key retorna 401', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/v1/vendas').send(vendaBody());
    expect(res.status).toBe(401);
    expect(res.body.sucesso).toBe(false);
  });

  test('T02 — API key inválida retorna 401', async () => {
    const { app } = buildApp({ poolOverrides: { apiKey: { rows: [] } } });
    const res = await request(app).post('/api/v1/vendas').set('X-Api-Key', 'invalid').send(vendaBody());
    expect(res.status).toBe(401);
  });

  // ── Idempotency-Key obrigatória e válida ────────────────────────────────

  test('T03 — ausência de Idempotency-Key retorna 400', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/v1/vendas').set('X-Api-Key', VALID_RAW_KEY).send(vendaBody());
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/Idempotency-Key/i);
  });

  test('T04 — chave maior que 128 caracteres retorna 400', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).post('/api/v1/vendas'), 'a'.repeat(129)).send(vendaBody());
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/128/);
  });

  test('T05 — chave com caracteres inválidos retorna 400', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).post('/api/v1/vendas'), 'chave com espaço').send(vendaBody());
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/inválidos/i);
  });

  // ── Validações de corpo ────────────────────────────────────────────────

  test('T06 — itens ausente retorna 400', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).post('/api/v1/vendas')).send({});
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/itens/i);
  });

  test('T07 — quantidade 0 retorna 400', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody({ itens: [{ produto_id: 1, quantidade: 0 }] }));
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/quantidade/i);
  });

  test('T08 — quantidade "1.5" retorna 400 (sem truncamento silencioso)', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody({ itens: [{ produto_id: 1, quantidade: '1.5' }] }));
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/quantidade/i);
  });

  test('T09 — quantidade "2abc" retorna 400 (sem truncamento silencioso)', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody({ itens: [{ produto_id: 1, quantidade: '2abc' }] }));
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/quantidade/i);
  });

  test('T10 — cliente_id "abc" retorna 400', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody({ cliente_id: 'abc' }));
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/cliente_id/i);
  });

  // ── Restrições de produtos ─────────────────────────────────────────────

  test('T11 — produto inativo retorna 400', async () => {
    const { app } = buildApp({ poolOverrides: { produtos: { rows: [{ ...PRODUTO_OK, ativo: false }], rowCount: 1 } } });
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody());
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/inativo/i);
  });

  test('T12 — produto com grade retorna 400', async () => {
    const { app } = buildApp({ poolOverrides: { produtos: { rows: [{ ...PRODUTO_OK, tem_grade: true }], rowCount: 1 } } });
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody());
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/grade/i);
  });

  test('T13 — kit retorna 400', async () => {
    const { app } = buildApp({ poolOverrides: { produtos: { rows: [{ ...PRODUTO_OK, e_kit: true }], rowCount: 1 } } });
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody());
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/kit/i);
  });

  // ── Validações de cliente e estoque ───────────────────────────────────

  test('T14 — cliente_id de outra empresa retorna 400', async () => {
    const { app } = buildApp({ poolOverrides: { cliente: { rowCount: 0, rows: [] } } });
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody({ cliente_id: 999 }));
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/cliente/i);
  });

  test('T15 — estoque insuficiente retorna 400', async () => {
    const { app } = buildApp({ poolOverrides: { produtos: { rows: [{ ...PRODUTO_OK, estoque: 1 }], rowCount: 1 } } });
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody({ itens: [{ produto_id: 1, quantidade: 5 }] }));
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/Estoque insuficiente/i);
  });

  // ── Total server-side ──────────────────────────────────────────────────

  test('T16 — total do body ignorado, retorna total calculado server-side', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody({ total: 9999 }));
    expect(res.status).toBe(201);
    expect(res.body.venda.total).toBe(20.00); // 2 × R$10 = R$20 (valor do mock row)
  });

  // ── Venda bem-sucedida ─────────────────────────────────────────────────

  test('T17 — venda criada com sucesso retorna 201 e aciona registrarMovimentacaoEstoque', async () => {
    const registrarMovimentacaoEstoque = jest.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ registrarEstoqueImpl: registrarMovimentacaoEstoque });

    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody());

    expect(res.status).toBe(201);
    expect(res.body.sucesso).toBe(true);
    expect(res.body.venda).toHaveProperty('id');
    expect(registrarMovimentacaoEstoque).toHaveBeenCalledTimes(1);
    expect(registrarMovimentacaoEstoque).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: 'saida_venda', produto_id: PRODUTO_OK.id, quantidade: 2, empresa_id: EMPRESA_ID })
    );
  });

  // ── Concorrência ───────────────────────────────────────────────────────

  test('T18 — race condition no UPDATE estoque retorna 400 (não 500)', async () => {
    const { app } = buildApp({ poolOverrides: { updateEstoque: { rows: [], rowCount: 0 } } });
    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody());
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/Estoque insuficiente/i);
  });

  test('T19 — conflito 23505 retorna 200 com deduplicated:true (nunca 500)', async () => {
    const uniqueError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'idx_vendas_idempotency_key',
      detail: 'Key (empresa_id, idempotency_key)=(42, pedido-001) already exists.'
    });
    const { app } = buildApp({
      poolOverrides: {
        // Early check: key ainda não existia (primeira requisição simultânea)
        // Recovery após 23505: encontra a venda criada pela requisição concorrente vencedora
        existingVenda: [
          { rows: [], rowCount: 0 },
          { rows: [{ id: 77, total: 20.00 }], rowCount: 1 }
        ],
        insertVendasError: uniqueError
      }
    });

    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody());

    expect(res.status).toBe(200);
    expect(res.body.sucesso).toBe(true);
    expect(res.body.deduplicated).toBe(true);
    expect(res.body.venda.id).toBe(77);
    expect(res.status).not.toBe(500);
  });

  test('T20 — conflito 23505 sem venda no SELECT de recuperação retorna 500', async () => {
    const uniqueError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'idx_vendas_idempotency_key',
      detail: 'Key (empresa_id, idempotency_key)=(42, pedido-001) already exists.'
    });
    const { app } = buildApp({
      poolOverrides: {
        existingVenda: [
          { rows: [], rowCount: 0 }, // early check: não encontrou
          { rows: [], rowCount: 0 }  // recovery: SELECT retornou vazio (caso extremamente raro)
        ],
        insertVendasError: uniqueError
      }
    });

    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody());
    expect(res.status).toBe(500);
  });

  // ── Verificação crítica de idempotência antecipada ─────────────────────

  test('T22 — falha no early check retorna 500, pool.connect não é chamado', async () => {
    const registrarMovimentacaoEstoque = jest.fn().mockResolvedValue(undefined);
    const { app, pool } = buildApp({ registrarEstoqueImpl: registrarMovimentacaoEstoque });

    pool.query
      .mockResolvedValueOnce({ rows: [{ empresa_id: EMPRESA_ID, empresa_nome: EMPRESA_NOME }] }) // authApiKey SELECT
      .mockResolvedValueOnce({ rows: [] })                                                        // ultimo_uso UPDATE (fire-and-forget)
      .mockResolvedValueOnce({ rows: [{ request_count: 1, window_started_at: new Date().toISOString() }] }) // rate limiter
      .mockRejectedValueOnce(new Error('connection error'));                                       // early check SELECT → rejeição real

    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody());

    expect(res.status).toBe(500);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(registrarMovimentacaoEstoque).not.toHaveBeenCalled();
  });

  test('T21 — early check: venda existente é devolvida sem consultar produto/estoque', async () => {
    // Produto está inativo/sem estoque — mas não importa: a venda já existe
    const registrarMovimentacaoEstoque = jest.fn().mockResolvedValue(undefined);
    const { app, pool } = buildApp({
      poolOverrides: {
        existingVenda: { rows: [{ id: 55, total: 15.00 }], rowCount: 1 }, // early check encontra imediatamente
        produtos: { rows: [{ ...PRODUTO_OK, ativo: false, estoque: 0 }], rowCount: 1 }
      },
      registrarEstoqueImpl: registrarMovimentacaoEstoque
    });

    const res = await withAuth(request(app).post('/api/v1/vendas')).send(vendaBody());

    expect(res.status).toBe(200);
    expect(res.body.sucesso).toBe(true);
    expect(res.body.deduplicated).toBe(true);
    expect(res.body.venda.id).toBe(55);
    expect(res.body.venda.total).toBe(15.00);

    // Nenhuma transação foi aberta (sem INSERT, UPDATE, movimentação ou webhook)
    expect(pool.connect).not.toHaveBeenCalled();
    expect(registrarMovimentacaoEstoque).not.toHaveBeenCalled();
  });

});
