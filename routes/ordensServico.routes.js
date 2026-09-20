const { requirePermissao } = require('../utils/permissoes');
const { erro, ok } = require('../utils/routeHelpers');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  normalizarInt,
  normalizarDataISO
}) => {
  const router = require('express').Router();

  // ── Gera próximo número de OS para a empresa ─────────────────────────────
  async function gerarNumeroOS(empresaId, empresaNome) {
    const res = await pool.query(
      `SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(numero, '[^0-9]', '', 'g') AS INTEGER)), 0) + 1 AS prox
       FROM ordens_servico
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`,
      [empresaId, empresaNome]
    );
    const seq = String(res.rows[0].prox).padStart(4, '0');
    return `OS-${seq}`;
  }

  // ── Recalcula valor_pecas e valor_total da OS ────────────────────────────
  async function recalcularTotais(client, osId) {
    await client.query(
      `UPDATE ordens_servico
       SET valor_pecas = COALESCE((
             SELECT SUM(valor_total) FROM ordens_servico_itens WHERE os_id = $1
           ), 0),
           valor_total = valor_mao_obra + COALESCE((
             SELECT SUM(valor_total) FROM ordens_servico_itens WHERE os_id = $1
           ), 0),
           atualizado_em = NOW()
       WHERE id = $1`,
      [osId]
    );
  }

  // ── GET /ordens-servico ──────────────────────────────────────────────────
  router.get('/', auth, requirePermissao(pool, 'ordens_servico', 'ver'), async (req, res) => {
    try {
      const { empresa, status, busca, cliente_id, limit = 50, offset = 0 } = req.query;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const params = [empresaResolvida.id, empresaResolvida.nome];
      const conds  = [`(os.empresa_id = $1 OR (os.empresa_id IS NULL AND os.empresa = $2))`];
      let p = 3;

      if (status) {
        conds.push(`os.status = $${p++}`);
        params.push(status);
      }
      if (cliente_id) {
        conds.push(`os.cliente_id = $${p++}`);
        params.push(Number(cliente_id));
      }
      if (busca) {
        conds.push(`(os.numero ILIKE $${p} OR os.equipamento_marca ILIKE $${p} OR os.equipamento_modelo ILIKE $${p} OR c.nome ILIKE $${p})`);
        params.push(`%${busca}%`);
        p++;
      }

      params.push(Number(limit), Number(offset));

      const sql = `
        SELECT os.id, os.numero, os.status,
               os.equipamento_tipo, os.equipamento_marca, os.equipamento_modelo, os.equipamento_serie,
               os.tecnico, os.valor_mao_obra, os.valor_pecas, os.valor_total,
               os.data_entrada, os.data_prevista, os.data_conclusao,
               os.problema_relatado, os.criado_em,
               c.id AS cliente_id, c.nome AS cliente_nome, c.telefone AS cliente_telefone
        FROM ordens_servico os
        LEFT JOIN clientes c ON c.id = os.cliente_id
        WHERE ${conds.join(' AND ')}
        ORDER BY os.criado_em DESC
        LIMIT $${p++} OFFSET $${p++}`;

      const countSql = `
        SELECT COUNT(*) AS total
        FROM ordens_servico os
        LEFT JOIN clientes c ON c.id = os.cliente_id
        WHERE ${conds.join(' AND ')}`;

      const [rows, countRow] = await Promise.all([
        pool.query(sql, params),
        pool.query(countSql, params.slice(0, -2))
      ]);

      return ok(res, { ordens: rows.rows, total: Number(countRow.rows[0].total) });
    } catch (e) {
      console.error('[ordensServico] GET /', e);
      return erro(res, 500, 'Erro ao listar ordens de serviço');
    }
  });

  // ── POST /ordens-servico ─────────────────────────────────────────────────
  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'ordens_servico', 'criar'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text || '_ordens_servico'))`, [String(req.body.empresa_id || req.body.empresa)]);

      const { empresa, cliente_id, equipamento_tipo, equipamento_marca, equipamento_modelo,
              equipamento_serie, problema_relatado, diagnostico, servicos_realizados, tecnico,
              valor_mao_obra, data_prevista, observacoes, itens = [] } = req.body;

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);
      if (!empresaResolvida) { await client.query('ROLLBACK'); return erro(res, 403, 'Sem acesso'); }

      const numero      = await gerarNumeroOS(empresaResolvida.id, empresaResolvida.nome);
      const maoObra     = normalizarDecimal(valor_mao_obra) || 0;
      const dtPrevista  = normalizarDataISO(data_prevista)  || null;

      const osRes = await client.query(
        `INSERT INTO ordens_servico
           (numero, empresa, empresa_id, cliente_id, status,
            equipamento_tipo, equipamento_marca, equipamento_modelo, equipamento_serie,
            problema_relatado, diagnostico, servicos_realizados, tecnico,
            valor_mao_obra, data_prevista, observacoes, data_entrada, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,'aberta',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW(),NOW())
         RETURNING id`,
        [numero, empresaResolvida.nome, empresaResolvida.id,
         normalizarInt(cliente_id) || null,
         equipamento_tipo || null, equipamento_marca || null, equipamento_modelo || null, equipamento_serie || null,
         problema_relatado || null, diagnostico || null, servicos_realizados || null, tecnico || null,
         maoObra, dtPrevista, observacoes || null]
      );

      const osId = osRes.rows[0].id;

      for (const item of itens) {
        const qty = normalizarDecimal(item.quantidade) || 1;
        const vUnit = normalizarDecimal(item.valor_unitario) || 0;
        await client.query(
          `INSERT INTO ordens_servico_itens (os_id, produto_id, descricao, quantidade, valor_unitario, valor_total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [osId, normalizarInt(item.produto_id) || null, item.descricao, qty, vUnit, qty * vUnit]
        );
      }

      await recalcularTotais(client, osId);
      await client.query('COMMIT');

      const final = await pool.query(
        `SELECT os.*, c.nome AS cliente_nome FROM ordens_servico os LEFT JOIN clientes c ON c.id = os.cliente_id WHERE os.id = $1`,
        [osId]
      );
      return ok(res, { ordem: final.rows[0] }, 201);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[ordensServico] POST /', e);
      return erro(res, 500, 'Erro ao criar ordem de serviço');
    } finally {
      client.release();
    }
  });

  // ── GET /ordens-servico/:id ──────────────────────────────────────────────
  router.get('/:id', auth, requirePermissao(pool, 'ordens_servico', 'ver'), async (req, res) => {
    try {
      const id = normalizarInt(req.params.id);
      if (!id) return erro(res, 400, 'ID inválido');

      const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const osRes = await pool.query(
        `SELECT os.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone, c.cpf AS cliente_cpf, c.endereco AS cliente_endereco
         FROM ordens_servico os LEFT JOIN clientes c ON c.id = os.cliente_id
         WHERE os.id = $1 AND (os.empresa_id = $2 OR (os.empresa_id IS NULL AND os.empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (!osRes.rows[0]) return erro(res, 404, 'Ordem de serviço não encontrada');

      const itensRes = await pool.query(
        `SELECT osi.*, p.nome AS produto_nome FROM ordens_servico_itens osi
         LEFT JOIN produtos p ON p.id = osi.produto_id
         WHERE osi.os_id = $1 ORDER BY osi.id`,
        [id]
      );

      return ok(res, { ordem: osRes.rows[0], itens: itensRes.rows });
    } catch (e) {
      console.error('[ordensServico] GET /:id', e);
      return erro(res, 500, 'Erro ao buscar ordem de serviço');
    }
  });

  // ── PUT /ordens-servico/:id ──────────────────────────────────────────────
  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'ordens_servico', 'editar'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = normalizarInt(req.params.id);
      if (!id) { await client.query('ROLLBACK'); return erro(res, 400, 'ID inválido'); }

      const { empresa, cliente_id, equipamento_tipo, equipamento_marca, equipamento_modelo,
              equipamento_serie, problema_relatado, diagnostico, servicos_realizados, tecnico,
              valor_mao_obra, data_prevista, data_conclusao, observacoes, itens = [] } = req.body;

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);
      if (!empresaResolvida) { await client.query('ROLLBACK'); return erro(res, 403, 'Sem acesso'); }

      const check = await client.query(
        `SELECT id FROM ordens_servico WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (!check.rows[0]) { await client.query('ROLLBACK'); return erro(res, 404, 'Ordem de serviço não encontrada'); }

      await client.query(
        `UPDATE ordens_servico SET
           cliente_id = $1, equipamento_tipo = $2, equipamento_marca = $3, equipamento_modelo = $4,
           equipamento_serie = $5, problema_relatado = $6, diagnostico = $7, servicos_realizados = $8,
           tecnico = $9, valor_mao_obra = $10, data_prevista = $11, data_conclusao = $12,
           observacoes = $13, atualizado_em = NOW()
         WHERE id = $14`,
        [normalizarInt(cliente_id) || null,
         equipamento_tipo || null, equipamento_marca || null, equipamento_modelo || null, equipamento_serie || null,
         problema_relatado || null, diagnostico || null, servicos_realizados || null, tecnico || null,
         normalizarDecimal(valor_mao_obra) || 0,
         normalizarDataISO(data_prevista) || null,
         normalizarDataISO(data_conclusao) || null,
         observacoes || null, id]
      );

      await client.query(`DELETE FROM ordens_servico_itens WHERE os_id = $1`, [id]);
      for (const item of itens) {
        const qty  = normalizarDecimal(item.quantidade) || 1;
        const vUnit = normalizarDecimal(item.valor_unitario) || 0;
        await client.query(
          `INSERT INTO ordens_servico_itens (os_id, produto_id, descricao, quantidade, valor_unitario, valor_total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, normalizarInt(item.produto_id) || null, item.descricao, qty, vUnit, qty * vUnit]
        );
      }

      await recalcularTotais(client, id);
      await client.query('COMMIT');
      return ok(res, { mensagem: 'Ordem de serviço atualizada' });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[ordensServico] PUT /:id', e);
      return erro(res, 500, 'Erro ao atualizar ordem de serviço');
    } finally {
      client.release();
    }
  });

  // ── PATCH /ordens-servico/:id/status ─────────────────────────────────────
  router.patch('/:id/status', auth, writeRateLimiter, requirePermissao(pool, 'ordens_servico', 'editar'), async (req, res) => {
    try {
      const id = normalizarInt(req.params.id);
      if (!id) return erro(res, 400, 'ID inválido');

      const { status, empresa } = req.body;
      const statusValidos = ['aberta','diagnostico','aguardando_peca','em_execucao','pronto','entregue','cancelada'];
      if (!statusValidos.includes(status)) return erro(res, 400, 'Status inválido');

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const extra = status === 'entregue' || status === 'pronto'
        ? ', data_conclusao = NOW()'
        : '';

      const result = await pool.query(
        `UPDATE ordens_servico SET status = $1${extra}, atualizado_em = NOW()
         WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
         RETURNING id`,
        [status, id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (!result.rows[0]) return erro(res, 404, 'Ordem de serviço não encontrada');

      return ok(res, { mensagem: 'Status atualizado' });
    } catch (e) {
      console.error('[ordensServico] PATCH /:id/status', e);
      return erro(res, 500, 'Erro ao atualizar status');
    }
  });

  // ── DELETE /ordens-servico/:id ───────────────────────────────────────────
  router.delete('/:id', auth, writeRateLimiter, requirePermissao(pool, 'ordens_servico', 'deletar'), async (req, res) => {
    try {
      const id = normalizarInt(req.params.id);
      if (!id) return erro(res, 400, 'ID inválido');

      const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `DELETE FROM ordens_servico
         WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
         RETURNING id`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (!result.rows[0]) return erro(res, 404, 'Ordem de serviço não encontrada');

      return ok(res, { mensagem: 'Ordem de serviço excluída' });
    } catch (e) {
      console.error('[ordensServico] DELETE /:id', e);
      return erro(res, 500, 'Erro ao excluir ordem de serviço');
    }
  });

  return router;
};
