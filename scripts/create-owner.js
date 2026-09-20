'use strict';
/**
 * Cria ou atualiza o usuário SaaS Owner no banco.
 * Uso: node scripts/create-owner.js <usuario> <senha>
 * Ex:  node scripts/create-owner.js LFerpOwner minhasenha123
 */
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const [,, usuario, senha] = process.argv;

if (!usuario || !senha) {
  console.error('Uso: node scripts/create-owner.js <usuario> <senha>');
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    // Busca a empresa SaaS (id menor = empresa raiz)
    const empRes = await pool.query(`SELECT id FROM empresas ORDER BY id ASC LIMIT 1`);
    const empresaId = empRes.rows[0]?.id ?? null;

    const hash = await bcrypt.hash(senha, 10);

    await pool.query(`
      INSERT INTO usuarios (usuario, senha, tipo, empresa, empresa_id, nome_completo, is_saas_owner)
      VALUES ($1, $2, 'admin', 'LF ERP', $3, 'LF ERP Owner', TRUE)
      ON CONFLICT (usuario) DO UPDATE
        SET senha = $2, tipo = 'admin', empresa_id = $3, is_saas_owner = TRUE, atualizado_em = NOW()
    `, [usuario, hash, empresaId]);

    console.log(`✅ Usuário "${usuario}" criado/atualizado como SaaS Owner.`);
  } catch (err) {
    console.error('Erro:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
