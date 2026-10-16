'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Executa o módulo de navegador com API e DOM controlados, sem acessar produção.
function createModule(tipo) {
  const container = { setAttribute: jest.fn() };
  const feedback = { textContent: '' };
  const document = {
    getElementById: jest.fn(id => ({ [`contas${tipo}Container`]: container, [`contas${tipo}Feedback`]: feedback }[id] || null)),
    querySelectorAll: () => [],
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  const getContas = jest.fn();
  const api = { getEmpresaId: () => 7, [`getContas${tipo}`]: getContas };
  const context = vm.createContext({
    document, api, console: { error: jest.fn() },
    debounce: fn => fn, buildFriendlyError: err => err.message,
  });
  const source = fs.readFileSync(path.join(__dirname, `../../frontend/js/contas${tipo}.js`), 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export async function', 'async function');
  vm.runInContext(source + '\nglobalThis.hooks = { state, recarregar, bindEventos };', context);
  context.renderSpy = jest.fn();
  context.skeletonSpy = jest.fn();
  context.messageSpy = jest.fn();
  vm.runInContext('render = renderSpy; renderSkeleton = skeletonSpy; showMessage = messageSpy;', context);
  return { ...context, api, getContas, document, container, feedback };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const response = id => ({ contas: [{ id }], resumo: { total: id }, paginacao: { total: 1, total_paginas: 1 } });

describe.each(['Pagar', 'Receber'])('Contas a %s', tipo => {
test('mantém a tabela visível durante a atualização e busca só a página e período selecionados', async () => {
  const m = createModule(tipo);
  const request = deferred();
  m.getContas.mockReturnValue(request.promise);
  m.hooks.state.contas = [{ id: 1 }];
  m.hooks.state.periodo = { dataInicial: '2026-09-01', dataFinal: '2026-09-30' };
  const pending = m.hooks.recarregar();
  expect(m.hooks.state.contas[0].id).toBe(1);
  expect(m.skeletonSpy).not.toHaveBeenCalled();
  expect(m.renderSpy).not.toHaveBeenCalled();
  expect(m.getContas).toHaveBeenCalledWith(expect.objectContaining({
    empresa_id: 7, data_inicial: '2026-09-01', data_final: '2026-09-30', page: 1, limit: 50,
  }));
  expect(m.messageSpy).not.toHaveBeenCalled();
  request.resolve(response(2));
  await pending;
  expect(m.hooks.state.contas[0].id).toBe(2);
  expect(m.renderSpy).toHaveBeenCalledTimes(1);
  expect(m.hooks.state.loading).toBe(false);
});

test('trocas rápidas de mês mantêm a resposta do filtro mais recente', async () => {
  const m = createModule(tipo);
  const old = deferred(), current = deferred();
  m.getContas.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const first = m.hooks.recarregar();
  const second = m.hooks.recarregar();
  current.resolve(response(20));
  await second;
  old.resolve(response(10));
  await first;
  expect(m.hooks.state.contas[0].id).toBe(20);
  expect(m.renderSpy).toHaveBeenCalledTimes(1);
});

test('falha de um filtro antigo não encerra o carregamento do filtro atual', async () => {
  const m = createModule(tipo);
  const old = deferred(), current = deferred();
  m.getContas.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const first = m.hooks.recarregar();
  const second = m.hooks.recarregar();
  old.reject(new Error('erro antigo'));
  await first;
  expect(m.hooks.state.loading).toBe(true);
  expect(m.messageSpy).not.toHaveBeenCalled();
  current.resolve(response(20));
  await second;
  expect(m.hooks.state.loading).toBe(false);
});

test('erro na atualização preserva os títulos já exibidos e permite tentar novamente', async () => {
  const m = createModule(tipo);
  m.hooks.state.contas = [{ id: 1 }];
  m.getContas.mockRejectedValue(new Error('Sem conexão'));
  await m.hooks.recarregar();
  expect(m.hooks.state.contas[0].id).toBe(1);
  expect(m.messageSpy).toHaveBeenCalledWith('Sem conexão', 'error');
  expect(m.hooks.state.loading).toBe(false);
});

test('redesenhos substituem o evento global de ações em vez de acumular cliques', () => {
  const m = createModule(tipo);
  m.hooks.bindEventos();
  const firstHandler = m.document.addEventListener.mock.calls[0][1];
  m.hooks.bindEventos();
  expect(m.document.removeEventListener).toHaveBeenCalledWith('click', firstHandler);
  expect(m.document.addEventListener.mock.calls[1][1]).not.toBe(firstHandler);
});
});
