'use strict';
const crypto = require('crypto');

function createSharedRateLimiter(pool) {
  async function cleanup() {
    await pool.query(`DELETE FROM rate_limit_buckets WHERE bucket_key IN (
      SELECT bucket_key FROM rate_limit_buckets WHERE updated_at < NOW() - INTERVAL '48 hours'
      ORDER BY updated_at LIMIT 1000)`);
  }
  const cleanupTimer = setInterval(() => cleanup().catch(error => console.error('[rate-limit] limpeza:', error.message)), 15 * 60_000);
  cleanupTimer.unref();
  async function consume(bucketKey, windowMs, limit) {
    if (Buffer.byteLength(bucketKey) > 256) bucketKey = 'sha256:' + crypto.createHash('sha256').update(bucketKey).digest('hex');
    const result = await pool.query(
      `INSERT INTO rate_limit_buckets (bucket_key, window_started_at, request_count, updated_at)
       VALUES ($1, NOW(), 1, NOW())
       ON CONFLICT (bucket_key) DO UPDATE SET
         window_started_at = CASE
           WHEN rate_limit_buckets.window_started_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond') THEN NOW()
           ELSE rate_limit_buckets.window_started_at
         END,
         request_count = CASE
           WHEN rate_limit_buckets.window_started_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond') THEN 1
           ELSE rate_limit_buckets.request_count + 1
         END,
         updated_at = NOW()
       RETURNING request_count, window_started_at`,
      [bucketKey, windowMs]
    );
    const bucket = result.rows[0];
    return {
      allowed: bucket.request_count <= limit,
      remainingMs: Math.max(0, windowMs - (Date.now() - new Date(bucket.window_started_at).getTime())),
    };
  }

  function middleware({ key, windowMs, limit, message }) {
    return async (req, res, next) => {
      try {
        const result = await consume(key(req), windowMs, limit);
        if (result.allowed) return next();
        const retryAfter = Math.max(1, Math.ceil(result.remainingMs / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ sucesso: false, erro: message });
      } catch (error) {
        console.error('[rate-limit] shared store unavailable:', error.message);
        return res.status(503).json({ sucesso: false, erro: 'Serviço temporariamente indisponível. Tente novamente.' });
      }
    };
  }

  return { consume, middleware, cleanup };
}

module.exports = { createSharedRateLimiter };
