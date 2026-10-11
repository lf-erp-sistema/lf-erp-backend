/**
 * Migration runner — LF ERP
 * Lê arquivos .sql de /migrations, aplica apenas os não executados.
 * Tabela de controle: _migrations (criada automaticamente).
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname);

// Chave constante e documentada do advisory lock que serializa o runner entre
// instâncias concorrentes do backend (ex. deploy com múltiplas réplicas subindo
// ao mesmo tempo). hashtext() converte a string num int4 determinístico, que o
// Postgres promove implicitamente para bigint na assinatura de pg_advisory_lock
// -- mesma técnica já usada no projeto (ver PRD-M2 em produtos/criar.routes.js).
// Não altere esta string sem atualizar também quem a documenta aqui.
const MIGRATIONS_LOCK_KEY = 'lf_erp_migrations_runner';

async function runMigrations(pool) {
  // Advisory lock é ligado à SESSÃO (conexão), não à transação -- por isso usa
  // uma conexão dedicada só para o lock, mantida aberta durante toda a execução
  // (inclusive na listagem de migrations aplicadas), e liberada em finally mesmo
  // se alguma migration falhar.
  const lockClient = await pool.connect();
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [MIGRATIONS_LOCK_KEY]);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id        SERIAL PRIMARY KEY,
        filename  TEXT NOT NULL UNIQUE,
        aplicado_em TIMESTAMP DEFAULT NOW()
      )
    `);

    const arquivos = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows: aplicados } = await pool.query(`SELECT filename FROM _migrations`);
    const aplicadosSet = new Set(aplicados.map((r) => r.filename));

    const pendentes = arquivos.filter((f) => !aplicadosSet.has(f));

    if (pendentes.length === 0) {
      console.log('[migrations] Nenhuma migration pendente.');
      return;
    }

    for (const arquivo of pendentes) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, arquivo), 'utf8');
      console.log(`[migrations] Aplicando: ${arquivo}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`INSERT INTO _migrations (filename) VALUES ($1)`, [arquivo]);
        await client.query('COMMIT');
        console.log(`[migrations] OK: ${arquivo}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrations] FALHOU: ${arquivo}`, err.message);
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(`[migrations] ${pendentes.length} migration(s) aplicada(s).`);
  } finally {
    try {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [MIGRATIONS_LOCK_KEY]);
      lockClient.release();
    } catch (unlockErr) {
      // Não devolve a conexão ao pool nesse caso: client.release(err) com um
      // erro verdadeiro faz o pg descartar a conexão em vez de reutilizá-la --
      // evita que uma conexão ainda "presa" com o advisory lock volte a
      // circular no pool e bloqueie indefinidamente futuras execuções do runner.
      console.error('[migrations] Falha ao liberar advisory lock (conexão descartada):', unlockErr.message);
      lockClient.release(unlockErr);
    }
  }
}

module.exports = { runMigrations };
