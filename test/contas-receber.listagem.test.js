'use strict';

jest.mock('../utils/permissoes', () => ({ requirePermissao: () => (req, res, next) => next() }));
const express = require('express');
const request = require('supertest');
const consultaRoutes = require('../routes/contas-receber/consulta.routes');

function setup(empresa = { id: 7, nome: 'Loja teste' }) {
  const pool = { query: jest.fn(async sql => ({ rows: sql.includes('COUNT(*)')
    ? [{ total: 1, total_valor: '100.00', total_atrasado: '100.00', qtd_atrasado: 1 }]
    : sql.includes('FROM lancamentos_financeiros') ? [{ total: '25.00' }]
    : [{ id: 3, valor: '100.00', status_exibicao: 'parcial_atrasado' }] })) };
  const atualizarStatus = jest.fn();
  const app = express();
  app.use(consultaRoutes({
    auth: (req, res, next) => next(), pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue(empresa),
    atualizarStatusContasReceberPorEmpresa: atualizarStatus,
    podeGerenciarFinanceiro: () => true,
  }));
  return { app, pool, atualizarStatus };
}

test('consulta mensal não atualiza todos os títulos e preserva resumo e ordenação paginada', async () => {
  const { app, pool, atualizarStatus } = setup();
  const res = await request(app).get('/contas-receber/Loja%20teste')
    .query({ data_inicial: '2026-09-01', data_final: '2026-09-30', page: 2, limit: 50 });
  expect(res.status).toBe(200);
  expect(res.body.contas[0].status).toBe('parcial_atrasado');
  expect(res.body.resumo.total_atrasado).toBe(100);
  expect(res.body.resumo.total_recebido_parcial).toBe(25);
  expect(atualizarStatus).not.toHaveBeenCalled();
  expect(pool.query).toHaveBeenCalledTimes(3);
  for (const [sql, params] of pool.query.mock.calls.slice(0, 2)) {
    expect(sql).toContain('cr.empresa_id = $3 OR (cr.empresa_id IS NULL AND cr.empresa = $1)');
    expect(sql).toContain('cr.data_vencimento >= $4::text');
    expect(sql).toContain('cr.data_vencimento <= $5::text');
    expect(params.slice(2, 5)).toEqual([7, '2026-09-01', '2026-09-30']);
  }
  expect(pool.query.mock.calls[0][0]).toContain('ORDER BY cr.data_vencimento DESC');
  expect(pool.query.mock.calls[0][1].slice(-2)).toEqual([50, 50]);
});

test('consulta mensal bloqueia acesso a outra empresa', async () => {
  const { app, pool } = setup(null);
  const res = await request(app).get('/contas-receber/Outra');
  expect(res.status).toBe(403);
  expect(pool.query).not.toHaveBeenCalled();
});
