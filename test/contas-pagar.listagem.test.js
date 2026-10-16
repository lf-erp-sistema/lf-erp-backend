'use strict';

jest.mock('../utils/permissoes', () => ({ requirePermissao: () => (req, res, next) => next() }));
jest.mock('../utils/webhookContabil', () => ({ dispararWebhookComRetry: jest.fn() }));
const express = require('express');
const request = require('supertest');
const contasPagarRoutes = require('../routes/contas-pagar.routes');

function setup(empresa = { id: 7, nome: 'Loja teste' }) {
  const pool = { query: jest.fn(async sql => ({ rows: sql.includes('COUNT(*)')
    ? [{ total: 1, total_valor: '100.00', total_atrasado: '100.00', qtd_atrasado: 1 }]
    : [{ id: 3, valor: '100.00', status_exibicao: 'atrasado' }] })) };
  const atualizarStatus = jest.fn();
  const app = express();
  app.use(contasPagarRoutes({
    auth: (req, res, next) => next(), writeRateLimiter: (req, res, next) => next(),
    pool, validarAcessoEmpresa: jest.fn().mockResolvedValue(empresa),
    atualizarStatusContasPagarPorEmpresa: atualizarStatus, registrarLogFinanceiro: jest.fn(),
  }));
  return { app, pool, atualizarStatus };
}

test('listagem mensal calcula status sem iniciar atualização de todos os títulos', async () => {
  const { app, pool, atualizarStatus } = setup();
  const res = await request(app).get('/contas-pagar/Loja%20teste')
    .query({ data_inicial: '2026-09-01', data_final: '2026-09-30', page: 2, limit: 50 });
  expect(res.status).toBe(200);
  expect(res.body.contas[0].status).toBe('atrasado');
  expect(res.body.resumo.total_atrasado).toBe(100);
  expect(atualizarStatus).not.toHaveBeenCalled();
  expect(pool.query).toHaveBeenCalledTimes(2);
  for (const [sql, params] of pool.query.mock.calls) {
    expect(sql).toContain('cp.empresa_id = $3 OR (cp.empresa_id IS NULL AND cp.empresa = $1)');
    expect(sql).toContain('cp.data_vencimento >= $4::text');
    expect(sql).toContain('cp.data_vencimento <= $5::text');
    expect(params.slice(2, 5)).toEqual([7, '2026-09-01', '2026-09-30']);
  }
  expect(pool.query.mock.calls[0][1].slice(-2)).toEqual([50, 50]);
});

test('continua bloqueando consultas sem acesso à empresa', async () => {
  const { app, pool } = setup(null);
  const res = await request(app).get('/contas-pagar/Outra');
  expect(res.status).toBe(403);
  expect(pool.query).not.toHaveBeenCalled();
});
