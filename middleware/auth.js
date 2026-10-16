'use strict';

const jwt    = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const SECRET        = process.env.JWT_SECRET;
const JWT_EXPIRY_MS = 12 * 60 * 60 * 1000;

const tokenBlacklist = new Map();
const _sseNonces     = new Map();

function _tokenHash(tok) {
  return crypto.createHash('sha256').update(tok).digest('hex');
}

setInterval(() => {
  const limite = Date.now() - JWT_EXPIRY_MS;
  for (const [hash, ts] of tokenBlacklist) {
    if (ts < limite) tokenBlacklist.delete(hash);
  }
}, 60 * 60 * 1000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _sseNonces) { if (v.expiry < now) _sseNonces.delete(k); }
}, 30_000).unref();

// Limpa blacklist do banco periodicamente (registrado após loadBlacklistFromDb ser chamado)
let _dbCleanupStarted = false;
function _startDbCleanup(pool) {
  if (_dbCleanupStarted) return;
  _dbCleanupStarted = true;
  setInterval(() => {
    pool.query('DELETE FROM jwt_blacklist WHERE expires_at < NOW()').catch(() => {});
  }, 60 * 60 * 1000).unref();
}

async function loadBlacklistFromDb(pool) {
  _startDbCleanup(pool);
  try {
    const result = await pool.query(
      `SELECT token_hash, revoked_at FROM jwt_blacklist WHERE expires_at > NOW()`
    );
    for (const row of result.rows) {
      tokenBlacklist.set(row.token_hash, new Date(row.revoked_at).getTime());
    }
    if (result.rowCount > 0) {
      console.log(`[blacklist] ${result.rowCount} tokens carregados do banco`);
    }
  } catch (e) {
    console.warn('[blacklist] Falha ao carregar do banco:', e.message);
  }
}

function auth(req, res, next) {
  let authHeader = req.headers.authorization;

  if (!authHeader && req.method === 'GET' && req.path === '/sse-notificacoes') {
    const nonce = req.query.nonce;
    if (nonce && _sseNonces.has(nonce)) {
      const entry = _sseNonces.get(nonce);
      if (entry.expiry >= Date.now()) authHeader = `Bearer ${entry.token}`;
      _sseNonces.delete(nonce);
    }
  }

  if (!authHeader) {
    return res.status(403).json({ sucesso: false, erro: 'Sem acesso', codigo: 'SEM_TOKEN' });
  }

  let token = authHeader;
  if (authHeader.startsWith('Bearer ')) token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(403).json({ sucesso: false, erro: 'Token inválido', codigo: 'TOKEN_INVALIDO' });
  }

  if (tokenBlacklist.has(_tokenHash(token))) {
    return res.status(403).json({ sucesso: false, erro: 'Token revogado', codigo: 'TOKEN_REVOGADO' });
  }

  try {
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    req.user = decoded;
    req.empresa_id   = decoded.empresa_id != null ? Number(decoded.empresa_id) : null;
    req.empresa_nome = decoded.empresa_nome || decoded.empresa || null;

    if (!req.user?.id || !req.user?.tipo) {
      return res.status(403).json({ sucesso: false, erro: 'Token inválido', codigo: 'TOKEN_INVALIDO' });
    }
    if (!req.user.is_saas_owner && req.empresa_id == null) {
      return res.status(403).json({ sucesso: false, erro: 'Empresa não identificada no token', codigo: 'EMPRESA_NAO_IDENTIFICADA' });
    }
    next();
  } catch {
    return res.status(403).json({ sucesso: false, erro: 'Token inválido ou expirado', codigo: 'TOKEN_EXPIRADO' });
  }
}

function apenasAdmin(req, res, next) {
  if (!req.user.is_saas_owner) {
    return res.status(403).json({ sucesso: false, erro: 'Acesso restrito ao SaaS Owner', codigo: 'SEM_PERMISSAO' });
  }
  next();
}

// Retorna factory que recebe pool para manter assinatura validarSenhaUsuario(senha, user)
function createAuthHelpers(pool) {
  async function validarSenhaUsuario(senhaInformada, user) {
    const senhaSalva = String(user?.senha || '');
    if (!senhaSalva) return false;

    const pareceHashBcrypt =
      senhaSalva.startsWith('$2a$') || senhaSalva.startsWith('$2b$') || senhaSalva.startsWith('$2y$');

    if (pareceHashBcrypt) return bcrypt.compare(senhaInformada, senhaSalva);

    const bufA = Buffer.from(senhaInformada);
    const bufB = Buffer.from(senhaSalva);
    const iguais = bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);

    if (iguais) {
      const novaHash = await bcrypt.hash(senhaInformada, 10);
      try {
        await pool.query(
          `UPDATE usuarios SET senha = $1, atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza' WHERE id = $2`,
          [novaHash, user.id]
        );
      } catch (e) { console.error('[validarSenhaUsuario] erro ao migrar hash:', e.message); }
      return true;
    }

    return false;
  }

  return { validarSenhaUsuario };
}

function validarForcaSenha(senha) {
  if (!senha || senha.length < 8) return { valido: false, mensagem: 'A senha deve ter pelo menos 8 caracteres.' };
  if (senha.length > 72)          return { valido: false, mensagem: 'A senha deve ter no máximo 72 caracteres.' };
  if (!/[A-Z]/.test(senha))      return { valido: false, mensagem: 'A senha deve conter pelo menos uma letra maiúscula.' };
  if (!/[0-9]/.test(senha))      return { valido: false, mensagem: 'A senha deve conter pelo menos um número.' };
  return { valido: true };
}

module.exports = {
  SECRET,
  JWT_EXPIRY_MS,
  tokenBlacklist,
  _tokenHash,
  _sseNonces,
  loadBlacklistFromDb,
  auth,
  apenasAdmin,
  createAuthHelpers,
  validarForcaSenha
};
