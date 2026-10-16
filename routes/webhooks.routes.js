/**
 * Webhooks — LF ERP
 * Gerenciamento de API Keys e endpoints de webhook por empresa.
 *
 * API Keys:
 *   GET    /webhooks/api-keys            — listar chaves
 *   POST   /webhooks/api-keys            — gerar nova chave (retorna token uma única vez)
 *   DELETE /webhooks/api-keys/:id        — revogar chave
 *
 * Endpoints de webhook:
 *   GET    /webhooks/endpoints           — listar endpoints
 *   POST   /webhooks/endpoints           — registrar endpoint
 *   PUT    /webhooks/endpoints/:id       — editar endpoint
 *   DELETE /webhooks/endpoints/:id       — remover endpoint
 *   POST   /webhooks/endpoints/:id/teste — enviar evento de teste
 *
 * Logs:
 *   GET    /webhooks/logs                — histórico de entregas (últimas 200)
 */

const crypto = require('crypto');
const { requirePermissao } = require('../utils/permissoes');
const { dispatchWebhook, enviarWebhook } = require('../utils/webhooks');
const { validarUrlExterna } = require('../utils/ssrfGuard');
const { erro, ok } = require('../utils/routeHelpers');
const { encryptField } = require('../utils/pixCrypto');

const EVENTOS_DISPONIVEIS = [
  'venda.criada',
  'venda.cancelada',
  'pagamento.recebido',
  'compra.criada',
  'estoque.baixo',
  'conta_pagar.vencida'
];

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa }) {
  const router = require('express').Router();



  async function resolveEmp(req) { return validarAcessoEmpresa(req, null, req.empresa_id); }

  // ─────────────────────────────────────────────────────────────────────────
  // API KEYS
  // ─────────────────────────────────────────────────────────────────────────

  router.get('/api-keys', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmp(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT id, nome, key_prefix, ativo, ultimo_uso, criado_em
         FROM empresa_api_keys WHERE empresa_id = $1 ORDER BY criado_em DESC`,
        [emp.id]
      );
      return ok(res, { chaves: result.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar chaves');
    }
  });

  router.post('/api-keys', auth, requirePermissao(pool, 'configuracoes', 'criar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await resolveEmp(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { nome } = req.body;
      if (!nome?.trim()) return erro(res, 400, 'Nome da chave é obrigatório');

      // Verifica limite de 10 chaves ativas por empresa
      const count = await pool.query(
        `SELECT COUNT(*) FROM empresa_api_keys WHERE empresa_id = $1 AND ativo = true`,
        [emp.id]
      );
      if (Number(count.rows[0].count) >= 10) return erro(res, 400, 'Limite de 10 chaves ativas atingido');

      // Gera token: lferp_ + 40 hex chars aleatórios
      const rawToken  = `lferp_${crypto.randomBytes(20).toString('hex')}`;
      const keyHash   = crypto.createHash('sha256').update(rawToken).digest('hex');
      const keyPrefix = rawToken.substring(0, 12) + '...';

      await pool.query(
        `INSERT INTO empresa_api_keys (empresa_id, nome, key_hash, key_prefix)
         VALUES ($1,$2,$3,$4)`,
        [emp.id, nome.trim(), keyHash, keyPrefix]
      );

      // Retorna o token completo UMA VEZ — não é possível recuperá-lo depois
      return res.status(201).json({
        sucesso: true,
        token: rawToken,
        aviso: 'Guarde este token em local seguro. Ele não será exibido novamente.'
      });
    } catch (err) {
      return erro(res, 500, 'Erro ao gerar chave');
    }
  });

  router.delete('/api-keys/:id', auth, requirePermissao(pool, 'configuracoes', 'deletar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await resolveEmp(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const r = await pool.query(
        `UPDATE empresa_api_keys SET ativo = false WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), emp.id]
      );
      if (r.rowCount === 0) return erro(res, 404, 'Chave não encontrada');
      return ok(res, { mensagem: 'Chave revogada' });
    } catch (err) {
      return erro(res, 500, 'Erro ao revogar chave');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ENDPOINTS DE WEBHOOK
  // ─────────────────────────────────────────────────────────────────────────

  router.get('/endpoints', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmp(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT id, nome, url, eventos, ativo,
                CASE WHEN secret IS NOT NULL THEN '***' ELSE NULL END AS secret,
                criado_em, atualizado_em
         FROM webhook_endpoints WHERE empresa_id = $1 ORDER BY criado_em DESC`,
        [emp.id]
      );
      return ok(res, { endpoints: result.rows, eventos_disponiveis: EVENTOS_DISPONIVEIS });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar endpoints');
    }
  });

  router.post('/endpoints', auth, requirePermissao(pool, 'configuracoes', 'criar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await resolveEmp(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { nome, url, eventos, secret } = req.body;
      if (!nome?.trim() || !url?.trim()) return erro(res, 400, 'nome e url são obrigatórios');
      if (!Array.isArray(eventos) || eventos.length === 0) return erro(res, 400, 'Selecione ao menos um evento');

      const eventosValidos = eventos.filter((e) => EVENTOS_DISPONIVEIS.includes(e));
      if (eventosValidos.length === 0) return erro(res, 400, 'Nenhum evento válido selecionado');

      if (!(await validarUrlExterna(url.trim()))) {
        return erro(res, 400, 'URL inválida ou aponta para endereço interno não permitido');
      }

      const result = await pool.query(
        `INSERT INTO webhook_endpoints (empresa_id, nome, url, eventos, secret)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, nome, url, eventos, ativo`,
        [emp.id, nome.trim(), url.trim(), eventosValidos, secret?.trim() ? encryptField(secret.trim()) : null]
      );

      return res.status(201).json({ sucesso: true, endpoint: result.rows[0] });
    } catch (err) {
      return erro(res, 500, 'Erro ao criar endpoint');
    }
  });

  router.put('/endpoints/:id', auth, requirePermissao(pool, 'configuracoes', 'editar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await resolveEmp(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { nome, url, eventos, secret, ativo } = req.body;

      if (url?.trim()) {
        if (!(await validarUrlExterna(url.trim()))) {
          return erro(res, 400, 'URL inválida ou aponta para endereço interno não permitido');
        }
      }

      const eventosValidos = Array.isArray(eventos) && eventos.length > 0
        ? eventos.filter((e) => EVENTOS_DISPONIVEIS.includes(e))
        : null;

      const result = await pool.query(
        `UPDATE webhook_endpoints SET
           nome          = COALESCE(NULLIF($1,''), nome),
           url           = COALESCE(NULLIF($2,''), url),
           eventos       = COALESCE($3, eventos),
           secret        = COALESCE(NULLIF($4,''), secret),
           ativo         = COALESCE($5, ativo),
           atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
         WHERE id = $6 AND empresa_id = $7 RETURNING id, nome, url, eventos, ativo`,
        [
          nome?.trim() || null,
          url?.trim()  || null,
          eventosValidos,
          secret?.trim() ? encryptField(secret.trim()) : null,
          ativo != null ? Boolean(ativo) : null,
          Number(req.params.id), emp.id
        ]
      );

      if (result.rowCount === 0) return erro(res, 404, 'Endpoint não encontrado');
      return ok(res, { endpoint: result.rows[0] });
    } catch (err) {
      return erro(res, 500, 'Erro ao editar endpoint');
    }
  });

  router.delete('/endpoints/:id', auth, requirePermissao(pool, 'configuracoes', 'deletar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await resolveEmp(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const r = await pool.query(
        `DELETE FROM webhook_endpoints WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), emp.id]
      );
      if (r.rowCount === 0) return erro(res, 404, 'Endpoint não encontrado');
      return ok(res, { mensagem: 'Endpoint removido' });
    } catch (err) {
      return erro(res, 500, 'Erro ao remover endpoint');
    }
  });

  // ── Teste ─────────────────────────────────────────────────────────────────

  router.post('/endpoints/:id/teste', auth, requirePermissao(pool, 'configuracoes', 'ver'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await resolveEmp(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const epResult = await pool.query(
        `SELECT * FROM webhook_endpoints WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), emp.id]
      );
      if (epResult.rowCount === 0) return erro(res, 404, 'Endpoint não encontrado');

      const ep = epResult.rows[0];
      const eventoReq = req.body.evento;
      const evento = (eventoReq && EVENTOS_DISPONIVEIS.includes(eventoReq))
        ? eventoReq
        : (ep.eventos[0] || 'venda.criada');

      // Envia diretamente para este endpoint específico (ignora filtro de eventos)
      enviarWebhook({
        pool,
        endpoint: ep,
        evento,
        payload: { teste: true, evento, timestamp: new Date().toISOString(), empresa: emp.nome },
        tentativa: 1
      }).catch((err) => { console.error('[webhook-test]', err); });

      return ok(res, { mensagem: `Evento de teste "${evento}" enviado para ${ep.url}` });
    } catch (err) {
      return erro(res, 500, 'Erro ao enviar teste');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LOGS
  // ─────────────────────────────────────────────────────────────────────────

  router.get('/logs', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
    try {
      const emp = await resolveEmp(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { endpoint_id } = req.query;
      const params = [emp.id];
      let where = `WHERE l.empresa_id = $1`;
      if (endpoint_id) { params.push(Number(endpoint_id)); where += ` AND l.endpoint_id = $${params.length}`; }

      const result = await pool.query(
        `SELECT l.id, l.evento, l.status_http, l.sucesso, l.tentativa, l.erro, l.criado_em,
                e.nome AS endpoint_nome, e.url AS endpoint_url
         FROM webhook_logs l
         JOIN webhook_endpoints e ON e.id = l.endpoint_id
         ${where}
         ORDER BY l.criado_em DESC LIMIT 200`,
        params
      );
      return ok(res, { logs: result.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao buscar logs');
    }
  });

  return router;
};
