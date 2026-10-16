/**
 * Pedidos — LF ERP
 * Segunda etapa do fluxo Orçamento → Pedido → Venda.
 * Não movimenta estoque. A conversão em Venda aciona o fluxo completo.
 *
 * Rotas (montadas em /pedidos):
 *   GET    /pedidos                       — listar (filtros: status, cliente, periodo)
 *   POST   /pedidos                       — criar pedido direto (sem orçamento)
 *   GET    /pedidos/:id                   — detalhe com itens
 *   PUT    /pedidos/:id                   — editar (só pendente/confirmado)
 *   POST   /pedidos/:id/confirmar         — confirma pedido
 *   POST   /pedidos/:id/separacao         — marca em separação
 *   POST   /pedidos/:id/cancelar          — cancela pedido
 *   POST   /pedidos/:id/converter-venda   — converte em venda (baixa estoque + financeiro)
 */

const { resolverPreco } = require('../utils/resolverPreco');
const { erro, ok } = require('../utils/routeHelpers');

const { obterPeriodo } = require('../utils/periodoUtils');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  normalizarInt,
  normalizarDataISO,
  registrarMovimentacaoEstoque,
  criarParcelasContasReceber,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa,
  registrarAuditoria,
  requirePermissao
}) => {
  const router = require('express').Router();



  const STATUS_EDITAVEL = ['pendente', 'confirmado'];
  const STATUS_VALIDOS  = ['pendente', 'confirmado', 'em_separacao', 'enviado', 'entregue', 'cancelado', 'convertido'];

  async function obterPedido(id, empresaId) {
    const r = await pool.query(`SELECT * FROM pedidos WHERE id = $1 AND empresa_id = $2`, [id, empresaId]);
    return r.rows[0] || null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /pedidos
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/', auth, requirePermissao(pool, 'pedidos', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { status, cliente_id, periodo } = req.query;
      const params = [empresaResolvida.id];
      let where = 'WHERE p.empresa_id = $1';
      let idx = 2;

      if (status && STATUS_VALIDOS.includes(status)) {
        where += ` AND p.status = $${idx++}`; params.push(status);
      }
      if (cliente_id) {
        where += ` AND p.cliente_id = $${idx++}`; params.push(Number(cliente_id));
      }
      if (periodo) {
        const dataInicio = req.query.data_inicio || '';
        const dataFim    = req.query.data_fim    || '';
        if (dataInicio) { where += ` AND p.criado_em::date >= $${idx++}`; params.push(dataInicio); }
        if (dataFim)    { where += ` AND p.criado_em::date <= $${idx++}`; params.push(dataFim); }
      }

      const result = await pool.query(
        `SELECT p.*, COUNT(pi.id) AS total_itens
         FROM pedidos p
         LEFT JOIN pedido_itens pi ON pi.pedido_id = p.id
         ${where}
         GROUP BY p.id
         ORDER BY p.criado_em DESC
         LIMIT 200`,
        params
      );

      return ok(res, { pedidos: result.rows });
    } catch (err) {
      console.error('[pedidos] GET lista:', err.message);
      return erro(res, 500, 'Erro ao listar pedidos');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /pedidos — criação direta (sem orçamento)
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'pedidos', 'criar'), async (req, res) => {
    try {
      const {
        empresa, cliente_id, cliente_nome,
        itens = [], desconto = 0, acrescimo = 0,
        forma_pagamento, parcelas = 1,
        previsao_entrega, endereco_entrega, observacao
      } = req.body;

      if (!Array.isArray(itens) || itens.length === 0) return erro(res, 400, 'Adicione ao menos um item');

      const empresaResolvida = await validarAcessoEmpresa(req, empresa, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const clienteId = cliente_id ? Number(cliente_id) : null;

      if (clienteId) {
        const clienteCheck = await pool.query(
          `SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
          [clienteId, empresaResolvida.id]
        );
        if (clienteCheck.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');
      }

      // produto_id/grade_id de outra empresa não eram validados antes do
      // INSERT (achado D2-SEC-001) — mesmo padrão já usado pra cliente_id acima
      // e pra itens em api-publica.routes.js/orcamentos.routes.js.
      const produtoIdsReq = [...new Set(itens.map(i => Number(i.produto_id)).filter(id => id > 0))];
      const gradeIdsReq   = [...new Set(itens.map(i => i.grade_id ? Number(i.grade_id) : null).filter(Boolean))];
      const [prodCheck, gradeCheck] = await Promise.all([
        produtoIdsReq.length
          ? pool.query(`SELECT id FROM produtos WHERE id = ANY($1) AND empresa_id = $2`, [produtoIdsReq, empresaResolvida.id])
          : { rows: [] },
        gradeIdsReq.length
          ? pool.query(`SELECT id FROM produto_grades WHERE id = ANY($1) AND empresa_id = $2`, [gradeIdsReq, empresaResolvida.id])
          : { rows: [] }
      ]);
      const prodIdsValidos  = new Set(prodCheck.rows.map(r => r.id));
      const gradeIdsValidos = new Set(gradeCheck.rows.map(r => r.id));
      for (const item of itens) {
        if (!prodIdsValidos.has(Number(item.produto_id))) return erro(res, 404, `Produto ${item.produto_id} não encontrado`);
        if (item.grade_id && !gradeIdsValidos.has(Number(item.grade_id))) return erro(res, 404, `Grade ${item.grade_id} não encontrada`);
      }

      const itensResolvidos = await Promise.all(itens.map(async (item) => {
        const produtoId = Number(item.produto_id);
        const gradeId   = item.grade_id ? Number(item.grade_id) : null;
        const qtd       = normalizarDecimal(item.quantidade) || 1;
        const precoPorTabela = !item.preco_unitario
          ? await resolverPreco({ pool, produtoId, gradeId, clienteId, empresaId: empresaResolvida.id, quantidade: qtd })
          : null;
        const preco = normalizarDecimal(item.preco_unitario || precoPorTabela || 0);
        const total = Number((qtd * preco).toFixed(2));
        return { produto_id: produtoId, produto_nome: item.produto_nome || '', grade_id: gradeId, quantidade: qtd, preco_unitario: preco, total };
      }));

      const subtotal = Number(itensResolvidos.reduce((s, i) => s + i.total, 0).toFixed(2));
      const total    = Number(Math.max(0, subtotal - normalizarDecimal(desconto) + normalizarDecimal(acrescimo)).toFixed(2));

      const numResult = await pool.query(
        `SELECT COALESCE(MAX(numero), 0) + 1 AS proximo FROM pedidos WHERE empresa_id = $1`,
        [empresaResolvida.id]
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const ped = await client.query(
          `INSERT INTO pedidos
             (empresa_id, empresa, numero, cliente_id, cliente_nome,
              forma_pagamento, parcelas, previsao_entrega, endereco_entrega,
              subtotal, desconto, acrescimo, total, observacao, criado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING *`,
          [
            empresaResolvida.id, empresaResolvida.nome, numResult.rows[0].proximo,
            clienteId, cliente_nome || null,
            forma_pagamento || null, normalizarInt(parcelas) || 1,
            previsao_entrega ? normalizarDataISO(previsao_entrega) : null,
            endereco_entrega || null,
            subtotal, normalizarDecimal(desconto), normalizarDecimal(acrescimo), total,
            observacao || null, req.user.id
          ]
        );

        for (const item of itensResolvidos) {
          await client.query(
            `INSERT INTO pedido_itens
               (pedido_id, empresa_id, produto_id, produto_nome, grade_id, quantidade, preco_unitario, total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [ped.rows[0].id, empresaResolvida.id, item.produto_id, item.produto_nome, item.grade_id, item.quantidade, item.preco_unitario, item.total]
          );
        }

        await client.query('COMMIT');
        return ok(res, { pedido: { ...ped.rows[0], itens: itensResolvidos } });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[pedidos] POST:', err.message);
      return erro(res, 500, 'Erro ao criar pedido');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /pedidos/:id
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/:id', auth, requirePermissao(pool, 'pedidos', 'ver'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const [ped, itens] = await Promise.all([
        pool.query(`SELECT * FROM pedidos WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]),
        pool.query(
          `SELECT pi.*, p.estoque AS estoque_atual, p.unidade,
                  pg.atributo1, pg.atributo2
           FROM pedido_itens pi
           LEFT JOIN produtos p ON p.id = pi.produto_id AND p.empresa_id = $2
           LEFT JOIN produto_grades pg ON pg.id = pi.grade_id AND pg.empresa_id = $2
           WHERE pi.pedido_id = $1`,
          [id, empresaResolvida.id]
        )
      ]);

      if (ped.rowCount === 0) return erro(res, 404, 'Pedido não encontrado');
      return ok(res, { pedido: { ...ped.rows[0], itens: itens.rows } });
    } catch (err) {
      console.error('[pedidos] GET :id:', err.message);
      return erro(res, 500, 'Erro ao buscar pedido');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /pedidos/:id
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'pedidos', 'editar'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const pedido = await obterPedido(id, empresaResolvida.id);
      if (!pedido) return erro(res, 404, 'Pedido não encontrado');
      if (!STATUS_EDITAVEL.includes(pedido.status)) return erro(res, 400, `Pedido no status "${pedido.status}" não pode ser editado`);

      const { forma_pagamento, parcelas, previsao_entrega, endereco_entrega, observacao } = req.body;

      const r = await pool.query(
        `UPDATE pedidos SET
           forma_pagamento  = COALESCE($1, forma_pagamento),
           parcelas         = COALESCE($2, parcelas),
           previsao_entrega = COALESCE($3, previsao_entrega),
           endereco_entrega = COALESCE($4, endereco_entrega),
           observacao       = COALESCE($5, observacao),
           atualizado_em    = NOW()
         WHERE id = $6 AND empresa_id = $7
         RETURNING *`,
        [
          forma_pagamento || null,
          parcelas ? normalizarInt(parcelas) : null,
          previsao_entrega ? normalizarDataISO(previsao_entrega) : null,
          endereco_entrega || null,
          observacao || null,
          id, empresaResolvida.id
        ]
      );

      return ok(res, { pedido: r.rows[0] });
    } catch (err) {
      console.error('[pedidos] PUT:', err.message);
      return erro(res, 500, 'Erro ao editar pedido');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Transições de status simples
  // ─────────────────────────────────────────────────────────────────────────
  async function mudarStatus(req, res, id, novoStatus, statusPermitidos) {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return erro(res, 403, 'Sem acesso');
    const pedido = await obterPedido(id, empresaResolvida.id);
    if (!pedido) return erro(res, 404, 'Pedido não encontrado');
    if (!statusPermitidos.includes(pedido.status)) return erro(res, 400, `Pedido no status "${pedido.status}" não pode ser alterado`);
    const r = await pool.query(
      `UPDATE pedidos SET status = $1, atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3 RETURNING *`,
      [novoStatus, id, empresaResolvida.id]
    );
    return ok(res, { pedido: r.rows[0] });
  }

  router.post('/:id/confirmar',  auth, writeRateLimiter, requirePermissao(pool, 'pedidos', 'editar'), async (req, res) => {
    try { return await mudarStatus(req, res, Number(req.params.id), 'confirmado', ['pendente']); }
    catch (err) { return erro(res, 500, 'Erro ao confirmar pedido'); }
  });

  router.post('/:id/separacao', auth, writeRateLimiter, requirePermissao(pool, 'pedidos', 'editar'), async (req, res) => {
    try { return await mudarStatus(req, res, Number(req.params.id), 'em_separacao', ['confirmado']); }
    catch (err) { return erro(res, 500, 'Erro ao atualizar status'); }
  });

  router.post('/:id/cancelar', auth, writeRateLimiter, requirePermissao(pool, 'pedidos', 'editar'), async (req, res) => {
    try { return await mudarStatus(req, res, Number(req.params.id), 'cancelado', ['pendente', 'confirmado', 'em_separacao']); }
    catch (err) { return erro(res, 500, 'Erro ao cancelar pedido'); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /pedidos/:id/converter-venda — converte pedido em venda completa
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/converter-venda', auth, writeRateLimiter, requirePermissao(pool, 'pedidos', 'criar'), async (req, res) => {
    const id = Number(req.params.id);
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

    const pedido = await obterPedido(id, empresaResolvida.id);
    if (!pedido) return erro(res, 404, 'Pedido não encontrado');
    if (pedido.status === 'convertido') return erro(res, 400, 'Pedido já foi convertido em venda');
    if (pedido.status === 'cancelado')  return erro(res, 400, 'Pedido cancelado não pode ser convertido');

    const itensResult = await pool.query(`SELECT * FROM pedido_itens WHERE pedido_id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]);
    const itensPedido = itensResult.rows;

    const { forma_pagamento, parcelas, data, observacao, conta_receber } = req.body;

    const formaFinal   = forma_pagamento || pedido.forma_pagamento || 'Dinheiro';
    const parcelasFinal = normalizarInt(parcelas || pedido.parcelas || 1);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insere a venda
      const vendaResult = await client.query(
        `INSERT INTO vendas
           (empresa, empresa_id, cliente_id, cliente_nome,
            subtotal, desconto, acrescimo, total,
            forma_pagamento, parcelas, status_pagamento,
            data, observacao, pedido_id, orcamento_id, criado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendente',$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          empresaResolvida.nome, empresaResolvida.id,
          pedido.cliente_id, pedido.cliente_nome,
          pedido.subtotal, pedido.desconto, pedido.acrescimo, pedido.total,
          formaFinal, parcelasFinal,
          data || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date()),
          observacao || pedido.observacao || null,
          id,
          pedido.orcamento_id || null,
          req.user.id
        ]
      );

      const venda = vendaResult.rows[0];

      // Insere itens e baixa estoque
      const { validarEstoqueKit, baixarComponentesKit, sincronizarEstoqueKit } = require('../utils/kits');

      for (const item of itensPedido) {
        const produtoId = Number(item.produto_id);
        const gradeId   = item.grade_id ? Number(item.grade_id) : null;
        const qtd       = Number(item.quantidade);

        const prodResult = await client.query(
          `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2`, [produtoId, empresaResolvida.id]
        );
        if (prodResult.rowCount === 0) throw new Error(`Produto ${produtoId} não encontrado`);
        const produto = prodResult.rows[0];

        await client.query(
          `INSERT INTO venda_itens
             (venda_id, empresa, empresa_id, produto_id, produto_nome, grade_id, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [venda.id, empresaResolvida.nome, empresaResolvida.id,
           produtoId, item.produto_nome, gradeId,
           qtd, item.preco_unitario,
           Number(produto.custo_medio || produto.custo || 0),
           item.total]
        );

        if (produto.tem_grade && gradeId) {
          const g = await client.query(`SELECT estoque FROM produto_grades WHERE id = $1 AND empresa_id = $2 FOR UPDATE`, [gradeId, empresaResolvida.id]);
          if (g.rowCount === 0 || Number(g.rows[0].estoque) < qtd) throw new Error(`Estoque insuficiente para ${produto.nome}`);
          await client.query(`UPDATE produto_grades SET estoque = estoque - $1, atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3`, [qtd, gradeId, empresaResolvida.id]);
          await client.query(
            `UPDATE produtos SET estoque = (SELECT COALESCE(SUM(estoque),0) FROM produto_grades WHERE produto_id = $1 AND empresa_id = $2 AND ativo=true), atualizado_em=NOW() WHERE id=$1 AND empresa_id=$2`,
            [produtoId, empresaResolvida.id]
          );
        } else if (produto.e_kit) {
          await validarEstoqueKit(client, produtoId, empresaResolvida.id, qtd);
          await baixarComponentesKit({ client, kitId: produtoId, empresaId: empresaResolvida.id, qtdKits: qtd, vendaId: venda.id, usuarioId: req.user.id, registrarMovimentacaoEstoque });
          await sincronizarEstoqueKit(pool, produtoId, empresaResolvida.id);
        } else {
          if (Number(produto.estoque) < qtd) throw new Error(`Estoque insuficiente para ${produto.nome}`);
          await client.query(`UPDATE produtos SET estoque = estoque - $1, atualizado_em=NOW() WHERE id=$2 AND empresa_id=$3`, [qtd, produtoId, empresaResolvida.id]);
          await registrarMovimentacaoEstoque({
            empresa: empresaResolvida.nome, empresa_id: empresaResolvida.id,
            produto_id: produtoId, grade_id: gradeId,
            tipo: 'saida_venda', quantidade: qtd,
            observacao: `Saída por venda #${venda.id} (pedido #${id})`,
            referencia_tipo: 'venda', referencia_id: venda.id,
            usuario_id: req.user.id, client
          });
        }
      }

      // Gera contas a receber se solicitado (dentro da transação via client)
      if (conta_receber !== false && parcelasFinal > 0) {
        await criarParcelasContasReceber({
          client,
          empresa: empresaResolvida.nome, empresa_id: empresaResolvida.id,
          venda_id: venda.id, cliente_id: pedido.cliente_id, cliente_nome: pedido.cliente_nome,
          quantidade_parcelas: parcelasFinal, total: Number(pedido.total),
          forma_pagamento: formaFinal,
          data_primeiro_vencimento: data || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date()),
          criado_por: req.user.id
        });
      }

      // Marca pedido como convertido
      await client.query(
        `UPDATE pedidos SET status = 'convertido', convertido_em = NOW(), atualizado_em = NOW() WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]
      );

      await client.query('COMMIT');

      // Atualiza status de contas
      atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id).catch(() => {});

      return ok(res, { venda, pedido_id: id, mensagem: 'Pedido convertido em venda com sucesso' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[pedidos] converter-venda:', err.message);
      return erro(res, 400, err.message || 'Erro ao converter pedido em venda');
    } finally {
      client.release();
    }
  });

  return router;
};
