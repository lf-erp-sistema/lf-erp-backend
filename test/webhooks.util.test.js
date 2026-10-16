'use strict';

// enviarWebhook() computava o HMAC com endpoint.secret direto do banco. Desde
// que webhooks.routes.js passou a gravar esse campo cifrado (encryptField),
// o HMAC passou a ser calculado sobre o texto cifrado em vez do segredo
// real, invalidando a assinatura para o receptor do webhook — achado
// F2-SEC-001, Auditoria de Segurança 2026-10-16.

process.env.PIX_ENCRYPTION_KEY = '0'.repeat(64); // 32 bytes hex válidos p/ testar o round-trip real

jest.mock('../utils/ssrfGuard', () => ({
  validarUrlExterna: jest.fn().mockResolvedValue(true),
  fetchSeguro: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
}));

const crypto = require('crypto');
const { encryptField } = require('../utils/pixCrypto');
const { fetchSeguro } = require('../utils/ssrfGuard');
const { enviarWebhook } = require('../utils/webhooks');

describe('enviarWebhook — decriptografa o secret antes do HMAC (F2-SEC-001)', () => {
  test('assinatura X-LF-Signature é calculada com o segredo REAL, não com o texto cifrado', async () => {
    const segredoReal = 'meu-segredo-super-secreto';
    const endpoint = { id: 1, empresa_id: 10, url: 'https://exemplo.com/webhook', secret: encryptField(segredoReal) };
    const pool = { query: jest.fn().mockResolvedValue({}) };

    await enviarWebhook({ pool, endpoint, evento: 'venda.criada', payload: { x: 1 }, tentativa: 1 });

    expect(fetchSeguro).toHaveBeenCalledTimes(1);
    const [, options] = fetchSeguro.mock.calls[0];
    const sigEnviada = options.headers['X-LF-Signature'];
    const body = options.body;

    const sigEsperada = `sha256=${crypto.createHmac('sha256', segredoReal).update(body).digest('hex')}`;
    expect(sigEnviada).toBe(sigEsperada);

    // Confirma que NÃO é o bug: assinatura calculada com o texto cifrado seria diferente
    const sigComCifrado = `sha256=${crypto.createHmac('sha256', endpoint.secret).update(body).digest('hex')}`;
    expect(sigEnviada).not.toBe(sigComCifrado);
  });

  test('secret legado em texto puro (sem prefixo enc:v1:) continua funcionando', async () => {
    const endpoint = { id: 2, empresa_id: 10, url: 'https://exemplo.com/webhook', secret: 'segredo-legado-texto-puro' };
    const pool = { query: jest.fn().mockResolvedValue({}) };

    await enviarWebhook({ pool, endpoint, evento: 'venda.criada', payload: { x: 1 }, tentativa: 1 });

    const [, options] = fetchSeguro.mock.calls.at(-1);
    const sigEsperada = `sha256=${crypto.createHmac('sha256', 'segredo-legado-texto-puro').update(options.body).digest('hex')}`;
    expect(options.headers['X-LF-Signature']).toBe(sigEsperada);
  });
});
