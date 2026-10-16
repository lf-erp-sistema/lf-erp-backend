'use strict';
const mockAgents = [];
jest.mock('undici', () => ({ Agent: jest.fn(function(options) {
  this.options = options; this.close = jest.fn().mockResolvedValue(); mockAgents.push(this);
}) }));
const dns = require('dns').promises;
const { hostBloqueado, validarHostExterno, fetchSeguro } = require('../utils/ssrfGuard');
const fetchOriginal = global.fetch;
afterEach(() => { jest.restoreAllMocks(); global.fetch = fetchOriginal; mockAgents.length = 0; });
test.each(['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
  'fc01::1', 'fdff::1', 'fe90::1', '::ffff:7f00:1', '::ffff:192.168.1.1', '::1', '0.0.0.0', '224.0.0.1'])('bloqueia endereço reservado %s', address => {
  expect(hostBloqueado(address)).toBe(true);
});
test.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('permite IP público %s', address => {
  expect(hostBloqueado(address)).toBe(false);
});
test('DNS misto com resposta privada é negado', async () => {
  jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: 'fc01::1', family: 6 }]);
  expect(await validarHostExterno('exemplo.test')).toBe(false);
});
test('transporte usa apenas IP aprovado sem resolver DNS novamente', async () => {
  const lookup = jest.spyOn(dns, 'lookup').mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  global.fetch = jest.fn(async (url, options) => {
    const callback = jest.fn();
    options.dispatcher.options.connect.lookup('exemplo.test', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    return new Response('ok', { status: 200 });
  });
  const result = await fetchSeguro('https://exemplo.test');
  expect(await result.text()).toBe('ok'); expect(lookup).toHaveBeenCalledTimes(1);
  expect(mockAgents[0].close).toHaveBeenCalled();
});
test('redirect para outra origem é bloqueado e encerra dispatcher', async () => {
  jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  global.fetch = jest.fn().mockResolvedValue(new Response('', { status: 307, headers: { location: 'https://outro.test' } }));
  await expect(fetchSeguro('https://exemplo.test', { method: 'POST', body: 'privado' })).rejects.toMatchObject({ ssrfBloqueado: true });
  expect(global.fetch).toHaveBeenCalledTimes(1); expect(mockAgents[0].close).toHaveBeenCalled();
});
test('redirect revalida DNS e não envia segunda chamada a IP privado', async () => {
  jest.spyOn(dns, 'lookup').mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
  global.fetch = jest.fn().mockResolvedValue(new Response('', { status: 302, headers: { location: '/destino' } }));
  await expect(fetchSeguro('https://exemplo.test')).rejects.toMatchObject({ ssrfBloqueado: true });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
