/**
 * Controle de Caixa — LF ERP
 * Montado em /caixa.
 *
 * Rotas:
 *   GET  /caixa/sessao-ativa   — sessão aberta atual (ou null)
 *   POST /caixa/abrir          — abre o caixa com saldo inicial
 *   POST /caixa/sangria        — registra retirada
 *   POST /caixa/suprimento     — registra reforço
 *   POST /caixa/fechar         — fecha o caixa com contagem final
 *   GET  /caixa/historico      — últimas sessões fechadas
 */

const { requirePermissao } = require('../utils/permissoes');
const { erro, ok } = require('../utils/routeHelpers');

module.exports = ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal }) => {
  const router = require('express').Router();



  async function getEmpresa(req) {
    return validarAcessoEmpresa(req, req.query.empresa || req.body?.empresa, req.empresa_id);
  }

  async function getSessaoAberta(empresaId) {
    const r = await pool.query(
      `SELECT * FROM caixa_sessoes WHERE empresa_id = $1 AND status = 'aberto' ORDER BY aberto_em DESC LIMIT 1`,
      [empresaId]
    );
    return r.rows[0] || null;
  }

  async function getMovimentos(sessaoId) {
    const r = await pool.query(
      `SELECT * FROM caixa_movimentos WHERE sessao_id = $1 ORDER BY criado_em ASC`,
      [sessaoId]
    );
    return r.rows.map((m) => ({ ...m, valor: Number(m.valor) }));
  }

  async function calcularSaldo(sessaoId) {
    const r = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS saldo FROM caixa_movimentos WHERE sessao_id = $1`,
      [sessaoId]
    );
    return Number(r.rows[0].saldo || 0);
  }

  // ── GET /caixa/sessao-ativa ───────────────────────────────────────────────
  router.get('/sessao-ativa', auth, requirePermissao(pool, 'caixa', 'ver'), async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const sessao = await getSessaoAberta(emp.id);
      if (!sessao) return ok(res, { sessao: null });

      const movimentos     = await getMovimentos(sessao.id);
      const saldo_calculado = await calcularSaldo(sessao.id);

      // Vendas em dinheiro/pix no período para exibição (não modifica saldo)
      const vendasResult = await pool.query(
        `SELECT COALESCE(SUM(total), 0) AS total_vendas, COUNT(*) AS qtd_vendas
         FROM vendas
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $3))
           AND data >= $2::text
           AND LOWER(COALESCE(status, 'finalizada')) != 'cancelada'
           AND LOWER(pagamento) IN ('dinheiro','pix')`,
        [emp.id, new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date(sessao.aberto_em)), emp.nome]
      );
      const vendas = vendasResult.rows[0];

      return ok(res, {
        sessao: { ...sessao, saldo_abertura: Number(sessao.saldo_abertura) },
        movimentos,
        saldo_calculado: +saldo_calculado.toFixed(2),
        vendas_dinheiro_pix: {
          total:    Number(vendas.total_vendas || 0),
          quantidade: Number(vendas.qtd_vendas || 0)
        }
      });
    } catch (err) {
      console.error('[caixa] GET sessao-ativa:', err.message);
      return erro(res, 500, 'Erro ao buscar sessão de caixa');
    }
  });

  // ── POST /caixa/abrir ────────────────────────────────────────────────────
  router.post('/abrir', auth, writeRateLimiter, requirePermissao(pool, 'caixa', 'criar'), async (req, res) => {
    let client;
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { saldo_inicial = 0, observacao } = req.body;
      const saldoInicial = normalizarDecimal(saldo_inicial) ?? 0;
      if (saldoInicial < 0) return erro(res, 400, 'Saldo inicial não pode ser negativo');

      client = await pool.connect();
      await client.query('BEGIN');

      // FOR UPDATE garante que duas requisições simultâneas não abram dois caixas
      const aberto = await client.query(
        `SELECT id FROM caixa_sessoes WHERE empresa_id = $1 AND status = 'aberto' LIMIT 1 FOR UPDATE`,
        [emp.id]
      );
      if (aberto.rowCount > 0) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Já existe um caixa aberto. Feche o caixa atual antes de abrir um novo.');
      }

      const sessaoRes = await client.query(
        `INSERT INTO caixa_sessoes (empresa_id, usuario_id, usuario_nome, saldo_abertura, observacao)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [emp.id, req.user.id, req.user.nome || req.user.usuario || null, saldoInicial, observacao || null]
      );
      const sessao = sessaoRes.rows[0];

      await client.query(
        `INSERT INTO caixa_movimentos (sessao_id, empresa_id, tipo, valor, descricao)
         VALUES ($1,$2,'abertura',$3,'Saldo de abertura')`,
        [sessao.id, emp.id, saldoInicial]
      );

      await client.query('COMMIT');
      return ok(res, { sessao, mensagem: 'Caixa aberto com sucesso' });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[caixa] POST abrir:', err.message);
      return erro(res, 500, 'Erro ao abrir caixa');
    } finally {
      if (client) client.release();
    }
  });

  // ── POST /caixa/sangria ──────────────────────────────────────────────────
  router.post('/sangria', auth, writeRateLimiter, requirePermissao(pool, 'caixa', 'criar'), async (req, res) => {
    let client;
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { valor, descricao } = req.body;
      const v = normalizarDecimal(valor);
      if (!v || v <= 0) return erro(res, 400, 'Informe um valor positivo para a sangria');

      client = await pool.connect();
      await client.query('BEGIN');
      const sessaoResult = await client.query(
        `SELECT * FROM caixa_sessoes WHERE empresa_id = $1 AND status = 'aberto' ORDER BY aberto_em DESC LIMIT 1 FOR UPDATE`,
        [emp.id]
      );
      const sessao = sessaoResult.rows[0];
      if (!sessao) { await client.query('ROLLBACK'); return erro(res, 400, 'Nenhum caixa aberto'); }

      await client.query(
        `INSERT INTO caixa_movimentos (sessao_id, empresa_id, tipo, valor, descricao)
         VALUES ($1,$2,'sangria',$3,$4)`,
        [sessao.id, emp.id, -Math.abs(v), descricao || 'Sangria de caixa']
      );

      const saldoResult = await client.query(
        `SELECT COALESCE(SUM(valor), 0) AS saldo FROM caixa_movimentos WHERE sessao_id = $1`,
        [sessao.id]
      );
      const saldo = +Number(saldoResult.rows[0].saldo || 0).toFixed(2);
      if (saldo < 0) {
        await client.query('ROLLBACK');
        return erro(res, 400, `Saldo insuficiente para sangria de R$ ${v.toFixed(2)}`);
      }
      await client.query('COMMIT');
      return ok(res, { saldo_atual: saldo, mensagem: 'Sangria registrada' });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[caixa] POST sangria:', err.message);
      return erro(res, 500, 'Erro ao registrar sangria');
    } finally {
      if (client) client.release();
    }
  });

  // ── POST /caixa/suprimento ───────────────────────────────────────────────
  router.post('/suprimento', auth, writeRateLimiter, requirePermissao(pool, 'caixa', 'criar'), async (req, res) => {
    let client;
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { valor, descricao } = req.body;
      const v = normalizarDecimal(valor);
      if (!v || v <= 0) return erro(res, 400, 'Informe um valor positivo para o suprimento');

      client = await pool.connect();
      await client.query('BEGIN');
      const sessaoResult = await client.query(
        `SELECT * FROM caixa_sessoes WHERE empresa_id = $1 AND status = 'aberto' ORDER BY aberto_em DESC LIMIT 1 FOR UPDATE`,
        [emp.id]
      );
      const sessao = sessaoResult.rows[0];
      if (!sessao) { await client.query('ROLLBACK'); return erro(res, 400, 'Nenhum caixa aberto'); }

      await client.query(
        `INSERT INTO caixa_movimentos (sessao_id, empresa_id, tipo, valor, descricao)
         VALUES ($1,$2,'suprimento',$3,$4)`,
        [sessao.id, emp.id, Math.abs(v), descricao || 'Suprimento de caixa']
      );

      const saldoResult = await client.query(
        `SELECT COALESCE(SUM(valor), 0) AS saldo FROM caixa_movimentos WHERE sessao_id = $1`,
        [sessao.id]
      );
      await client.query('COMMIT');
      return ok(res, { saldo_atual: +Number(saldoResult.rows[0].saldo || 0).toFixed(2), mensagem: 'Suprimento registrado' });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[caixa] POST suprimento:', err.message);
      return erro(res, 500, 'Erro ao registrar suprimento');
    } finally {
      if (client) client.release();
    }
  });

  // ── POST /caixa/fechar ───────────────────────────────────────────────────
  router.post('/fechar', auth, writeRateLimiter, requirePermissao(pool, 'caixa', 'criar'), async (req, res) => {
    let client;
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      client = await pool.connect();
      await client.query('BEGIN');

      // FOR UPDATE trava a sessão para evitar que dois fechamentos concorrentes
      // dupliquem o movimento de fechamento ou apliquem saldo_calculado divergente.
      const sessaoResult = await client.query(
        `SELECT * FROM caixa_sessoes WHERE empresa_id = $1 AND status = 'aberto' ORDER BY aberto_em DESC LIMIT 1 FOR UPDATE`,
        [emp.id]
      );
      const sessao = sessaoResult.rows[0];
      if (!sessao) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Nenhum caixa aberto');
      }

      const { saldo_contado, observacao } = req.body;
      const saldoContado  = normalizarDecimal(saldo_contado ?? 0);

      if (saldoContado < 0) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'saldo_contado não pode ser negativo');
      }

      const [movimentosResult, vendasResult] = await Promise.all([
        client.query(
          `SELECT COALESCE(SUM(valor), 0) AS saldo FROM caixa_movimentos WHERE sessao_id = $1`,
          [sessao.id]
        ),
        client.query(
          `SELECT COALESCE(SUM(total), 0) AS total_vendas
           FROM vendas
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $3))
             AND LOWER(COALESCE(status, 'finalizada')) != 'cancelada'
             AND criado_em >= $2
             AND LOWER(COALESCE(pagamento, 'dinheiro')) IN ('dinheiro', 'pix')`,
          [emp.id, sessao.aberto_em, emp.nome]
        )
      ]);

      const saldoMovimentos = Number(movimentosResult.rows[0].saldo || 0);
      const totalVendas     = Number(vendasResult.rows[0].total_vendas || 0);
      const saldoCalculado  = Number((saldoMovimentos + totalVendas).toFixed(2));
      const diferenca = +(saldoContado - saldoCalculado).toFixed(2);

      await client.query(
        `UPDATE caixa_sessoes SET
           status            = 'fechado',
           saldo_fechamento  = $1,
           saldo_calculado   = $2,
           diferenca         = $3,
           observacao        = COALESCE($4, observacao),
           fechado_em        = NOW() AT TIME ZONE 'America/Fortaleza'
         WHERE id = $5`,
        [saldoContado, +saldoCalculado.toFixed(2), diferenca, observacao || null, sessao.id]
      );

      // Registra movimento de fechamento
      await client.query(
        `INSERT INTO caixa_movimentos (sessao_id, empresa_id, tipo, valor, descricao)
         VALUES ($1,$2,'fechamento',0,'Fechamento do caixa')`,
        [sessao.id, emp.id]
      );

      await client.query('COMMIT');

      return ok(res, {
        sessao_id:       sessao.id,
        saldo_calculado: +saldoCalculado.toFixed(2),
        saldo_contado:   saldoContado,
        diferenca,
        mensagem: 'Caixa fechado com sucesso'
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[caixa] POST fechar:', err.message);
      return erro(res, 500, 'Erro ao fechar caixa');
    } finally {
      if (client) client.release();
    }
  });

  // ── GET /caixa/historico ─────────────────────────────────────────────────
  router.get('/historico', auth, requirePermissao(pool, 'caixa', 'ver'), async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT * FROM caixa_sessoes
         WHERE empresa_id = $1
         ORDER BY aberto_em DESC
         LIMIT 30`,
        [emp.id]
      );

      return ok(res, {
        sessoes: result.rows.map((s) => ({
          ...s,
          saldo_abertura:   Number(s.saldo_abertura   || 0),
          saldo_fechamento: Number(s.saldo_fechamento || 0),
          saldo_calculado:  Number(s.saldo_calculado  || 0),
          diferenca:        Number(s.diferenca        || 0)
        }))
      });
    } catch (err) {
      console.error('[caixa] GET historico:', err.message);
      return erro(res, 500, 'Erro ao buscar histórico de caixa');
    }
  });

  return router;
};
