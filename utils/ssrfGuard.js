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
  return BLOQUEADOS.some((r) => r.test(h));
}

// Valida um hostname/IP: bloqueia por padrão literal E por resolução DNS.
async function validarHostExterno(hostname) {
  if (!hostname) return false;
  if (hostBloqueado(hostname)) return false;
  try {
    const enderecos = await dns.lookup(hostname, { all: true });
    return enderecos.length > 0 && !enderecos.some((e) => hostBloqueado(e.address));
  } catch {
    return false; // não resolve — trata como inválido
  }
}

// Valida uma URL completa pra disparo de requisição HTTP pelo servidor:
// protocolo http/https + host não bloqueado (literal e via DNS).
async function validarUrlExterna(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  return validarHostExterno(url.hostname);
}

module.exports = { hostBloqueado, validarHostExterno, validarUrlExterna };
