'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loadModule(file, hooks, api, overrides = '') {
  const elements = new Map();
  const context = vm.createContext({
    api, window: {}, console: { error: jest.fn() },
    buildFriendlyError: e => e.message,
    escapeHtml: value => String(value ?? ''),
    document: { getElementById: id => elements.get(id) || null },
    renderSpy: jest.fn(), skeletonSpy: jest.fn(), messageSpy: jest.fn(),
    feedbackSpy: jest.fn(),
  });
  const source = fs.readFileSync(path.join(__dirname, `../../frontend/js/${file}.js`), 'utf8')
    .replace(/^\uFEFF/, '').replace(/^import .*;\r?\n/gm, '')
    .replace(/^export default .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source + `\n${overrides}\nglobalThis.hooks = { ${hooks} };`, context);
  return { ...context, elements };
}

test('fluxo mantém a tela durante a busca e ignora respostas de períodos anteriores', async () => {
  const first = deferred(), latest = deferred();
  const api = { getEmpresaId: () => 7, getEmpresaNome: () => 'Loja',
    getFluxoCaixa: jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise),
    request: jest.fn().mockResolvedValue({ total_entradas: 10 }) };
  const m = loadModule('fluxoCaixa', 'state, recarregar', api,
    'render = renderSpy; renderSkeleton = skeletonSpy; renderCashflowFuturo = () => {}; showMessage = messageSpy;');
  m.hooks.state.movimentos = [{ id: 1 }];
  const old = m.hooks.recarregar();
  const current = m.hooks.recarregar();
  expect(m.hooks.state.movimentos[0].id).toBe(1);
  expect(m.skeletonSpy).not.toHaveBeenCalled();
  expect(m.messageSpy).not.toHaveBeenCalled();
  latest.resolve({ entradas: 20, movimentos: [{ id: 20 }] });
  await current;
  first.resolve({ entradas: 10, movimentos: [{ id: 10 }] });
  await old;
  expect(m.hooks.state.movimentos[0].id).toBe(20);
  expect(m.hooks.state.resumo.entradas).toBe(20);
  expect(m.renderSpy).toHaveBeenCalledTimes(1);
});

test('projeção de caixa conserva o último horizonte escolhido se respostas chegam fora de ordem', async () => {
  const first = deferred(), latest = deferred();
  const m = loadModule('fluxoCaixa', 'state, carregarCashflowFuturo', {
    getEmpresaId: () => 7, getEmpresaNome: () => 'Loja',
    request: jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise),
  });
  const old = m.hooks.carregarCashflowFuturo(30);
  const current = m.hooks.carregarCashflowFuturo(90);
  latest.resolve({ dias: 90 });
  await current;
  first.resolve({ dias: 30 });
  await old;
  expect(m.hooks.state.cashflowFuturo.dias).toBe(90);
});

test('trocar o período do fluxo não busca novamente a projeção independente do período', async () => {
  const api = { getEmpresaId: () => 7, getFluxoCaixa: jest.fn().mockResolvedValue({ movimentos: [] }),
    request: jest.fn() };
  const m = loadModule('fluxoCaixa', 'recarregar', api,
    'render = renderSpy; renderCashflowFuturo = () => {};');
  await m.hooks.recarregar({ atualizarProjecao: false });
  expect(api.getFluxoCaixa).toHaveBeenCalledTimes(1);
  expect(api.request).not.toHaveBeenCalled();
});

test('relatórios mantêm a página e o resultado do último período, sem marcar abas antigas como prontas', async () => {
  const first = deferred(), latest = deferred();
  const m = loadModule('relatoriosFinanceiros', 'state, recarregarModulo', {
    getEmpresaId: () => 7,
    getRelatorioFinanceiroResumo: jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise),
  }, 'render = renderSpy; renderLoading = skeletonSpy; renderFeedback = feedbackSpy;');
  m.elements.set('filtroDataInicial', { value: '2026-09-01' });
  m.elements.set('filtroDataFinal', { value: '2026-09-30' });
  const old = m.hooks.recarregarModulo();
  m.elements.get('filtroDataInicial').value = '2026-10-01';
  const current = m.hooks.recarregarModulo();
  first.resolve({ total: 9 });
  await old;
  expect(m.hooks.state.loading).toBe(true);
  expect(m.hooks.state.abasCarregadas.has('resumo')).toBe(false);
  latest.resolve({ total: 10 });
  await current;
  expect(m.hooks.state.resumo.total).toBe(10);
  expect(m.hooks.state.loading).toBe(false);
  expect(m.skeletonSpy).not.toHaveBeenCalled();
  expect(m.renderSpy).toHaveBeenCalledTimes(1);
});

test('auditoria aplica o último filtro sem descartar a busca feita durante outra consulta', async () => {
  const first = deferred(), latest = deferred();
  const m = loadModule('auditoriaFinanceira', 'state, carregarLogs', {
    request: jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise),
  }, 'renderUI = () => "lista"; bind = () => {};');
  const container = { innerHTML: 'lista anterior', setAttribute: jest.fn() };
  m.elements.set('auditoriaFinanceiraContainer', container);
  const old = m.hooks.carregarLogs();
  m.hooks.state.filtros.busca = 'pix';
  const current = m.hooks.carregarLogs();
  expect(container.innerHTML).toBe('lista anterior');
  latest.resolve({ logs: [{ id: 20 }] });
  await current;
  first.resolve({ logs: [{ id: 10 }] });
  await old;
  expect(m.hooks.state.logs[0].id).toBe(20);
  expect(m.hooks.state.loading).toBe(false);
});

test('dashboard preserva os indicadores na atualização e limpa a exibição ao trocar de empresa', async () => {
  let empresa = 7;
  const m = loadModule('dashboard', 'loadDashboard', {
    getEmpresaId: () => empresa, getAuthToken: () => 'sessao', getUserTipo: () => 'funcionario',
    getDashboard: jest.fn().mockResolvedValue({}),
  }, `renderDashboardSkeleton = skeletonSpy;
    getDashboardConfig = () => ({ 'chart-vendas': false, 'chart-forma-pagamento': false });
    bindDashboardConfig = () => {}; renderKpis = () => {}; renderTopProdutos = () => {};
    renderAlertas = () => {}; renderTabelaPrecos = () => {}; destroyCharts = () => {};
    _setChartSkeletons = () => {}; applyDashboardConfig = () => {}; showMessage = messageSpy;`);
  await m.hooks.loadDashboard();
  await m.hooks.loadDashboard();
  expect(m.skeletonSpy).toHaveBeenCalledTimes(1);
  expect(m.messageSpy).not.toHaveBeenCalled();
  empresa = 8;
  await m.hooks.loadDashboard();
  expect(m.skeletonSpy).toHaveBeenCalledTimes(2);
});
