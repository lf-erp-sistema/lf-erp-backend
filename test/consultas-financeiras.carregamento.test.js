'use strict';
jest.mock('../utils/permissoes', () => ({ requirePermissao: () => (req, res, next) => next() }));
const express = require('express');
const request = require('supertest');

const cases = [
  ['fluxo de caixa', '../routes/financeiro.routes', '/fluxo-caixa/Loja'],
  ['projeção de caixa', '../routes/financeiro.routes', '/cashflow-futuro?empresa=Loja&dias=30'],
  ['dashboard', '../routes/dashboard.routes', '/dashboard'],
  ['resumo financeiro', '../routes/relatorios/resumo.routes', '/financeiro/resumo/Loja'],
  ['relatório de fluxo', '../routes/relatorios/fluxoCaixa.routes', '/financeiro/fluxo-caixa/Loja'],
];

function setup(modulePath, autorizado = true) {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 }) };
  const receber = jest.fn(), pagar = jest.fn();
  const app = express();
  app.use(require(modulePath)({
    auth: (req, res, next) => next(), writeRateLimiter: (req, res, next) => next(), pool,
    validarAcessoEmpresa: jest.fn().mockResolvedValue(autorizado ? { id: 7, nome: 'Loja' } : null),
    adicionarFiltroEmpresaSaaS: ({ params, empresaResolvida }) => {
      params.push(empresaResolvida.id, empresaResolvida.nome);
      return ` AND (empresa_id = $${params.length - 1} OR (empresa_id IS NULL AND empresa = $${params.length}))`;
    },
    atualizarStatusContasReceberPorEmpresa: receber,
    atualizarStatusContasPagarPorEmpresa: pagar,
    podeGerenciarFinanceiro: () => true,
  }));
  return { app, pool, receber, pagar };
}

test.each(cases)('%s consulta dados sem transação de atualização geral', async (_, modulePath, url) => {
  const { app, pool, receber, pagar } = setup(modulePath);
  const res = await request(app).get(url);
  expect(res.status).toBe(200);
  expect(pool.query).toHaveBeenCalled();
  expect(receber).not.toHaveBeenCalled();
  expect(pagar).not.toHaveBeenCalled();
});

test.each(cases)('%s preserva bloqueio de acesso à empresa', async (_, modulePath, url) => {
  const { app, pool } = setup(modulePath, false);
  const res = await request(app).get(url);
  expect(res.status).toBe(403);
  expect(pool.query).not.toHaveBeenCalled();
});
