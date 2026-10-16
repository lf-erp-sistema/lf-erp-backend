'use strict';

/**
 * Proteção centralizada contra SSRF — LF ERP
 *
 * Antes desta unificação (achado SEC-05 da auditoria 360, 2026-10-06), a
 * mesma blocklist de IP privado/loopback existia reimplementada de forma
 * levemente divergente em 5 arquivos (utils/webhooks.js, utils/whatsapp.js,
 * utils/webhookContabil.js, routes/alertas.routes.js, routes/whatsapp.routes.js
 * e routes/exportacao.routes.js) — uma correção de bypass precisava ser
 * replicada manualmente em todos.
 *
 * Também corrige o achado SEC-04: a validação antiga checava só o hostname
 * literal, ANTES da resolução DNS — um domínio público que resolva (DNS
 * rebinding, ou simplesmente um registro A apontando pra rede interna) para
 * um IP privado passava no filtro de string e só era resolvido no momento
 * real do fetch(). validarUrlExterna()/validarHostExterno() resolvem o DNS
 * e validam o(s) IP(s) resultante(s) também.
 */

const dns = require('dns').promises;
const net = require('net');
const ipaddr = require('ipaddr.js');
const { Agent } = require('undici');

const BLOQUEADOS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 — CGNAT
  /^0\./,                                     // 0.0.0.0/8 — "esta rede"
  /^::1$/,
  /^fc00:/i,                                  // IPv6 ULA
  /^fd[0-9a-f]{2}:/i,                         // IPv6 ULA
  /^fe80:/i,                                  // IPv6 link-local
  /^::ffff:127\./i,                           // IPv4-mapped
  /^::ffff:10\./i,
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./i,
  /^::ffff:192\.168\./i,
  /^::ffff:169\.254\./i,
  /^metadata\.google\.internal$/i,            // endpoint de metadata de nuvem (GCP)
];

function hostBloqueado(host) {
  const h = String(host || '').toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(h)) {
    let address = ipaddr.parse(h);
    if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) address = address.toIPv4Address();
    return address.range() !== 'unicast';
  }
  return BLOQUEADOS.some((r) => r.test(h));
}

async function resolverPublico(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (hostBloqueado(host)) throw new Error('Destino privado ou reservado');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(entry => !net.isIP(entry.address) || hostBloqueado(entry.address))) {
    throw new Error('DNS retornou destino privado ou reservado');
  }
  return addresses;
}

// Valida um hostname/IP: bloqueia por padrão literal E por resolução DNS.
async function validarHostExterno(hostname) {
  if (!hostname) return false;
  if (hostBloqueado(hostname)) return false;
  try {
    await resolverPublico(hostname);
    return true;
  } catch {
    return false; // não resolve — trata como inválido
  }
}

// Valida uma URL completa pra disparo de requisição HTTP pelo servidor:
// protocolo http/https + host não bloqueado (literal e via DNS).
async function validarUrlExterna(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  return validarHostExterno(url.hostname);
}

const MAX_REDIRECTS = 3;

// fetch() seguro contra SSRF via redirect: o fetch nativo segue 3xx por padrão
// sem revalidar o host de destino — um endpoint que passe na validação inicial
// pode responder com um redirect para um IP interno. Aqui cada hop (incluindo
// o primeiro) é revalidado por validarUrlExterna() antes de ser seguido, com
// limite de redirecionamentos.
async function fetchSeguro(urlStr, options = {}) {
  let atual = urlStr;
  const timeout = AbortSignal.timeout(15_000);
  let requestOptions = { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout };
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let url, addresses;
    try {
      url = new URL(atual);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL inválida');
      addresses = await resolverPublico(url.hostname);
    } catch {
      const err = new Error('URL bloqueada por política de segurança (SSRF)');
      err.ssrfBloqueado = true;
      throw err;
    }
    // O transporte só recebe IPs aprovados, mantendo hostname original para TLS/SNI.
    const dispatcher = new Agent({ connect: { lookup: (host, opts, callback) => {
      if (host !== url.hostname.replace(/^\[|\]$/g, '')) return callback(new Error('Hostname inesperado'));
      const selected = addresses.filter(entry => !opts.family || opts.family === entry.family);
      if (!selected.length) return callback(new Error('Família IP indisponível'));
      return opts.all ? callback(null, selected) : callback(null, selected[0].address, selected[0].family);
    } } });
    try {
    const resp = await fetch(atual, { ...requestOptions, dispatcher, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get('location');
      if (location) {
        await resp.body?.cancel();
        const target = new URL(location, atual);
        if (target.origin !== url.origin) throw Object.assign(new Error('Redirecionamento entre origens bloqueado'), { ssrfBloqueado: true });
        if (resp.status === 303 || ([301, 302].includes(resp.status) && String(requestOptions.method).toUpperCase() === 'POST')) {
          requestOptions = { ...requestOptions, method: 'GET', body: undefined };
        }
        atual = target.toString();
        continue;
      }
    }
    // Consome uma resposta limitada antes de fechar o dispatcher, inclusive em
    // webhooks cujo chamador só usa o status e não lê o corpo.
    const chunks = [];
    let total = 0;
    if (resp.body) {
      for await (const chunk of resp.body) {
        total += chunk.length;
        if (total > 2 * 1024 * 1024) throw new Error('Resposta externa excede 2 MB');
        chunks.push(Buffer.from(chunk));
      }
    }
    return new Response([101, 204, 205, 304].includes(resp.status) ? null : Buffer.concat(chunks), {
      status: resp.status, statusText: resp.statusText, headers: resp.headers
    });
    } finally {
      await dispatcher.close();
    }
  }
  const err = new Error('Muitos redirecionamentos');
  err.ssrfBloqueado = true;
  throw err;
}

module.exports = { hostBloqueado, validarHostExterno, validarUrlExterna, fetchSeguro };
