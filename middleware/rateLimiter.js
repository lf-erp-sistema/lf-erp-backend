'use strict';

const { createSharedRateLimiter } = require('../utils/sharedRateLimiter');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const WRITE_WINDOW_MS = 60 * 1000;

function createRateLimiters(pool) {
  const shared = createSharedRateLimiter(pool);
  const ip = (req) => req.ip || req.connection?.remoteAddress || 'unknown';

  const byLoginIp = shared.middleware({
    key: (req) => `login:ip:${ip(req)}`,
    windowMs: LOGIN_WINDOW_MS,
    limit: 10,
    message: 'Muitas tentativas de login. Tente novamente em alguns minutos.',
  });
  const byLoginUser = shared.middleware({
    key: (req) => `login:user:${String(req.body?.usuario || '').toLowerCase().trim()}`,
    windowMs: LOGIN_WINDOW_MS,
    limit: 15,
    message: 'Muitas tentativas para este usuário. Tente novamente em alguns minutos.',
  });

  async function loginRateLimiter(req, res, next) {
    await byLoginIp(req, res, async () => {
      if (!req.body?.usuario) return next();
      await byLoginUser(req, res, next);
    });
  }

  const writeRateLimiter = shared.middleware({
    key: (req) => `write:${req.user?.id || ip(req)}:${req.method}:${req.route?.path || req.path}`,
    windowMs: WRITE_WINDOW_MS,
    limit: 30,
    message: 'Muitas requisições. Aguarde um momento e tente novamente.',
  });

  return { loginRateLimiter, writeRateLimiter };
}

module.exports = { createRateLimiters };
