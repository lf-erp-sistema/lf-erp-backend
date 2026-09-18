/**
 * API Pública — LF ERP v1
 * Autenticada via X-Api-Key (SHA-256 do token real armazenado em empresa_api_keys).
 *
 * GET  /api/v1/status                  — health check (sem auth)
 * GET  /api/v1/produtos                — listar produtos
 * GET  /api/v1/produtos/:id            — detalhe produto
 * GET  /api/v1/clientes                — listar clientes
 * GET  /api/v1/clientes/:id            — detalhe cliente
 * GET  /api/v1/vendas                  — listar vendas
 * POST /api/v1/vendas                  — criar venda (dispara webhook venda.criada)
 * GET  /api/v1/estoque                 — saldo de estoque
 *
 * Paginação via ?page=1&limit=50 (máximo 200).
 */

const crypto = require('crypto');
const { dispatchWebhook } = require('../utils/webhooks');
const { erro } = require('../utils/routeHelpers');

module.exports = function ({ pool, writeRateLimiter, normalizarDecimal, normalizarInt, hoje, registrarMovimentacaoEstoque }) {
  const router = require('express').Router();

  const VERSAO = '1.0.0';

  function ok(res, dados = {})              { return res.json({ sucesso: true, versao: VERSAO, ...dados }); }


  function paginacao(req) {
    const page  = Math.max(1, normalizarInt(req.query.page)  || 1);
    const limit = Math.min(200, Math.max(1, normalizarInt(req.query.limit) || 50));
    return { page, limit, offset: (page - 1) * limit };
  }

  // ── Rate limiter por empresa (100 req/min) ────────────────────────────────

  const _apiRateBuckets = new Map();
  function apiRateLimiter(req, res, next) {
    const key = req.apiEmpresaId || req.ip;
    const now = Date.now();
    const bucket = _apiRateBuckets.get(key) || { count: 0, resetAt: now + 60_000 };
    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60_000; }
    bucket.count++;
    _apiRateBuckets.set(key, bucket);
    if (bucket.count > 100) return erro(res, 429, 'Limite de requisições atingido. Aguarde 1 minuto.');
    next();
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of _apiRateBuckets) { if (now > b.resetAt + 120_000) _apiRateBuckets.delete(k); }
  }, 5 * 60_000).unref();

  // ── Middleware de autenticação via API Key ────────────────────────────────

  async function authApiKey(req, res, next) {
    const raw = req.headers['x-api-key'];
    if (!raw) return erro(res, 401, 'X-Api-Key é obrigatório');

    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const result = await pool.query(
      `SELECT ak.empresa_id, e.nome AS empresa_nome
       FROM empresa_api_keys ak
       JOIN empresas e ON e.id = ak.empresa_id
       WHERE ak.key_hash = $1 AND ak.ativo = true`,
      [hash]
    ).catch(() => ({ rows: [] }));

    if (result.rows.length === 0) return erro(res, 401, 'API key inválida ou revogada');

    req.apiEmpresaId   = result.rows[0].empresa_id;
    req.apiEmpresaNome = result.rows[0].empresa_nome;
    pool.query(`UPDATE empresa_api_keys SET ultimo_uso = NOW() WHERE key_hash = $1`, [hash]).catch(() => {});
    next();
  }

  // ── GET /api/v1/status ────────────────────────────────────────────────────

  router.get('/status', (_req, res) => {
    res.json({ sucesso: true, versao: VERSAO, status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── GET /api/v1/produtos ──────────────────────────────────────────────────

  router.get('/produtos', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const { page, limit, offset } = paginacao(req);
      const { busca, categoria } = req.query;
      const eId = req.apiEmpresaId;

      const params = [eId];
      let where = `WHERE empresa_id = $1 AND deletado_em IS NULL`;
      if (busca)     { const bEsc = busca.replace(/[%_\\]/g, '\\$&'); params.push(`%${bEsc}%`); where += ` AND (nome ILIKE $${params.length} ESCAPE '\\' OR codigo ILIKE $${params.length} ESCAPE '\\')`; }
      if (categoria) { params.push(categoria);    where += ` AND categoria = $${params.length}`; }

      const [data, count] = await Promise.all([
        pool.query(
          `SELECT id, nome, codigo, categoria, preco, estoque, estoque_minimo,
                  unidade, descricao, ativo, criado_em
           FROM produtos ${where}
           ORDER BY nome
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM produtos ${where}`, params)
      ]);

      return ok(res, {
        total: Number(count.rows[0].count),
        page, limit,
        produtos: data.rows
      });
    } catch (err) {
      console.error('[api-publica] GET produtos:', err.message);
      return erro(res, 500, 'Erro ao listar produtos');
    }
  });

  router.get('/produtos/:id', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT p.id, p.nome, p.codigo, p.categoria, p.preco, p.estoque, p.estoque_minimo,
                p.unidade, p.descricao, p.ativo, p.criado_em,
                COALESCE(json_agg(
                  json_build_object(
                    'id', pg.id,
                    'atributo1', pg.atributo1,
                    'atributo2', pg.atributo2,
                    'sku', pg.sku,
                    'gtin', pg.gtin,
                    'preco', pg.preco,
                    'estoque', pg.estoque,
                    'estoque_minimo', pg.estoque_minimo,
                    'ativo', pg.ativo
                  )
                ) FILTER (WHERE pg.id IS NOT NULL), '[]') AS grades
         FROM produtos p
         LEFT JOIN produto_grades pg ON pg.produto_id = p.id AND pg.ativo = true
         WHERE p.id = $1 AND p.empresa_id = $2 AND p.deletado_em IS NULL
         GROUP BY p.id`,
        [Number(req.params.id), req.apiEmpresaId]
      );
      if (result.rowCount === 0) return erro(res, 404, 'Produto não encontrado');
      return ok(res, { produto: result.rows[0] });
    } catch (err) {
      return erro(res, 500, 'Erro ao buscar produto');
    }
  });

  // ── GET /api/v1/clientes ──────────────────────────────────────────────────

  router.get('/clientes', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const { page, limit, offset } = paginacao(req);
      const { busca } = req.query;
      const eId = req.apiEmpresaId;

      const params = [eId];
      let where = `WHERE empresa_id = $1 AND deletado_em IS NULL`;
      if (busca) { params.push(`%${busca}%`); where += ` AND (nome ILIKE $${params.length} OR cpf_cnpj ILIKE $${params.length})`; }

      const [data, count] = await Promise.all([
        pool.query(
          `SELECT id, nome, cpf_cnpj, telefone, email, cidade, uf, criado_em
           FROM clientes ${where} ORDER BY nome
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM clientes ${where}`, params)
      ]);

      return ok(res, { total: Number(count.rows[0].count), page, limit, clientes: data.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar clientes');
    }
  });

  router.get('/clientes/:id', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT c.*,
                COALESCE(SUM(cr.valor) FILTER (WHERE cr.status NOT IN ('pago')), 0) AS saldo_aberto
         FROM clientes c
         LEFT JOIN contas_receber cr ON cr.cliente_id = c.id AND cr.empresa_id = c.empresa_id
         WHERE c.id = $1 AND c.empresa_id = $2 AND c.deletado_em IS NULL
         GROUP BY c.id`,
        [Number(req.params.id), req.apiEmpresaId]
      );
      if (result.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');
      return ok(res, { cliente: result.rows[0] });
    } catch (err) {
      return erro(res, 500, 'Erro ao buscar cliente');
    }
  });

  // ── GET /api/v1/vendas ────────────────────────────────────────────────────

  router.get('/vendas', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const { page, limit, offset } = paginacao(req);
      const { inicio, fim, status } = req.query;
      const eId = req.apiEmpresaId;

      const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      if (inicio && !ISO_DATE_RE.test(inicio)) return erro(res, 400, 'Parâmetro inicio deve ser YYYY-MM-DD');
      if (fim    && !ISO_DATE_RE.test(fim))    return erro(res, 400, 'Parâmetro fim deve ser YYYY-MM-DD');

      const params = [eId];
      let where = `WHERE empresa_id = $1`;
      if (inicio) { params.push(inicio); where += ` AND data >= $${params.length}`; }
      if (fim)    { params.push(fim);    where += ` AND data <= $${params.length}`; }
      if (status) { params.push(status); where += ` AND status_pagamento = $${params.length}`; }

      const [data, count] = await Promise.all([
        pool.query(
          `SELECT id, data, cliente_nome, total, pagamento, status_pagamento, parcelas, criado_em
           FROM vendas ${where} ORDER BY data DESC, id DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM vendas ${where}`, params)
      ]);

      return ok(res, { total: Number(count.rows[0].count), page, limit, vendas: data.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar vendas');
    }
  });

  // ── POST /api/v1/vendas ───────────────────────────────────────────────────

  const RE_IDEM_KEY = /^[A-Za-z0-9\-_.]+$/;

  // Garante que val é um inteiro estritamente positivo (sem truncamento silencioso de "1.5" ou "2abc")
  function ehInteiroPositivoEstrito(val) {
    const s = String(val === null || val === undefined ? '' : val).trim();
    return /^\d+$/.test(s) && Number(s) > 0;
  }

  router.post('/vendas', authApiKey, apiRateLimiter, writeRateLimiter, async (req, res) => {
    // Hoisted fora do try para acessar no catch (recuperação 23505)
    const eId   = req.apiEmpresaId;
    const eNome = req.apiEmpresaNome;

    // Idempotency-Key obrigatória, apenas do header
    const rawKey = req.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string') return erro(res, 400, 'Idempotency-Key é obrigatório');
    const idempotencyKey = rawKey.trim();
    if (idempotencyKey.length === 0 || idempotencyKey.length > 128)
      return erro(res, 400, 'Idempotency-Key deve ter entre 1 e 128 caracteres');
    if (!RE_IDEM_KEY.test(idempotencyKey))
      return erro(res, 400, 'Idempotency-Key contém caracteres inválidos (use letras, números, hífen, sublinhado ou ponto)');

    // Verificação antecipada de idempotência (fora de transação, antes de qualquer validação de negócio).
    // Uma venda já concluída é devolvida imediatamente mesmo que produto/estoque/cliente tenham mudado.
    // Pré-requisito: migration 041 aplicada (coluna idempotency_key em vendas).
    try {
      const earlyCheck = await pool.query(
        `SELECT id, total FROM vendas WHERE idempotency_key = $1 AND empresa_id = $2 LIMIT 1`,
        [idempotencyKey, eId]
      );
      if (earlyCheck.rows.length > 0) {
        return res.status(200).json({ sucesso: true, versao: VERSAO, venda: { id: earlyCheck.rows[0].id, total: earlyCheck.rows[0].total }, deduplicated: true });
      }
    } catch (earlyErr) {
      console.error('[api-publica] POST vendas early-check:', earlyErr.message);
      return erro(res, 500, 'Erro interno ao verificar idempotência');
    }

    const { cliente_id, cliente_nome, itens, pagamento, observacao } = req.body;
    if (!Array.isArray(itens) || itens.length === 0) return erro(res, 400, 'itens é obrigatório e não pode estar vazio');

    // Validação de cliente_id: se enviado, deve ser inteiro positivo
    if (cliente_id !== undefined && cliente_id !== null && cliente_id !== '') {
      if (!ehInteiroPositivoEstrito(cliente_id)) return erro(res, 400, 'cliente_id deve ser um inteiro positivo válido');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Validar cliente_id pertence à empresa
      let clienteNomeFinal = cliente_nome || null;
      let clienteIdFinal   = (cliente_id !== undefined && cliente_id !== null && cliente_id !== '') ? Number(cliente_id) : null;
      if (clienteIdFinal) {
        const cRes = await client.query(
          `SELECT nome FROM clientes WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
          [clienteIdFinal, eId]
        );
        if (cRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return erro(res, 400, 'cliente_id não encontrado ou não pertence à empresa');
        }
        clienteNomeFinal = cRes.rows[0].nome;
      }

      // Pre-fetch produtos com todos os campos necessários
      const produtoIds = [...new Set(itens.map(i => Number(i.produto_id)).filter(id => id > 0))];
      if (produtoIds.length === 0) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'produto_id inválido em um ou mais itens');
      }
      const prodRows = await client.query(
        `SELECT id, nome, preco, custo, estoque, ativo, tem_grade, e_kit
         FROM produtos WHERE id = ANY($1) AND empresa_id = $2 AND deletado_em IS NULL`,
        [produtoIds, eId]
      );
      const prodMap = Object.fromEntries(prodRows.rows.map(p => [p.id, p]));

      let totalCalculado = 0;
      const itensNormalizados = [];
      for (const item of itens) {
        const produtoId = Number(item.produto_id);
        // Quantidade deve ser inteiro estritamente positivo — sem truncamento silencioso
        if (!ehInteiroPositivoEstrito(item.quantidade)) {
          await client.query('ROLLBACK');
          return erro(res, 400, `quantidade deve ser um inteiro positivo para produto_id ${produtoId}`);
        }
        const qtd = Number(String(item.quantidade).trim());
        const produto = prodMap[produtoId];
        if (!produto) {
          await client.query('ROLLBACK');
          return erro(res, 400, `Produto ${produtoId} não encontrado`);
        }
        if (!produto.ativo) {
          await client.query('ROLLBACK');
          return erro(res, 400, `Produto "${produto.nome}" está inativo`);
        }
        if (produto.tem_grade) {
          await client.query('ROLLBACK');
          return erro(res, 400, `Produto "${produto.nome}" possui grades e não é suportado pela API pública. Use o fluxo de venda interno.`);
        }
        if (produto.e_kit) {
          await client.query('ROLLBACK');
          return erro(res, 400, `Produto "${produto.nome}" é um kit e não é suportado pela API pública. Use o fluxo de venda interno.`);
        }
        const preco = normalizarDecimal(produto.preco);
        if (preco <= 0) {
          await client.query('ROLLBACK');
          return erro(res, 400, `Produto "${produto.nome}" não possui preço cadastrado`);
        }
        if (normalizarInt(produto.estoque) < qtd) {
          await client.query('ROLLBACK');
          return erro(res, 400, `Estoque insuficiente para "${produto.nome}". Disponível: ${produto.estoque}`);
        }
        const totalItem = Number((qtd * preco).toFixed(2));
        totalCalculado += totalItem;
        itensNormalizados.push({ produto, qtd, preco, totalItem });
      }
      totalCalculado = Number(totalCalculado.toFixed(2));
      const pagamentoFinal = pagamento || 'API';

      // INSERT tenta gravar; se (empresa_id, idempotency_key) já existir, PostgreSQL lança 23505
      const vendaResult = await client.query(
        `INSERT INTO vendas
           (empresa, empresa_id, cliente_id, cliente_nome, subtotal, desconto, acrescimo, total,
            pagamento, pagamentos, parcelas, status_pagamento, data, observacao, idempotency_key, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,0,0,$5,$6,$7,1,'pago',$8,$9,$10,NOW(),NOW()) RETURNING *`,
        [
          eNome, eId,
          clienteIdFinal,
          clienteNomeFinal,
          totalCalculado,
          pagamentoFinal,
          JSON.stringify([{ forma: pagamentoFinal, valor: totalCalculado, parcelas: 1 }]),
          hoje(),
          observacao || 'Venda criada via API',
          idempotencyKey
        ]
      );
      const venda = vendaResult.rows[0];

      for (const { produto, qtd, preco, totalItem } of itensNormalizados) {
        await client.query(
          `INSERT INTO venda_itens (venda_id, empresa, empresa_id, produto_id, produto_nome, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [venda.id, eNome, eId, produto.id, produto.nome, qtd, preco, produto.custo || 0, totalItem]
        );

        // Debita estoque atomicamente; falha explícita em corrida simultânea
        const upd = await client.query(
          `UPDATE produtos SET estoque = estoque - $1, atualizado_em = NOW()
           WHERE id = $2 AND empresa_id = $3 AND estoque >= $1`,
          [qtd, produto.id, eId]
        );
        if (upd.rowCount === 0) {
          throw new Error(`Estoque insuficiente para "${produto.nome}" (corrida simultânea)`);
        }

        await registrarMovimentacaoEstoque({
          empresa: eNome,
          empresa_id: eId,
          produto_id: produto.id,
          grade_id: null,
          tipo: 'saida_venda',
          quantidade: qtd,
          observacao: `Saída por venda #${venda.id} via API`,
          referencia_tipo: 'venda',
          referencia_id: venda.id,
          usuario_id: null,
          client
        });
      }

      await client.query('COMMIT');

      dispatchWebhook({ pool, empresaId: eId, evento: 'venda.criada', payload: { id: venda.id, total: venda.total, cliente_nome: venda.cliente_nome, data: venda.data } }).catch(() => {});

      return res.status(201).json({ sucesso: true, versao: VERSAO, venda: { id: venda.id, total: venda.total } });
    } catch (err) {
      await client.query('ROLLBACK');

      // Conflito de idempotência por concorrência: outra requisição criou a venda simultaneamente.
      // A transação atual foi revertida — nenhuma baixa dupla de estoque ocorre.
      if (err.code === '23505' && String(err.constraint || err.detail || '').toLowerCase().includes('idempotency')) {
        try {
          const existing = await pool.query(
            `SELECT id, total FROM vendas WHERE idempotency_key = $1 AND empresa_id = $2 LIMIT 1`,
            [idempotencyKey, eId]
          );
          if (existing.rows.length > 0) {
            return res.status(200).json({ sucesso: true, versao: VERSAO, venda: { id: existing.rows[0].id, total: existing.rows[0].total }, deduplicated: true });
          }
        } catch (_e) { /* fall through to 500 */ }
      }

      console.error('[api-publica] POST vendas:', err.message);
      if (err.message.includes('não encontrado') || err.message.includes('insuficiente') || err.message.includes('inválid') || err.message.includes('não possui preço') || err.message.includes('inativo')) return erro(res, 400, err.message);
      return erro(res, 500, 'Erro ao processar venda');
    } finally {
      client.release();
    }
  });

  // ── GET /api/v1/estoque ───────────────────────────────────────────────────

  router.get('/estoque', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const { page, limit, offset } = paginacao(req);
      const { abaixo_minimo } = req.query;
      const eId = req.apiEmpresaId;

      const params = [eId];
      let where = `WHERE empresa_id = $1 AND deletado_em IS NULL`;
      if (abaixo_minimo === 'true') where += ` AND estoque_minimo > 0 AND estoque < estoque_minimo`;

      const [data, count] = await Promise.all([
        pool.query(
          `SELECT id, nome, codigo, estoque, estoque_minimo, unidade
           FROM produtos ${where} ORDER BY nome
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM produtos ${where}`, params)
      ]);

      return ok(res, { total: Number(count.rows[0].count), page, limit, estoque: data.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao buscar estoque');
    }
  });

  return router;
};
