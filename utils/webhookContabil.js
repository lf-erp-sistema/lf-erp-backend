/**
 * Webhook de integração contábil — LF ERP
 * Dispara notificações HTTP para sistemas externos quando eventos financeiros ocorrem.
 * Todas as funções são fire-and-forget: lançar com .catch(e => console.error(...)) no chamador.
 */

const crypto = require('crypto');
const { validarUrlExterna: validarUrlWebhook } = require('./ssrfGuard');

function timestampFortaleza() {
  // Gera ISO 8601 com offset -03:00 (America/Fortaleza, sem horário de verão)
  const d = new Date();
  const off = -3 * 60;
  const local = new Date(d.getTime() + off * 60 * 1000);
  return local.toISOString().replace('Z', '-03:00');
}

async function dispararWebhook(pool, empresaId, evento, dados) {
  const r = await pool.query(
    `SELECT webhook_url, webhook_secret, eventos_ativos
     FROM contabilidade_config
     WHERE empresa_id = $1 AND ativo = true
       AND webhook_url IS NOT NULL AND webhook_url <> ''`,
    [empresaId]
  );
  if (!r.rowCount) return;

  const { webhook_url, webhook_secret, eventos_ativos } = r.rows[0];
  if (Array.isArray(eventos_ativos) && !eventos_ativos.includes(evento)) return;

  if (!(await validarUrlWebhook(webhook_url))) {
    console.warn(`[webhook-contabil] URL rejeitada (SSRF) empresa=${empresaId}`);
    return;
  }

  const payload = JSON.stringify({
    api_version: '1',
    evento,
    timestamp: timestampFortaleza(),
    empresa_id: empresaId,
    dados
  });

  const headers = { 'Content-Type': 'application/json' };
  if (webhook_secret) {
    // HMAC-SHA256 para verificação de integridade pelo receptor
    headers['X-LF-Signature'] = crypto
      .createHmac('sha256', webhook_secret)
      .update(payload)
      .digest('hex');
  }

  await fetch(webhook_url, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(8000)
  });
}

// Erros transitórios que justificam retry (rede/timeout); erros permanentes relançam imediatamente
const TRANSIENT_ERRORS = new Set(['AbortError', 'TimeoutError', 'TypeError']);

async function dispararWebhookComRetry(pool, empresaId, evento, dados) {
  try {
    await dispararWebhook(pool, empresaId, evento, dados);
  } catch (e) {
    if (!TRANSIENT_ERRORS.has(e.name)) throw e;
    // 1 retry após 5s para falhas transitórias (timeout, queda momentânea de rede)
    await new Promise((r) => setTimeout(r, 5000));
    console.warn(`[webhook-contabil] retry evento=${evento} empresa=${empresaId}`);
    await dispararWebhook(pool, empresaId, evento, dados);
  }
}

module.exports = { dispararWebhook, dispararWebhookComRetry, validarUrlWebhook };
