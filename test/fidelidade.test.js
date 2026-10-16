'use strict';

const { acumularPontosFidelidade, estornarPontosFidelidade } = require('../utils/fidelidade');

// ── Mock de client transacional ────────────────────────────────────────────

function createTransactionalPool(clientResponses) {
  let callCount = 0;
  const client = {
    query: jest.fn().mockImplementation(() => {
      const res = clientResponses[callCount] || { rowCount: 0, rows: [] };
      callCount++;
      return Promise.resolve(res);
    }),
    release: jest.fn(),
  };
  return {
    query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
    connect: jest.fn().mockResolvedValue(client),
    _client: client,
  };
}

// ── acumularPontosFidelidade — guards ─────────────────────────────────────

describe('acumularPontosFidelidade — parâmetros obrigatórios', () => {
  test('clienteId ausente → return imediato sem queries', async () => {
    const pool = { query: jest.fn(), connect: jest.fn() };
    await acumularPontosFidelidade(pool, { empresaId: 1, clienteId: null, vendaId: 1, totalVenda: 100 });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('vendaId ausente → return imediato', async () => {
    const pool = { query: jest.fn(), connect: jest.fn() };
    await acumularPontosFidelidade(pool, { empresaId: 1, clienteId: 1, vendaId: null, totalVenda: 100 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('totalVenda falsy (0) → return imediato (0 é falsy)', async () => {
    const pool = { query: jest.fn(), connect: jest.fn() };
    await acumularPontosFidelidade(pool, { empresaId: 1, clienteId: 1, vendaId: 1, totalVenda: 0 });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('totalVenda null → return imediato', async () => {
    const pool = { query: jest.fn(), connect: jest.fn() };
    await acumularPontosFidelidade(pool, { empresaId: 1, clienteId: 1, vendaId: 1, totalVenda: null });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

// ── acumularPontosFidelidade — sem config de fidelidade ───────────────────

describe('acumularPontosFidelidade — sem fidelidade configurada', () => {
  test('empresa sem config ativa → não abre transação', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      connect: jest.fn(),
    };
    await acumularPontosFidelidade(pool, { empresaId: 1, clienteId: 1, vendaId: 1, totalVenda: 100 });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

// ── acumularPontosFidelidade — cálculo de pontos ─────────────────────────

describe('acumularPontosFidelidade — cálculo de pontos', () => {
  test('pontos = Math.floor(totalVenda × pontos_por_real)', async () => {
    const cfg = { pontos_por_real: 1, validade_dias: 0 };

    const pool = createTransactionalPool([
      // BEGIN
      { rowCount: 0 },
      // jaAcumulou? → não
      { rowCount: 0, rows: [] },
      // UPDATE clientes
      { rowCount: 1 },
      // SELECT saldo
      { rowCount: 1, rows: [{ saldo: 50 }] },
      // INSERT fidelidade_movimentos
      { rowCount: 1 },
      // COMMIT
      { rowCount: 0 },
    ]);
    pool.query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [cfg] });

    await acumularPontosFidelidade(pool, { empresaId: 1, clienteId: 1, vendaId: 1, totalVenda: 49.99 });
    // Math.floor(49.99 × 1) = 49
    const insertCall = pool._client.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1][2]).toBe(49); // pontos = 49
  });

  test('pontos zero (valor muito baixo) → return sem INSERT', async () => {
    const cfg = { pontos_por_real: 0.01, validade_dias: 0 };
    const pool = createTransactionalPool([]);
    pool.query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [cfg] });

    // Math.floor(0.50 × 0.01) = Math.floor(0.005) = 0 → return
    await acumularPontosFidelidade(pool, { empresaId: 1, clienteId: 1, vendaId: 1, totalVenda: 0.50 });
    // connect não deve ser chamado pois pontos <= 0
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('idempotência: já acumulou pontos para mesma venda → ROLLBACK sem INSERT', async () => {
    const cfg = { pontos_por_real: 1, validade_dias: 365 };

    const pool = createTransactionalPool([
      { rowCount: 0 },                              // BEGIN
      { rowCount: 1, rows: [{ id: 55 }] },           // jaAcumulou? → sim
      { rowCount: 0 },                              // ROLLBACK
    ]);
    pool.query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [cfg] });

    await acumularPontosFidelidade(pool, { empresaId: 1, clienteId: 1, vendaId: 1, totalVenda: 100 });

    const insertCall = pool._client.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    expect(insertCall).toBeUndefined();

    const rollbackCall = pool._client.query.mock.calls.find(c => String(c[0]) === 'ROLLBACK');
    expect(rollbackCall).toBeDefined();
  });
});

// ── estornarPontosFidelidade — guards ─────────────────────────────────────

describe('estornarPontosFidelidade — parâmetros obrigatórios', () => {
  test('clienteId ausente → return imediato', async () => {
    const pool = { query: jest.fn(), connect: jest.fn() };
    await estornarPontosFidelidade(pool, {
      empresaId: 1, clienteId: null, vendaId: 1, devolucaoId: 1, totalDevolvido: 50, vendaTotal: 100
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('devolucaoId ausente → return imediato', async () => {
    const pool = { query: jest.fn(), connect: jest.fn() };
    await estornarPontosFidelidade(pool, {
      empresaId: 1, clienteId: 1, vendaId: 1, devolucaoId: null, totalDevolvido: 50, vendaTotal: 100
    });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ── estornarPontosFidelidade — cálculo proporcional ──────────────────────

describe('estornarPontosFidelidade — cálculo proporcional', () => {
  test('devolução total → estorna todos os pontos', async () => {
    const cfg = { pontos_por_real: 1, validade_dias: 365 };
    const movOriginal = { pontos: 100 };
    const saldoResult = { saldo: 50 };

    const pool = createTransactionalPool([
      { rowCount: 0 },                              // BEGIN
      { rowCount: 0, rows: [] },                    // jaEstornou? → não
      { rowCount: 1, rows: [movOriginal] },          // movimento original
      { rowCount: 1 },                              // UPDATE clientes
      { rowCount: 1, rows: [saldoResult] },          // SELECT saldo
      { rowCount: 1 },                              // INSERT debito
      { rowCount: 0 },                              // COMMIT
    ]);
    pool.query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [cfg] });

    await estornarPontosFidelidade(pool, {
      empresaId: 1, clienteId: 1, vendaId: 1, devolucaoId: 99,
      totalDevolvido: 100, vendaTotal: 100
    });

    const insertCall = pool._client.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    expect(insertCall).toBeDefined();
    // proporcao = 100/100 = 1, pontosEstornar = Math.floor(100 × 1) = 100
    expect(insertCall[1][2]).toBe(100);
  });

  test('devolução parcial (50%) → estorna metade dos pontos', async () => {
    const cfg = { pontos_por_real: 1, validade_dias: 0 };

    const pool = createTransactionalPool([
      { rowCount: 0 },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ pontos: 80 }] },
      { rowCount: 1 },
      { rowCount: 1, rows: [{ saldo: 40 }] },
      { rowCount: 1 },
      { rowCount: 0 },
    ]);
    pool.query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [cfg] });

    await estornarPontosFidelidade(pool, {
      empresaId: 1, clienteId: 1, vendaId: 1, devolucaoId: 100,
      totalDevolvido: 50, vendaTotal: 100
    });

    const insertCall = pool._client.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    expect(insertCall).toBeDefined();
    // proporcao = 50/100 = 0.5, pontosEstornar = Math.floor(80 × 0.5) = 40
    expect(insertCall[1][2]).toBe(40);
  });

  test('vendaTotal zero → proporcao = 1 (estorna tudo)', async () => {
    const cfg = { pontos_por_real: 1, validade_dias: 0 };

    const pool = createTransactionalPool([
      { rowCount: 0 },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ pontos: 50 }] },
      { rowCount: 1 },
      { rowCount: 1, rows: [{ saldo: 0 }] },
      { rowCount: 1 },
      { rowCount: 0 },
    ]);
    pool.query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [cfg] });

    await estornarPontosFidelidade(pool, {
      empresaId: 1, clienteId: 1, vendaId: 1, devolucaoId: 100,
      totalDevolvido: 100, vendaTotal: 0 // divisão por zero protegida
    });

    // proporcao = Math.min(100/0, 1) → Infinity limited to 1 by Math.min
    // pontosEstornar = Math.floor(50 × 1) = 50
    // Verifica que não lançou erro
    expect(pool._client.release).toHaveBeenCalled();
  });

  test('idempotência: jaEstornou → ROLLBACK sem INSERT', async () => {
    const cfg = { pontos_por_real: 1 };

    const pool = createTransactionalPool([
      { rowCount: 0 },
      { rowCount: 1, rows: [{ id: 55 }] }, // jaEstornou → sim
      { rowCount: 0 },                     // ROLLBACK
    ]);
    pool.query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [cfg] });

    await estornarPontosFidelidade(pool, {
      empresaId: 1, clienteId: 1, vendaId: 1, devolucaoId: 99,
      totalDevolvido: 100, vendaTotal: 100
    });

    const insertCall = pool._client.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    expect(insertCall).toBeUndefined();
  });

  test('venda sem pontos originais → ROLLBACK sem INSERT', async () => {
    const cfg = { pontos_por_real: 1 };

    const pool = createTransactionalPool([
      { rowCount: 0 },
      { rowCount: 0, rows: [] },             // jaEstornou? → não
      { rowCount: 0, rows: [] },             // movOriginal → não encontrado
      { rowCount: 0 },                       // ROLLBACK
    ]);
    pool.query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [cfg] });

    await estornarPontosFidelidade(pool, {
      empresaId: 1, clienteId: 1, vendaId: 1, devolucaoId: 99,
      totalDevolvido: 100, vendaTotal: 100
    });

    const insertCall = pool._client.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    expect(insertCall).toBeUndefined();
  });
});
