/**
 * Programa de Fidelidade — LF ERP
 * Pontos por compra, resgate como desconto, ranking e extrato por cliente.
 *
 * GET    /fidelidade/config              — regras do programa
 * PUT    /fidelidade/config              — salvar regras
 * GET    /fidelidade/dashboard           — KPIs
 * GET    /fidelidade/clientes            — ranking de clientes por pontos
 * GET    /fidelidade/clientes/:id/extrato — extrato de pontos do cliente
 * POST   /fidelidade/acumular            — acumular pontos manualmente
 * POST   /fidelidade/resgatar            — resgatar pontos (retorna valor de desconto)
 * POST   /fidelidade/ajustar             — ajuste manual (admin)
 * POST   /fidelidade/expirar             — expira pontos vencidos (processar expiração)
 */

const { acumularPontosFidelidade } = require('../utils/fidelidade');
const { erro, ok } = require('../utils/routeHelpers');

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, hoje, requirePermissao }) {
  const router = require('express').Router();


  async function emp(req)               { return validarAcessoEmpresa(req, null, req.empresa_id); }

  async function getCfg(empresaId) {
    const r = await pool.query(`SELECT * FROM fidelidade_config WHERE empresa_id = $1`, [empresaId]);
    return r.rows[0] || null;
  }

  // ── Config ────────────────────────────────────────────────────────────────

  router.get('/config', auth, requirePermissao(pool, 'fidelidade', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');
      const cfg = await getCfg(e.id);
      return ok(res, {
        config: cfg || {
          ativo: false, nome_programa: 'Programa de Fidelidade',
          pontos_por_real: 1, reais_por_ponto: 0.05, validade_dias: 365, minimo_resgate: 100
        }
      });
    } catch (err) { return erro(res, 500, 'Erro ao buscar configuração'); }
  });

  router.put('/config', auth, requirePermissao(pool, 'fidelidade', 'configurar'), writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { ativo, nome_programa, pontos_por_real, reais_por_ponto, validade_dias, minimo_resgate } = req.body;

      await pool.query(
        `INSERT INTO fidelidade_config
           (empresa_id, ativo, nome_programa, pontos_por_real, reais_por_ponto, validade_dias, minimo_resgate, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (empresa_id) DO UPDATE SET
           ativo           = $2,
           nome_programa   = COALESCE(NULLIF($3,''), fidelidade_config.nome_programa),
           pontos_por_real = COALESCE($4, fidelidade_config.pontos_por_real),
           reais_por_ponto = COALESCE($5, fidelidade_config.reais_por_ponto),
           validade_dias   = COALESCE($6, fidelidade_config.validade_dias),
           minimo_resgate  = COALESCE($7, fidelidade_config.minimo_resgate),
           atualizado_em   = NOW()`,
        [
          e.id,
          ativo !== false,
          nome_programa?.trim() || null,
          pontos_por_real != null ? normalizarDecimal(pontos_por_real) : null,
          reais_por_ponto != null ? normalizarDecimal(reais_por_ponto) : null,
          validade_dias   != null ? normalizarInt(validade_dias)       : null,
          minimo_resgate  != null ? normalizarInt(minimo_resgate)      : null
        ]
      );

      return ok(res, { mensagem: 'Configuração salva' });
    } catch (err) {
      console.error('[fidelidade] PUT config:', err.message);
      return erro(res, 500, 'Erro ao salvar configuração');
    }
  });

  // ── Dashboard ─────────────────────────────────────────────────────────────

  router.get('/dashboard', auth, requirePermissao(pool, 'fidelidade', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const [statsResult, topResult, movMesResult] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE pontos_fidelidade > 0)          AS clientes_com_pontos,
             COALESCE(SUM(pontos_fidelidade), 0)                    AS total_pontos_circulacao,
             COUNT(*) FILTER (WHERE pontos_fidelidade >= 100)       AS clientes_prontos_resgatar
           FROM clientes WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND deletado_em IS NULL`,
          [e.id, e.nome]
        ),
        pool.query(
          `SELECT nome, pontos_fidelidade FROM clientes
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND pontos_fidelidade > 0 AND deletado_em IS NULL
           ORDER BY pontos_fidelidade DESC LIMIT 5`,
          [e.id, e.nome]
        ),
        pool.query(
          `SELECT tipo, COUNT(*) AS total, COALESCE(SUM(ABS(pontos)),0) AS pontos_total
           FROM fidelidade_movimentos
           WHERE empresa_id = $1 AND DATE_TRUNC('month', criado_em) = DATE_TRUNC('month', NOW())
           GROUP BY tipo`,
          [e.id]
        )
      ]);

      const movMes = {};
      for (const row of movMesResult.rows) movMes[row.tipo] = { total: Number(row.total), pontos: Number(row.pontos_total) };

      return ok(res, {
        clientes_com_pontos:      Number(statsResult.rows[0].clientes_com_pontos),
        total_pontos_circulacao:  Number(statsResult.rows[0].total_pontos_circulacao),
        clientes_prontos_resgatar: Number(statsResult.rows[0].clientes_prontos_resgatar),
        top_clientes:  topResult.rows,
        movimentos_mes: movMes
      });
    } catch (err) {
      console.error('[fidelidade] dashboard:', err.message);
      return erro(res, 500, 'Erro ao carregar dashboard');
    }
  });

  // ── Ranking de clientes ───────────────────────────────────────────────────

  router.get('/clientes', auth, requirePermissao(pool, 'fidelidade', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { busca } = req.query;
      const params = [e.id, e.nome];
      let where = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND pontos_fidelidade > 0 AND deletado_em IS NULL`;
      if (busca) { params.push(`%${busca.replace(/[%_]/g, '\\$&')}%`); where += ` AND nome ILIKE $${params.length} ESCAPE '\\'`; }

      const result = await pool.query(
        `SELECT id, nome, telefone, email, pontos_fidelidade
         FROM clientes ${where}
         ORDER BY pontos_fidelidade DESC LIMIT 200`,
        params
      );
      return ok(res, { clientes: result.rows });
    } catch (err) { return erro(res, 500, 'Erro ao listar clientes'); }
  });

  // ── Extrato do cliente ────────────────────────────────────────────────────

  router.get('/clientes/:id/extrato', auth, requirePermissao(pool, 'fidelidade', 'ver'), async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const clienteId = Number(req.params.id);

      const [cliResult, movResult, cfgResult] = await Promise.all([
        pool.query(
          `SELECT id, nome, telefone, email, pontos_fidelidade FROM clientes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [clienteId, e.id, e.nome]
        ),
        pool.query(
          `SELECT * FROM fidelidade_movimentos WHERE empresa_id = $1 AND cliente_id = $2 ORDER BY criado_em DESC LIMIT 100`,
          [e.id, clienteId]
        ),
        getCfg(e.id)
      ]);

      if (cliResult.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');

      const cli = cliResult.rows[0];
      const valorResgate = cfgResult
        ? Number((cli.pontos_fidelidade * Number(cfgResult.reais_por_ponto)).toFixed(2))
        : 0;

      return ok(res, {
        cliente: cli,
        valor_resgate: valorResgate,
        movimentos: movResult.rows
      });
    } catch (err) { return erro(res, 500, 'Erro ao buscar extrato'); }
  });

  // ── Acumular manualmente ──────────────────────────────────────────────────

  router.post('/acumular', auth, requirePermissao(pool, 'fidelidade', 'acumular'), writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { cliente_id, pontos, descricao, venda_id } = req.body;
      if (!cliente_id || !pontos) return erro(res, 400, 'cliente_id e pontos são obrigatórios');
      const qtd = normalizarInt(pontos);
      if (qtd <= 0) return erro(res, 400, 'Pontos deve ser positivo');

      const cfg = await getCfg(e.id);
      if (!cfg?.ativo) return erro(res, 400, 'Programa de fidelidade não está ativo');

      // cliente_id não era validado contra a empresa antes de acumular
      // (achado D2-SEC-002) — mesma checagem já usada em /resgatar.
      const clienteCheck = await pool.query(
        `SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2`,
        [Number(cliente_id), e.id]
      );
      if (clienteCheck.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');

      await acumularPontosFidelidade(pool, {
        empresaId: e.id,
        clienteId: Number(cliente_id),
        vendaId:   venda_id || null,
        totalVenda: qtd / (cfg.pontos_por_real || 1)
      });

      return ok(res, { mensagem: `${qtd} pontos acumulados` });
    } catch (err) {
      console.error('[fidelidade] POST acumular:', err.message);
      return erro(res, 500, 'Erro ao acumular pontos');
    }
  });

  // ── Resgatar pontos ───────────────────────────────────────────────────────

  router.post('/resgatar', auth, requirePermissao(pool, 'fidelidade', 'resgatar'), writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { cliente_id, pontos, venda_id } = req.body;
      if (!cliente_id || !pontos) return erro(res, 400, 'cliente_id e pontos são obrigatórios');

      const cfg = await getCfg(e.id);
      if (!cfg?.ativo) return erro(res, 400, 'Programa de fidelidade não está ativo');

      const qtd = normalizarInt(pontos);
      if (qtd < cfg.minimo_resgate) return erro(res, 400, `Mínimo de ${cfg.minimo_resgate} pontos para resgatar`);

      const valorDesconto = Number((qtd * Number(cfg.reais_por_ponto)).toFixed(2));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // FOR UPDATE previne race condition em resgates simultâneos
        const cliResult = await client.query(
          `SELECT id, nome, pontos_fidelidade FROM clientes WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
          [Number(cliente_id), e.id]
        );
        if (cliResult.rowCount === 0) { await client.query('ROLLBACK'); return erro(res, 404, 'Cliente não encontrado'); }

        const cli = cliResult.rows[0];
        if (cli.pontos_fidelidade < qtd) {
          await client.query('ROLLBACK');
          return erro(res, 400, `Saldo insuficiente. Disponível: ${cli.pontos_fidelidade} pontos`);
        }

        // WHERE pontos_fidelidade >= $1 garante atomicidade mesmo em concorrência
        const updRes = await client.query(
          `UPDATE clientes SET pontos_fidelidade = pontos_fidelidade - $1, atualizado_em = NOW()
           WHERE id = $2 AND pontos_fidelidade >= $1
           RETURNING pontos_fidelidade`,
          [qtd, cli.id]
        );
        if (updRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return erro(res, 400, 'Saldo insuficiente');
        }

        const novoSaldo = updRes.rows[0].pontos_fidelidade;

        await client.query(
          `INSERT INTO fidelidade_movimentos
             (empresa_id, cliente_id, tipo, pontos, saldo_apos, descricao, referencia_tipo, referencia_id)
           VALUES ($1,$2,'debito',$3,$4,$5,'resgate',$6)`,
          [e.id, cli.id, -qtd, novoSaldo, `-${qtd} pontos resgatados = R$ ${valorDesconto.toFixed(2)} de desconto`, venda_id || null]
        );

        await client.query('COMMIT');
        return ok(res, {
          pontos_resgatados: qtd,
          valor_desconto:    valorDesconto,
          saldo_restante:    novoSaldo,
          mensagem: `${qtd} pontos resgatados = R$ ${valorDesconto.toFixed(2)} de desconto`
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[fidelidade] POST resgatar:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  // ── Ajuste manual ─────────────────────────────────────────────────────────

  router.post('/ajustar', auth, requirePermissao(pool, 'fidelidade', 'ajustar'), writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      if (!['admin', 'gerente'].includes(req.user?.papel)) return erro(res, 403, 'Apenas administradores e gerentes podem ajustar pontos manualmente');

      const { cliente_id, pontos, descricao } = req.body;
      if (!cliente_id || pontos == null) return erro(res, 400, 'cliente_id e pontos são obrigatórios');

      const qtd = normalizarInt(pontos);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const upd = await client.query(
          `UPDATE clientes SET pontos_fidelidade = GREATEST(0, COALESCE(pontos_fidelidade,0) + $1), atualizado_em = NOW()
           WHERE id = $2 AND empresa_id = $3`,
          [qtd, Number(cliente_id), e.id]
        );
        if (upd.rowCount === 0) {
          await client.query('ROLLBACK');
          return erro(res, 404, 'Cliente não encontrado');
        }

        const saldoRes = await client.query(`SELECT pontos_fidelidade FROM clientes WHERE id = $1 AND empresa_id = $2`, [Number(cliente_id), e.id]);
        const saldo = saldoRes.rows[0]?.pontos_fidelidade || 0;

        await client.query(
          `INSERT INTO fidelidade_movimentos
             (empresa_id, cliente_id, tipo, pontos, saldo_apos, descricao, referencia_tipo)
           VALUES ($1,$2,'ajuste',$3,$4,$5,'ajuste')`,
          [e.id, Number(cliente_id), qtd, saldo, descricao?.trim() || `Ajuste manual: ${qtd > 0 ? '+' : ''}${qtd} pontos`]
        );

        await client.query('COMMIT');
        return ok(res, { novo_saldo: saldo, mensagem: 'Ajuste realizado' });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) { return erro(res, 500, 'Erro ao ajustar pontos de fidelidade'); }
  });

  // ── Processar expiração ───────────────────────────────────────────────────

  router.post('/expirar', auth, requirePermissao(pool, 'fidelidade', 'configurar'), writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const hojeStr = hoje();

      // Pontos expirados hoje ou antes, processados individualmente por movimento (idempotência via referencia_id)
      const vencidosResult = await pool.query(
        `SELECT id, cliente_id, ABS(pontos) AS pontos_a_expirar
         FROM fidelidade_movimentos
         WHERE empresa_id = $1 AND tipo = 'credito' AND pontos > 0 AND expira_em <= $2
           AND NOT EXISTS (
             SELECT 1 FROM fidelidade_movimentos e2
             WHERE e2.empresa_id = $1
               AND e2.tipo = 'expiracao'
               AND e2.referencia_id = fidelidade_movimentos.id
           )`,
        [e.id, hojeStr]
      );

      let expirados = 0;
      const clientFid = await pool.connect();
      try {
        for (const row of vencidosResult.rows) {
          try {
            await clientFid.query('BEGIN');
            const saldoRes = await clientFid.query(
              `SELECT COALESCE(pontos_fidelidade,0) AS p FROM clientes WHERE id=$1 AND empresa_id=$2 FOR UPDATE`,
              [row.cliente_id, e.id]
            );
            const pontosBaixar = Math.min(Number(row.pontos_a_expirar), saldoRes.rows[0]?.p || 0);
            if (pontosBaixar <= 0) { await clientFid.query('ROLLBACK'); continue; }

            await clientFid.query(
              `UPDATE clientes SET pontos_fidelidade = GREATEST(0, pontos_fidelidade - $1), atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3`,
              [pontosBaixar, row.cliente_id, e.id]
            );
            const novoSaldo = (saldoRes.rows[0]?.p || 0) - pontosBaixar;
            // CF-C1: salvar referencia_id para garantir idempotência nas próximas execuções
            await clientFid.query(
              `INSERT INTO fidelidade_movimentos (empresa_id, cliente_id, tipo, pontos, saldo_apos, descricao, referencia_tipo, referencia_id)
               VALUES ($1,$2,'expiracao',$3,$4,'Pontos expirados por prazo de validade','expiracao',$5)`,
              [e.id, row.cliente_id, -pontosBaixar, novoSaldo, row.id]
            );
            await clientFid.query('COMMIT');
            expirados++;
          } catch (expErr) {
            await clientFid.query('ROLLBACK');
            console.error('[fidelidade] expirar cliente', row.cliente_id, expErr.message);
          }
        }
      } finally {
        clientFid.release();
      }

      return ok(res, { clientes_processados: expirados, mensagem: `${expirados} cliente(s) com pontos expirados processados` });
    } catch (err) {
      console.error('[fidelidade] POST expirar:', err.message);
      return erro(res, 500, 'Erro interno');
    }
  });

  return router;
};
