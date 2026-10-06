const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

if (!process.env.PIX_ENCRYPTION_KEY) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[pixCrypto] PIX_ENCRYPTION_KEY ausente em produção — abortando para evitar armazenar credenciais PIX em texto puro.');
    process.exit(1);
  }
  console.warn('[pixCrypto] PIX_ENCRYPTION_KEY ausente — dados PIX em texto puro (ok fora de produção). Configure a variável antes de ir para produção.');
}

function getKey() {
  const hex = process.env.PIX_ENCRYPTION_KEY;
  if (!hex) return null;
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('PIX_ENCRYPTION_KEY deve ter 64 hex chars (32 bytes)');
  return key;
}

// Criptografa um campo sensível do PIX. Se PIX_ENCRYPTION_KEY não estiver
// configurada, retorna o valor original sem criptografar (compatibilidade gradual).
function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const str = String(plaintext);
  if (str.startsWith(PREFIX)) return str; // já criptografado

  const key = getKey();
  if (!key) return str; // chave não configurada — mantém texto puro

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('base64')}`;
}

// Descriptografa um campo. Se não começar com enc:v1:, retorna como está
// (suporte a dados legados em texto puro gravados antes da criptografia).
// Lança erro se o formato for inválido ou a chave estiver ausente/errada —
// nunca retorna silenciosamente o texto criptografado para o chamador.
function decryptField(value) {
  if (value === null || value === undefined) return value;
  const str = String(value);
  if (!str.startsWith(PREFIX)) return str; // texto puro ou dado legado

  const key = getKey();
  if (!key) throw new Error('PIX_ENCRYPTION_KEY não configurada — não é possível descriptografar credencial PIX');

  const parts = str.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Formato de campo PIX criptografado inválido');

  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts[2], 'base64');

  if (iv.length !== 12) throw new Error('IV inválido no campo PIX criptografado');
  if (tag.length !== 16) throw new Error('AuthTag inválido no campo PIX criptografado');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encryptField, decryptField };
