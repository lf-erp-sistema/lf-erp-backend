/**
 * Engine de entrega de webhooks — LF ERP
 * Envia notificações assíncronas com HMAC-SHA256 e retentativas.
 */

const crypto = require('crypto');
const { validarUrlExterna } = require('./ssrfGuard');

const MAX_TENTATIVAS = 3;
const TIMEOUT_MS     = 10000;
// Delays entre tentativas: 1min, 5min
const RETRY_DELAYS   = [60_000, 300_000];

/**
 * Dispara webhooks para todos os endpoints ativos que escutam o evento.
 * Fire-and-forget — não bloqueia a requisição original.
 *
 * @param {{ pool, empresaId, evento, payload }} opts
 */
async function dispatchWebhook({ pool, empresaId, evento, payload }) {
  let endpoints;
  try {
    const result = await pool.query(
      `SELECT * FROM webhook_endpoints WHERE empresa_id = $1 AND ativo = true AND $2 = ANY(eventos)`,
      [empresaId, evento]
    );
    endpoints = result.rows;
  } catch (err) {
    console.error('[webhooks] falha ao buscar endpoints:', err.message);
    return;
  }

  for (const ep of endpoints) {
    enviarWebhook({ pool, endpoint: ep, evento, payload, tentativa: 1 }).catch(() => {});
  }
}

async function enviarWebhook({ pool, endpoint, evento, payload, tentativa }) {
  if (!endpoint.secret) {
    console.warn(`[webhooks] endpoint ${endpoint.id} sem secret — descartado`);
    return;
  }

  if (!(await validarUrlExterna(endpoint.url))) {
    console.warn(`[webhooks] endpoint ${endpoint.id}: URL bloqueada por SSRF (${endpoint.url})`);
    try {
      await pool.query(
        `INSERT INTO webhook_logs (endpoint_id, empresa_id, evento, payload, status_http, sucesso, tentativa, erro)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [endpoint.id, endpoint.empresa_id, evento, JSON.stringify(payload), null, false, tentativa, 'URL bloqueada: endereço privado']
      );
    } catch { /* log não deve quebrar o fluxo */ }
    return;
  }

  const body = JSON.stringify({
    evento,
    dados: payload,
    timestamp: new Date().toISOString(),
    empresa_id: endpoint.empresa_id
  });

  const sig = crypto
    .createHmac('sha256', endpoint.secret)
    .update(body)
    .digest('hex');

  let statusHttp = null;
  let sucesso    = false;
  let erroMsg    = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const resp = await fetch(endpoint.url, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-LF-Signature':  `sha256=${sig}`,
        'X-LF-Evento':     evento,
        'X-LF-Tentativa':  String(tentativa),
        'User-Agent':      'LF-ERP-Webhook/1.0'
      },
      body,
      signal: controller.signal
    });

    clearTimeout(timer);
    statusHttp = resp.status;
    sucesso    = resp.ok;
    if (!resp.ok) erroMsg = `HTTP ${resp.status}`;
  } catch (err) {
    erroMsg = err.name === 'AbortError' ? 'Timeout (10s)' : err.message;
  }

  // Persiste log
  try {
    await pool.query(
      `INSERT INTO webhook_logs (endpoint_id, empresa_id, evento, payload, status_http, sucesso, tentativa, erro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [endpoint.id, endpoint.empresa_id, evento, JSON.stringify(payload), statusHttp, sucesso, tentativa, erroMsg]
    );
  } catch { /* log não deve quebrar o fluxo */ }

  // Retentativa com backoff se falhou e ainda há tentativas
  if (!sucesso && tentativa < MAX_TENTATIVAS) {
    const delay = RETRY_DELAYS[tentativa - 1] || 60_000;
    setTimeout(
      () => enviarWebhook({ pool, endpoint, evento, payload, tentativa: tentativa + 1 }).catch(() => {}),
      delay
    );
  }
}

module.exports = { dispatchWebhook, enviarWebhook };
