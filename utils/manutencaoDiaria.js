'use strict';
function createManutencaoDiaria({ pool, hoje, atualizarReceber, atualizarPagar }) {
  return async function executar() {
    const client = await pool.connect();
    let locked = false;
    try {
      const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext('lf_erp_manutencao_diaria')) AS locked`);
      locked = Boolean(lock.rows[0]?.locked);
      if (!locked) return false;
      const data = hoje();
      const ultima = await client.query(`SELECT ultima_data FROM manutencao_execucoes WHERE tarefa = 'financeiro'`);
      if (ultima.rows[0]?.ultima_data === data) return false;
      const empresas = await client.query('SELECT id, nome FROM empresas ORDER BY id');
      // Uma empresa de cada vez: a conexão do lock não disputa o pool com um lote inteiro.
      for (const empresa of empresas.rows) {
        if (await atualizarReceber(empresa.nome, empresa.id) === false) throw new Error('Atualização a receber concorrente; tentar novamente');
        if (await atualizarPagar(empresa.nome, empresa.id) === false) throw new Error('Atualização a pagar concorrente; tentar novamente');
      }
      await client.query(`INSERT INTO manutencao_execucoes (tarefa, ultima_data, concluido_em)
        VALUES ('financeiro', $1, NOW()) ON CONFLICT (tarefa) DO UPDATE
        SET ultima_data = EXCLUDED.ultima_data, concluido_em = NOW()`, [data]);
      return true;
    } finally {
      if (locked) {
        try { await client.query(`SELECT pg_advisory_unlock(hashtext('lf_erp_manutencao_diaria'))`); }
        catch (error) { client.release(error); throw error; }
      }
      client.release();
    }
  };
}
module.exports = { createManutencaoDiaria };
