'use strict';

const { hoje, addDias, normalizarDecimal, normalizarInt } = require('../utils/normalizadores');

// utils/financeiroOps.js mantém estado em módulo (_configCache, _statusThrottleReceber,
// _statusThrottlePagar) para cache/throttle entre chamadas reais. Pra testar essas duas
// coisas sem um teste "contaminar" o outro, cada teste que depende desse estado pega uma
// instância nova do módulo via jest.resetModules().
function freshFinanceiroOps(pool, overrides = {}) {
  jest.resetModules();
  const { createFinanceiroOps } = require('../utils/financeiroOps');
  return createFinanceiroOps(pool, { hoje, addDias, normalizarDecimal, normalizarInt, ...overrides });
}

describe('criarParcelasContasReceber', () => {
  function makeFakeClient() {
    const calls = [];
    const query = jest.fn((sql, params) => {
      calls.push(params);
      return Promise.resolve({
        rows: [{
          id: calls.length,
          empresa_id: params[1],
          cliente_id: params[3],
          cliente_nome: params[4],
          parcela: params[5],
          total_parcelas: params[6],
          valor: params[7],
          data_vencimento: params[8],
          forma_pagamento: params[9],
          observacao: params[10],
          criado_por: params[11],
        }],
      });
    });
    return { query, calls };
  }

  test('divide o total em parcelas iguais; a última absorve o resto do arredondamento (soma bate com o total)', async () => {
    const client = makeFakeClient();
    const { criarParcelasContasReceber } = freshFinanceiroOps({});
    const parcelas = await criarParcelasContasReceber({
      client, empresa: 'Loja', empresa_id: 1, venda_id: 10,
      total: 100, quantidade_parcelas: 3, data_primeiro_vencimento: '2026-01-10',
    });
    expect(parcelas).toHaveLength(3);
    const soma = parcelas.reduce((s, p) => s + Number(p.valor), 0);
    expect(Number(soma.toFixed(2))).toBe(100);
    expect(parcelas[2].valor).not.toBe(parcelas[0].valor); // última absorve o resto
  });

  test('quantidade_parcelas <= 0 retorna [] e não insere nada', async () => {
    const client = makeFakeClient();
    const { criarParcelasContasReceber } = freshFinanceiroOps({});
    const parcelas = await criarParcelasContasReceber({
      client, empresa: 'Loja', venda_id: 10, total: 100, quantidade_parcelas: 0,
    });
    expect(parcelas).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('quantidade_parcelas acima de 360 é limitada a 360', async () => {
    const client = makeFakeClient();
    const { criarParcelasContasReceber } = freshFinanceiroOps({});
    const parcelas = await criarParcelasContasReceber({
      client, empresa: 'Loja', venda_id: 10, total: 360, quantidade_parcelas: 500,
    });
    expect(parcelas).toHaveLength(360);
  });

  test('primeira parcela usa data_primeiro_vencimento; demais usam addDias com intervalo_dias informado', async () => {
    const client = makeFakeClient();
    const { criarParcelasContasReceber } = freshFinanceiroOps({});
    const parcelas = await criarParcelasContasReceber({
      client, empresa: 'Loja', venda_id: 10, total: 300, quantidade_parcelas: 3,
      data_primeiro_vencimento: '2026-01-10', intervalo_dias: 15,
    });
    expect(parcelas[0].data_vencimento).toBe('2026-01-10');
    expect(parcelas[1].data_vencimento).toBe(addDias('2026-01-10', 15));
    expect(parcelas[2].data_vencimento).toBe(addDias('2026-01-10', 30));
  });

  test('sem data_primeiro_vencimento informada, a primeira parcela vence hoje()', async () => {
    const client = makeFakeClient();
    const { criarParcelasContasReceber } = freshFinanceiroOps({});
    const parcelas = await criarParcelasContasReceber({
      client, empresa: 'Loja', venda_id: 10, total: 50, quantidade_parcelas: 1,
    });
    expect(parcelas[0].data_vencimento).toBe(hoje());
  });

  test('intervalo_dias default é 30 quando não informado', async () => {
    const client = makeFakeClient();
    const { criarParcelasContasReceber } = freshFinanceiroOps({});
    const parcelas = await criarParcelasContasReceber({
      client, empresa: 'Loja', venda_id: 10, total: 200, quantidade_parcelas: 2,
      data_primeiro_vencimento: '2026-01-10',
    });
    expect(parcelas[1].data_vencimento).toBe(addDias('2026-01-10', 30));
  });

  test('aplica defaults: cliente_id null, cliente_nome vazio, forma_pagamento "Promissória", observacao vazia, empresa_id null', async () => {
    const client = makeFakeClient();
    const { criarParcelasContasReceber } = freshFinanceiroOps({});
    await criarParcelasContasReceber({
      client, empresa: 'Loja', venda_id: 10, total: 50, quantidade_parcelas: 1,
    });
    const params = client.calls[0];
    expect(params[1]).toBeNull(); // empresa_id
    expect(params[3]).toBeNull(); // cliente_id
    expect(params[4]).toBe('');   // cliente_nome
    expect(params[9]).toBe('Promissória'); // forma_pagamento
    expect(params[10]).toBe('');  // observacao
  });
});

describe('registrarMovimentacaoEstoque', () => {
  test('usa o client transacional quando informado, não o pool', async () => {
    const client = { query: jest.fn().mockResolvedValue({}) };
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const { registrarMovimentacaoEstoque } = freshFinanceiroOps(pool);
    await registrarMovimentacaoEstoque({
      empresa: 'Loja', produto_id: 1, tipo: 'saida', quantidade: 2, client,
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('usa o pool quando client não é informado', async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const { registrarMovimentacaoEstoque } = freshFinanceiroOps(pool);
    await registrarMovimentacaoEstoque({ empresa: 'Loja', produto_id: 1, tipo: 'entrada', quantidade: 5 });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('aplica defaults: empresa_id/grade_id/referencia_tipo/referencia_id/usuario_id null, observacao vazia', async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const { registrarMovimentacaoEstoque } = freshFinanceiroOps(pool);
    await registrarMovimentacaoEstoque({ empresa: 'Loja', produto_id: 1, tipo: 'entrada', quantidade: 5 });
    const params = pool.query.mock.calls[0][1];
    expect(params).toEqual(['Loja', null, 1, null, 'entrada', 5, '', null, null, null]);
  });
});

describe('registrarAuditoria', () => {
  let consoleErrorSpy;
  beforeEach(() => { consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { consoleErrorSpy.mockRestore(); });

  test('sem client: é fire-and-forget — erro do INSERT não é propagado ao chamador', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('insert falhou')) };
    const { registrarAuditoria } = freshFinanceiroOps(pool);
    await expect(registrarAuditoria({
      empresa: 'Loja', usuario_id: 1, usuario_nome: 'Ana', modulo: 'produtos', acao: 'criar',
    })).resolves.toBeUndefined();
    // dá um tick pro .catch() da promise rejeitada rodar antes do teste terminar
    await new Promise((r) => setImmediate(r));
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('com client: modo transacional — erro do INSERT é propagado ao chamador', async () => {
    const client = { query: jest.fn().mockRejectedValue(new Error('insert falhou')) };
    const { registrarAuditoria } = freshFinanceiroOps({});
    await expect(registrarAuditoria({
      empresa: 'Loja', usuario_id: 1, usuario_nome: 'Ana', modulo: 'produtos', acao: 'criar', client,
    })).rejects.toThrow('insert falhou');
  });

  test('serializa dados_anteriores/dados_novos como JSON só quando informados', async () => {
    const client = { query: jest.fn().mockResolvedValue({}) };
    const { registrarAuditoria } = freshFinanceiroOps({});
    await registrarAuditoria({
      empresa: 'Loja', usuario_id: 1, modulo: 'produtos', acao: 'editar',
      dados_anteriores: { preco: 10 }, dados_novos: { preco: 20 }, client,
    });
    const params = client.query.mock.calls[0][1];
    expect(params[7]).toBe(JSON.stringify({ preco: 10 }));
    expect(params[8]).toBe(JSON.stringify({ preco: 20 }));
  });

  test('dados_anteriores/dados_novos ausentes viram null (não "null" string indevida)', async () => {
    const client = { query: jest.fn().mockResolvedValue({}) };
    const { registrarAuditoria } = freshFinanceiroOps({});
    await registrarAuditoria({ empresa: 'Loja', usuario_id: 1, modulo: 'produtos', acao: 'criar', client });
    const params = client.query.mock.calls[0][1];
    expect(params[7]).toBeNull();
    expect(params[8]).toBeNull();
  });

  test('extrai ip e user-agent de req quando informado; null quando não informado', async () => {
    const client = { query: jest.fn().mockResolvedValue({}) };
    const { registrarAuditoria } = freshFinanceiroOps({});
    const req = { ip: '203.0.113.5', headers: { 'user-agent': 'Mozilla/Teste' } };
    await registrarAuditoria({ empresa: 'Loja', usuario_id: 1, modulo: 'produtos', acao: 'criar', req, client });
    let params = client.query.mock.calls[0][1];
    expect(params[9]).toBe('203.0.113.5');
    expect(params[10]).toBe('Mozilla/Teste');

    await registrarAuditoria({ empresa: 'Loja', usuario_id: 1, modulo: 'produtos', acao: 'criar', client });
    params = client.query.mock.calls[1][1];
    expect(params[9]).toBeNull();
    expect(params[10]).toBeNull();
  });
});

describe('registrarLogFinanceiro', () => {
  let consoleErrorSpy;
  beforeEach(() => { consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { consoleErrorSpy.mockRestore(); });

  test('é fire-and-forget — erro do INSERT não é propagado ao chamador', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('insert falhou')) };
    const { registrarLogFinanceiro } = freshFinanceiroOps(pool);
    await expect(registrarLogFinanceiro({ empresa: 'Loja', tipo: 'criacao' })).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('coage valor pra Number (aceita string) e usa 0 quando ausente', async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const { registrarLogFinanceiro } = freshFinanceiroOps(pool);
    await registrarLogFinanceiro({ empresa: 'Loja', tipo: 'criacao', valor: '150.50' });
    expect(pool.query.mock.calls[0][1][6]).toBe(150.5);

    await registrarLogFinanceiro({ empresa: 'Loja', tipo: 'criacao' });
    expect(pool.query.mock.calls[1][1][6]).toBe(0);
  });

  test('aplica defaults: empresa null, tipo/entidade/descricao vazios, entidade_id/usuario_id null', async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const { registrarLogFinanceiro } = freshFinanceiroOps(pool);
    await registrarLogFinanceiro({});
    expect(pool.query.mock.calls[0][1]).toEqual([null, null, '', '', null, '', 0, null]);
  });
});

describe('obterConfigEmpresa — cache com TTL', () => {
  test('consulta o banco na primeira chamada e retorna a config encontrada', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ taxa_multa: 0.03, taxa_juros_dia: 0.001 }] }) };
    const { obterConfigEmpresa } = freshFinanceiroOps(pool);
    const config = await obterConfigEmpresa('Loja', 1);
    expect(config).toEqual({ taxa_multa: 0.03, taxa_juros_dia: 0.001 });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('retorna {} quando não há configuração cadastrada', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const { obterConfigEmpresa } = freshFinanceiroOps(pool);
    expect(await obterConfigEmpresa('Loja Sem Config', 1)).toEqual({});
  });

  test('segunda chamada para a mesma empresa dentro do TTL não consulta o banco de novo', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ taxa_multa: 0.02 }] }) };
    const { obterConfigEmpresa } = freshFinanceiroOps(pool);
    await obterConfigEmpresa('Loja Cache', 1);
    await obterConfigEmpresa('Loja Cache', 1);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('atualizarStatusContasReceberPorEmpresa', () => {
  function makeFakeClient(lockGranted) {
    const query = jest.fn((sql) => {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return Promise.resolve({ rows: [{ pg_try_advisory_xact_lock: lockGranted }] });
      }
      return Promise.resolve({ rows: [] });
    });
    return { query, release: jest.fn() };
  }

  function makeFakePool(client) {
    return {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn().mockResolvedValue({ rows: [{ taxa_multa: 0.02, taxa_juros_dia: 0.00033 }] }),
    };
  }

  function sqlsChamados(client) {
    return client.query.mock.calls.map((c) => c[0]);
  }

  test('lock não obtido: faz ROLLBACK e não roda nenhum UPDATE', async () => {
    const client = makeFakeClient(false);
    const pool = makeFakePool(client);
    const { atualizarStatusContasReceberPorEmpresa } = freshFinanceiroOps(pool);
    await atualizarStatusContasReceberPorEmpresa('Loja A', 1);
    const sqls = sqlsChamados(client);
    expect(sqls.some((s) => s.includes('ROLLBACK'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE contas_receber'))).toBe(false);
  });

  test('lock obtido: roda as 3 atualizações de status e faz COMMIT', async () => {
    const client = makeFakeClient(true);
    const pool = makeFakePool(client);
    const { atualizarStatusContasReceberPorEmpresa } = freshFinanceiroOps(pool);
    await atualizarStatusContasReceberPorEmpresa('Loja B', 2);
    const sqls = sqlsChamados(client);
    expect(sqls.filter((s) => s.includes('UPDATE contas_receber'))).toHaveLength(3);
    expect(sqls.some((s) => s.includes('COMMIT'))).toBe(true);
    expect(sqls.some((s) => s.includes('ROLLBACK'))).toBe(false);
  });

  test('throttle: duas chamadas rápidas para a mesma empresa só abrem uma conexão', async () => {
    const client = makeFakeClient(true);
    const pool = makeFakePool(client);
    const { atualizarStatusContasReceberPorEmpresa } = freshFinanceiroOps(pool);
    await atualizarStatusContasReceberPorEmpresa('Loja C', 3);
    await atualizarStatusContasReceberPorEmpresa('Loja C', 3);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  test('erro durante a transação: faz ROLLBACK e repropaga o erro', async () => {
    let chamadaUpdate = 0;
    const client = {
      query: jest.fn((sql) => {
        if (sql.includes('pg_try_advisory_xact_lock')) return Promise.resolve({ rows: [{ pg_try_advisory_xact_lock: true }] });
        if (sql.includes('UPDATE contas_receber')) {
          chamadaUpdate += 1;
          if (chamadaUpdate === 1) return Promise.reject(new Error('falha no update'));
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    const pool = makeFakePool(client);
    const { atualizarStatusContasReceberPorEmpresa } = freshFinanceiroOps(pool);
    await expect(atualizarStatusContasReceberPorEmpresa('Loja D', 4)).rejects.toThrow('falha no update');
    expect(sqlsChamados(client).some((s) => s.includes('ROLLBACK'))).toBe(true);
  });
});

describe('atualizarStatusContasPagarPorEmpresa', () => {
  function makeFakeClient(lockGranted) {
    const query = jest.fn((sql) => {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return Promise.resolve({ rows: [{ pg_try_advisory_xact_lock: lockGranted }] });
      }
      return Promise.resolve({ rows: [] });
    });
    return { query, release: jest.fn() };
  }
  function makeFakePool(client) {
    return { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [] }) };
  }
  function sqlsChamados(client) {
    return client.query.mock.calls.map((c) => c[0]);
  }

  test('lock não obtido: faz ROLLBACK e não roda nenhum UPDATE', async () => {
    const client = makeFakeClient(false);
    const pool = makeFakePool(client);
    const { atualizarStatusContasPagarPorEmpresa } = freshFinanceiroOps(pool);
    await atualizarStatusContasPagarPorEmpresa('Fornecedor A', 1);
    const sqls = sqlsChamados(client);
    expect(sqls.some((s) => s.includes('ROLLBACK'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE contas_pagar'))).toBe(false);
  });

  test('lock obtido: roda as 2 atualizações de status e faz COMMIT', async () => {
    const client = makeFakeClient(true);
    const pool = makeFakePool(client);
    const { atualizarStatusContasPagarPorEmpresa } = freshFinanceiroOps(pool);
    await atualizarStatusContasPagarPorEmpresa('Fornecedor B', 2);
    const sqls = sqlsChamados(client);
    expect(sqls.filter((s) => s.includes('UPDATE contas_pagar'))).toHaveLength(2);
    expect(sqls.some((s) => s.includes('COMMIT'))).toBe(true);
  });

  test('throttle: duas chamadas rápidas para a mesma empresa só abrem uma conexão', async () => {
    const client = makeFakeClient(true);
    const pool = makeFakePool(client);
    const { atualizarStatusContasPagarPorEmpresa } = freshFinanceiroOps(pool);
    await atualizarStatusContasPagarPorEmpresa('Fornecedor C', 3);
    await atualizarStatusContasPagarPorEmpresa('Fornecedor C', 3);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });
});

describe('atualizarStatusContasReceberGlobal / atualizarStatusContasPagarGlobal', () => {
  test('receber: dispara UPDATE contas_receber filtrando por data_vencimento < hoje()', async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const { atualizarStatusContasReceberGlobal } = freshFinanceiroOps(pool);
    await atualizarStatusContasReceberGlobal();
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE contas_receber'), [hoje()]);
  });

  test('pagar: dispara UPDATE contas_pagar filtrando por data_vencimento < hoje()', async () => {
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const { atualizarStatusContasPagarGlobal } = freshFinanceiroOps(pool);
    await atualizarStatusContasPagarGlobal();
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE contas_pagar'), [hoje()]);
  });
});
