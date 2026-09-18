/**
 * Portal do Cliente — LF ERP
 * Acesso externo para clientes consultarem seus títulos e histórico.
 *
 * Rotas públicas:
 *   POST /portal/login                — autenticar cliente (CPF/CNPJ + senha)
 *
 * Rotas protegidas (authCliente):
 *   GET  /portal/resumo               — saldo aberto, atrasados, último acesso
 *   GET  /portal/titulos              — contas a receber do cliente
 *   GET  /portal/vendas               — histórico de vendas do cliente
 *
 * Rotas admin (auth ERP):
 *   POST /portal/admin/clientes/:id/senha   — define/redefine senha do portal
 *   PATCH /portal/admin/clientes/:id/toggle — ativa ou desativa acesso ao portal
 */

const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');

const SECRET        = process.env.JWT_SECRET;
const PORTAL_SECRET = (SECRET || '') + '_portal_v1';
const SALT_ROUNDS   = 10;

if (!process.env.JWT_SECRET) {
  console.error('[portal] FATAL: JWT_SECRET não configurado. Tokens gerados sem segredo.');
}

const { requirePermissao } = require('../utils/permissoes');
const { erro, ok } = require('../utils/routeHelpers');

module.exports = ({ auth, writeRateLimiter, pool }) => {
  const router = require('express').Router();



  // ── Rate limiter por IP para login do portal (10 req/min) ─────────────────
  const _portalLoginBuckets = new Map();
  const PORTAL_LOGIN_MAP_MAX = 10000;
  function portalLoginRateLimiter(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const bucket = _portalLoginBuckets.get(key) || { count: 0, resetAt: now + 60_000 };
    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60_000; }
    bucket.count++;
    _portalLoginBuckets.set(key, bucket);
    if (_portalLoginBuckets.size > PORTAL_LOGIN_MAP_MAX) {
      for (const [k, b] of _portalLoginBuckets) { if (Date.now() > b.resetAt) _portalLoginBuckets.delete(k); }
    }
    if (bucket.count > 10) return erro(res, 429, 'Muitas tentativas. Aguarde 1 minuto.');
    next();
  }

  // ── Rate limiter por cliente para consultas do portal (60 req/min) ────────
  // Protege contra scraping de dados financeiros caso um token JWT seja comprometido
  const _portalConsultaBuckets = new Map();
  const PORTAL_CONSULTA_MAP_MAX = 10000;
  function portalConsultaRateLimiter(req, res, next) {
    const key = req.cliente?.id || req.ip || 'unknown';
    const now = Date.now();
    const bucket = _portalConsultaBuckets.get(key) || { count: 0, resetAt: now + 60_000 };
    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60_000; }
    bucket.count++;
    _portalConsultaBuckets.set(key, bucket);
    if (_portalConsultaBuckets.size > PORTAL_CONSULTA_MAP_MAX) {
      for (const [k, b] of _portalConsultaBuckets) { if (Date.now() > b.resetAt) _portalConsultaBuckets.delete(k); }
    }
    if (bucket.count > 60) return erro(res, 429, 'Muitas requisições. Aguarde 1 minuto.');
    next();
  }

  // ── Middleware exclusivo para tokens de cliente ───────────────────────────
  async function authCliente(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!token) return erro(res, 403, 'Sem acesso');

    try {
      const decoded = jwt.verify(token, PORTAL_SECRET);
      if (decoded.tipo !== 'cliente') return erro(res, 403, 'Acesso não autorizado');

      // Verificar portal_ativo a cada request para respeitar revogação imediata
      const check = await pool.query(`SELECT portal_ativo FROM clientes WHERE id = $1`, [decoded.id]);
      if (!check.rowCount || !check.rows[0].portal_ativo) {
        return erro(res, 403, 'Acesso ao portal desativado');
      }

      req.cliente = decoded;
      next();
    } catch (e) {
      if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
        return erro(res, 403, 'Token inválido ou expirado');
      }
      console.error('[portal] authCliente:', e.message);
      return erro(res, 500, 'Erro ao validar acesso');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /portal/login
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/login', portalLoginRateLimiter, async (req, res) => {
    try {
      const { cpf_cnpj, senha, empresa_id: empresaIdLogin } = req.body;
      if (!cpf_cnpj || !senha) return erro(res, 400, 'Informe CPF/CNPJ e senha');

      const cleanDoc = String(cpf_cnpj).replace(/\D/g, '');
      if (cleanDoc.length < 11) return erro(res, 400, 'CPF/CNPJ inválido');

      let result;
      if (empresaIdLogin) {
        result = await pool.query(
          `SELECT c.*, e.nome AS empresa_nome
           FROM clientes c
           JOIN empresas e ON e.id = c.empresa_id
           WHERE c.portal_ativo = true
             AND c.senha_portal IS NOT NULL
             AND REGEXP_REPLACE(COALESCE(c.cpf_cnpj, ''), '[^0-9]', '', 'g') = $1
             AND c.empresa_id = $2`,
          [cleanDoc, Number(empresaIdLogin)]
        );
      } else {
        result = await pool.query(
          `SELECT c.*, e.nome AS empresa_nome
           FROM clientes c
           JOIN empresas e ON e.id = c.empresa_id
           WHERE c.portal_ativo = true
             AND c.senha_portal IS NOT NULL
             AND REGEXP_REPLACE(COALESCE(c.cpf_cnpj, ''), '[^0-9]', '', 'g') = $1`,
          [cleanDoc]
        );
      }

      if (result.rowCount === 0) {
        // Dummy compare para equalizar tempo de resposta e evitar timing oracle
        await bcrypt.compare(senha, '$2b$12$GhvMmNVjRW29ulnudl.LbuAnUtN/LRfe1JsBm1Wf3K.7PZVFSNa3u');
        return erro(res, 401, 'Credenciais inválidas');
      }

      if (result.rowCount > 1) {
        return erro(res, 409, 'CPF/CNPJ registrado em mais de uma empresa. Informe o campo empresa_id.');
      }

      const cliente = result.rows[0];
      const senhaOk = await bcrypt.compare(senha, cliente.senha_portal);
      if (!senhaOk) return erro(res, 401, 'Credenciais inválidas');

      await pool.query(
        `UPDATE clientes SET portal_ultimo_acesso = NOW() AT TIME ZONE 'America/Fortaleza' WHERE id = $1`,
        [cliente.id]
      );

      const token = jwt.sign(
        {
          id:           cliente.id,
          tipo:         'cliente',
          nome:         cliente.nome,
          empresa_id:   cliente.empresa_id,
          empresa_nome: cliente.empresa_nome
        },
        PORTAL_SECRET,
        { expiresIn: '12h' }
      );

      return ok(res, {
        token,
        cliente: {
          id:      cliente.id,
          nome:    cliente.nome,
          empresa: cliente.empresa_nome
        }
      });
    } catch (err) {
      console.error('[portal] POST login:', err.message);
      return erro(res, 500, 'Erro ao autenticar');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /portal/resumo
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/resumo', authCliente, portalConsultaRateLimiter, async (req, res) => {
    try {
      const { id: clienteId, empresa_id: empresaId, empresa_nome: empresaNome } = req.cliente;

      const result = await pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN LOWER(status) IN ('pendente','parcial') THEN COALESCE(valor_atualizado, valor) ELSE 0 END), 0)     AS total_aberto,
           COALESCE(SUM(CASE WHEN LOWER(status) IN ('atrasado','parcial_atrasado') THEN COALESCE(valor_atualizado, valor) ELSE 0 END), 0) AS total_atrasado,
           COALESCE(SUM(CASE WHEN LOWER(status) = 'pago' THEN valor ELSE 0 END), 0)                      AS total_pago,
           COUNT(CASE WHEN LOWER(status) IN ('pendente','parcial','atrasado','parcial_atrasado') THEN 1 END) AS total_titulos_abertos
         FROM contas_receber
         WHERE cliente_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [clienteId, empresaId, empresaNome || '']
      );

      const totalVendas = await pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(total), 0) AS valor
         FROM vendas
         WHERE cliente_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [clienteId, empresaId, empresaNome || '']
      );

      const r = result.rows[0];
      const v = totalVendas.rows[0];

      return ok(res, {
        total_aberto:         Number(r.total_aberto   || 0),
        total_atrasado:       Number(r.total_atrasado || 0),
        total_pago:           Number(r.total_pago     || 0),
        total_titulos_abertos: Number(r.total_titulos_abertos || 0),
        total_compras:        Number(v.total || 0),
        valor_total_compras:  Number(v.valor || 0)
      });
    } catch (err) {
      console.error('[portal] GET resumo:', err.message);
      return erro(res, 500, 'Erro ao carregar resumo');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /portal/titulos
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/titulos', authCliente, portalConsultaRateLimiter, async (req, res) => {
    try {
      const { id: clienteId, empresa_id: empresaId, empresa_nome: empresaNome } = req.cliente;
      const { status } = req.query;

      const params = [clienteId, empresaId, empresaNome || ''];
      let where = 'WHERE cr.cliente_id = $1 AND (cr.empresa_id = $2 OR (cr.empresa_id IS NULL AND cr.empresa = $3))';

      const STATUS_VALIDOS_PORTAL = ['pendente', 'atrasado', 'pago', 'parcial', 'parcial_atrasado', 'cancelado'];
      if (status) {
        if (!STATUS_VALIDOS_PORTAL.includes(status.toLowerCase())) return erro(res, 400, 'Status inválido');
        params.push(status.toLowerCase());
        where += ` AND LOWER(cr.status) = $${params.length}`;
      }

      const result = await pool.query(
        `SELECT cr.id, cr.valor, cr.status, cr.data_vencimento, cr.data_pagamento,
                cr.parcela, cr.total_parcelas, cr.observacao, cr.forma_pagamento
         FROM contas_receber cr
         ${where}
         ORDER BY cr.data_vencimento ASC NULLS LAST`,
        params
      );

      return ok(res, { titulos: result.rows.map((r) => ({
        ...r,
        valor: Number(r.valor || 0)
      })) });
    } catch (err) {
      console.error('[portal] GET titulos:', err.message);
      return erro(res, 500, 'Erro ao carregar títulos');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /portal/vendas
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/vendas', authCliente, portalConsultaRateLimiter, async (req, res) => {
    try {
      const { id: clienteId, empresa_id: empresaId, empresa_nome: empresaNome } = req.cliente;

      const result = await pool.query(
        `SELECT v.id, v.data, v.total, v.pagamento, v.status_pagamento, v.observacao,
                COUNT(vi.id) AS total_itens
         FROM vendas v
         LEFT JOIN venda_itens vi ON vi.venda_id = v.id
         WHERE v.cliente_id = $1 AND (v.empresa_id = $2 OR (v.empresa_id IS NULL AND v.empresa = $3))
         GROUP BY v.id
         ORDER BY v.data DESC, v.id DESC
         LIMIT 50`,
        [clienteId, empresaId, empresaNome || '']
      );

      return ok(res, { vendas: result.rows.map((r) => ({
        ...r,
        total: Number(r.total || 0),
        total_itens: Number(r.total_itens || 0)
      })) });
    } catch (err) {
      console.error('[portal] GET vendas:', err.message);
      return erro(res, 500, 'Erro ao carregar vendas');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /portal/admin/clientes/:id/senha — define senha (ERP auth)
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/admin/clientes/:id/senha', auth, writeRateLimiter, requirePermissao(pool, 'clientes', 'editar'), async (req, res) => {
    try {
      const clienteId = Number(req.params.id);
      const { senha } = req.body;

      if (!senha || String(senha).length < 8) {
        return erro(res, 400, 'A senha deve ter ao menos 8 caracteres');
      }

      const hash = await bcrypt.hash(String(senha), SALT_ROUNDS);

      const empresaId = req.user.empresa_id || null;
      const empresaNome = req.user.empresa || null;

      const r = await pool.query(
        `UPDATE clientes
         SET senha_portal = $1, portal_ativo = true, atualizado_em = NOW()
         WHERE id = $2
           AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
         RETURNING id, nome, portal_ativo`,
        [hash, clienteId, empresaId, empresaNome]
      );

      if (r.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');

      return ok(res, { mensagem: 'Senha do portal configurada. Portal ativado.', cliente: r.rows[0] });
    } catch (err) {
      console.error('[portal] POST admin senha:', err.message);
      return erro(res, 500, 'Erro ao configurar senha do portal');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /portal/admin/clientes/:id/toggle — ativa/desativa portal (ERP auth)
  // ─────────────────────────────────────────────────────────────────────────
  router.patch('/admin/clientes/:id/toggle', auth, writeRateLimiter, requirePermissao(pool, 'clientes', 'editar'), async (req, res) => {
    try {
      const clienteId = Number(req.params.id);

      const empresaId = req.user.empresa_id || null;
      const empresaNome = req.user.empresa || null;

      const r = await pool.query(
        `UPDATE clientes
         SET portal_ativo = NOT portal_ativo, atualizado_em = NOW()
         WHERE id = $1
           AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
         RETURNING id, nome, portal_ativo`,
        [clienteId, empresaId, empresaNome]
      );

      if (r.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');

      const { nome, portal_ativo } = r.rows[0];
      return ok(res, {
        mensagem: `Portal ${portal_ativo ? 'ativado' : 'desativado'} para ${nome}`,
        portal_ativo
      });
    } catch (err) {
      console.error('[portal] PATCH toggle:', err.message);
      return erro(res, 500, 'Erro ao atualizar acesso ao portal');
    }
  });

  return router;
};
