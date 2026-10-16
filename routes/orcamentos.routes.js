/**
 * Orçamentos — LF ERP
 * Primeira etapa do fluxo Orçamento → Pedido → Venda.
 * Não movimenta estoque nem gera registros financeiros.
 *
 * Rotas (montadas em /orcamentos):
 *   GET    /orcamentos                    — listar (filtros: status, cliente, periodo)
 *   POST   /orcamentos                    — criar orçamento
 *   GET    /orcamentos/:id                — detalhe com itens
 *   PUT    /orcamentos/:id                — editar (só rascunho/enviado)
 *   DELETE /orcamentos/:id                — excluir (só rascunho)
 *
 *   POST   /orcamentos/:id/enviar         — marca como enviado ao cliente
 *   POST   /orcamentos/:id/aprovar        — aprova orçamento
 *   POST   /orcamentos/:id/recusar        — recusa orçamento
 *   POST   /orcamentos/:id/converter      — converte em pedido
 */

const { resolverPreco } = require('../utils/resolverPreco');
const { erro, ok } = require('../utils/routeHelpers');

const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  normalizarInt,
  normalizarDataISO,
  requirePermissao
}) => {
  const router = require('express').Router();



  const STATUS_EDITAVEL   = ['rascunho', 'enviado'];
  const STATUS_VALIDOS    = ['rascunho', 'enviado', 'aprovado', 'recusado', 'expirado', 'convertido'];

  // ── Próximo número de orçamento por empresa ──────────────────────────────
  async function proximoNumero(empresaId) {
    const r = await pool.query(
      `SELECT COALESCE(MAX(numero), 0) + 1 AS proximo FROM orcamentos WHERE empresa_id = $1`,
      [empresaId]
    );
    return r.rows[0].proximo;
  }

  // ── Normaliza itens calculando totais ────────────────────────────────────
  function calcularTotaisOrcamento(itens, descontoGlobal = 0, acrescimoGlobal = 0) {
    const subtotal = itens.reduce((s, i) => s + Number(i.total || 0), 0);
    const total = Math.max(0, subtotal - Number(descontoGlobal) + Number(acrescimoGlobal));
    return { subtotal: Number(subtotal.toFixed(2)), total: Number(total.toFixed(2)) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /orcamentos
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/', auth, requirePermissao(pool, 'orcamentos', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { status, cliente_id, periodo } = req.query;
      const params = [empresaResolvida.id];
      let where = 'WHERE o.empresa_id = $1';
      let idx = 2;

      if (status && STATUS_VALIDOS.includes(status)) {
        where += ` AND o.status = $${idx++}`; params.push(status);
      }
      if (cliente_id) {
        where += ` AND o.cliente_id = $${idx++}`; params.push(Number(cliente_id));
      }
      if (periodo) {
        const dataInicio = req.query.data_inicio || '';
        const dataFim    = req.query.data_fim    || '';
        if (dataInicio) { where += ` AND o.criado_em::date >= $${idx++}`; params.push(dataInicio); }
        if (dataFim)    { where += ` AND o.criado_em::date <= $${idx++}`; params.push(dataFim); }
      }

      const result = await pool.query(
        `SELECT o.*,
                COUNT(oi.id) AS total_itens
         FROM orcamentos o
         LEFT JOIN orcamento_itens oi ON oi.orcamento_id = o.id
         ${where}
         GROUP BY o.id
         ORDER BY o.criado_em DESC
         LIMIT 200`,
        params
      );

      return ok(res, { orcamentos: result.rows });
    } catch (err) {
      console.error('[orcamentos] GET lista:', err.message);
      return erro(res, 500, 'Erro ao listar orçamentos');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /orcamentos
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'orcamentos', 'criar'), async (req, res) => {
    try {
      const {
        empresa, cliente_id, cliente_nome,
        itens = [], desconto = 0, acrescimo = 0,
        validade, observacao
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

      // produto_id/grade_id de outra empresa não eram validados antes do INSERT
      // (achado D2-SEC-001) — mesmo padrão já usado pra cliente_id acima e pra
      // itens em api-publica.routes.js.
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

      // Resolve preços com tabela do cliente
      const itensResolvidos = await Promise.all(itens.map(async (item) => {
        const produtoId = Number(item.produto_id);
        const gradeId   = item.grade_id ? Number(item.grade_id) : null;
        const qtd       = normalizarDecimal(item.quantidade) || 1;

        const precoPorTabela = !item.preco_unitario
          ? await resolverPreco({ pool, produtoId, gradeId, clienteId, empresaId: empresaResolvida.id, quantidade: qtd })
          : null;
        const preco    = normalizarDecimal(item.preco_unitario || precoPorTabela || 0);
        const descItem = normalizarDecimal(item.desconto_item || 0);
        const total    = Number(Math.max(0, qtd * preco - descItem).toFixed(2));

        return {
          produto_id: produtoId,
          produto_nome: item.produto_nome || '',
          grade_id: gradeId,
          quantidade: qtd,
          preco_unitario: preco,
          desconto_item: descItem,
          total
        };
      }));

      const { subtotal, total } = calcularTotaisOrcamento(itensResolvidos, desconto, acrescimo);
      const numero = await proximoNumero(empresaResolvida.id);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const orc = await client.query(
          `INSERT INTO orcamentos
             (empresa_id, empresa, numero, cliente_id, cliente_nome, validade,
              subtotal, desconto, acrescimo, total, observacao, criado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [
            empresaResolvida.id, empresaResolvida.nome, numero,
            clienteId, cliente_nome || null,
            validade ? normalizarDataISO(validade) : null,
            subtotal, normalizarDecimal(desconto), normalizarDecimal(acrescimo), total,
            observacao || null, req.user.id
          ]
        );

        const orcamento = orc.rows[0];

        for (const item of itensResolvidos) {
          await client.query(
            `INSERT INTO orcamento_itens
               (orcamento_id, empresa_id, produto_id, produto_nome, grade_id,
                quantidade, preco_unitario, desconto_item, total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [orcamento.id, empresaResolvida.id, item.produto_id, item.produto_nome,
             item.grade_id, item.quantidade, item.preco_unitario, item.desconto_item, item.total]
          );
        }

        await client.query('COMMIT');
        return ok(res, { orcamento: { ...orcamento, itens: itensResolvidos } });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[orcamentos] POST:', err.message);
      return erro(res, 500, 'Erro ao criar orçamento');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /orcamentos/:id
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/:id', auth, requirePermissao(pool, 'orcamentos', 'ver'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const [orc, itens] = await Promise.all([
        pool.query(`SELECT * FROM orcamentos WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]),
        pool.query(
          `SELECT oi.*, p.unidade,
                  pg.atributo1, pg.atributo2
           FROM orcamento_itens oi
           LEFT JOIN produtos p ON p.id = oi.produto_id AND p.empresa_id = $2
           LEFT JOIN produto_grades pg ON pg.id = oi.grade_id AND pg.empresa_id = $2
           WHERE oi.orcamento_id = $1`,
          [id, empresaResolvida.id]
        )
      ]);

      if (orc.rowCount === 0) return erro(res, 404, 'Orçamento não encontrado');

      return ok(res, { orcamento: { ...orc.rows[0], itens: itens.rows } });
    } catch (err) {
      console.error('[orcamentos] GET :id:', err.message);
      return erro(res, 500, 'Erro ao buscar orçamento');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /orcamentos/:id
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'orcamentos', 'editar'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const atual = await pool.query(`SELECT * FROM orcamentos WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]);
      if (atual.rowCount === 0) return erro(res, 404, 'Orçamento não encontrado');
      if (!STATUS_EDITAVEL.includes(atual.rows[0].status)) return erro(res, 400, `Orçamento no status "${atual.rows[0].status}" não pode ser editado`);

      const {
        cliente_id, cliente_nome, itens,
        desconto = 0, acrescimo = 0,
        validade, observacao
      } = req.body;

      if (cliente_id) {
        const clienteCheck = await pool.query(
          `SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
          [Number(cliente_id), empresaResolvida.id]
        );
        if (clienteCheck.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        let subtotalFinal = Number(atual.rows[0].subtotal);
        let totalFinal    = Number(atual.rows[0].total);

        if (Array.isArray(itens) && itens.length > 0) {
          // produto_id/grade_id de outra empresa não eram validados antes do
          // INSERT (achado D2-SEC-001) — mesma checagem aplicada no POST.
          const produtoIdsReq = [...new Set(itens.map(i => Number(i.produto_id)).filter(id => id > 0))];
          const gradeIdsReq   = [...new Set(itens.map(i => i.grade_id ? Number(i.grade_id) : null).filter(Boolean))];
          const [prodCheck, gradeCheck] = await Promise.all([
            produtoIdsReq.length
              ? client.query(`SELECT id FROM produtos WHERE id = ANY($1) AND empresa_id = $2`, [produtoIdsReq, empresaResolvida.id])
              : { rows: [] },
            gradeIdsReq.length
              ? client.query(`SELECT id FROM produto_grades WHERE id = ANY($1) AND empresa_id = $2`, [gradeIdsReq, empresaResolvida.id])
              : { rows: [] }
          ]);
          const prodIdsValidos  = new Set(prodCheck.rows.map(r => r.id));
          const gradeIdsValidos = new Set(gradeCheck.rows.map(r => r.id));
          for (const item of itens) {
            if (!prodIdsValidos.has(Number(item.produto_id))) {
              await client.query('ROLLBACK');
              return erro(res, 404, `Produto ${item.produto_id} não encontrado`);
            }
            if (item.grade_id && !gradeIdsValidos.has(Number(item.grade_id))) {
              await client.query('ROLLBACK');
              return erro(res, 404, `Grade ${item.grade_id} não encontrada`);
            }
          }

          await client.query(`DELETE FROM orcamento_itens WHERE orcamento_id = $1`, [id]);
          const clienteId = cliente_id ? Number(cliente_id) : atual.rows[0].cliente_id;

          const itensResolvidos = await Promise.all(itens.map(async (item) => {
            const produtoId = Number(item.produto_id);
            const gradeId   = item.grade_id ? Number(item.grade_id) : null;
            const qtd       = normalizarDecimal(item.quantidade) || 1;
            const precoPorTabela = !item.preco_unitario
              ? await resolverPreco({ pool, produtoId, gradeId, clienteId, empresaId: empresaResolvida.id, quantidade: qtd })
              : null;
            const preco    = normalizarDecimal(item.preco_unitario || precoPorTabela || 0);
            const descItem = normalizarDecimal(item.desconto_item || 0);
            const total    = Number(Math.max(0, qtd * preco - descItem).toFixed(2));
            return { produto_id: produtoId, produto_nome: item.produto_nome || '', grade_id: gradeId, quantidade: qtd, preco_unitario: preco, desconto_item: descItem, total };
          }));

          for (const item of itensResolvidos) {
            await client.query(
              `INSERT INTO orcamento_itens (orcamento_id, empresa_id, produto_id, produto_nome, grade_id, quantidade, preco_unitario, desconto_item, total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [id, empresaResolvida.id, item.produto_id, item.produto_nome, item.grade_id, item.quantidade, item.preco_unitario, item.desconto_item, item.total]
            );
          }

          const calc = calcularTotaisOrcamento(itensResolvidos, desconto, acrescimo);
          subtotalFinal = calc.subtotal;
          totalFinal    = calc.total;
        }

        const updated = await client.query(
          `UPDATE orcamentos SET
             cliente_id  = COALESCE($1, cliente_id),
             cliente_nome = COALESCE($2, cliente_nome),
             validade    = COALESCE($3, validade),
             subtotal    = $4,
             desconto    = $5,
             acrescimo   = $6,
             total       = $7,
             observacao  = COALESCE($8, observacao),
             atualizado_em = NOW()
           WHERE id = $9 AND empresa_id = $10
           RETURNING *`,
          [
            cliente_id ? Number(cliente_id) : null,
            cliente_nome || null,
            validade ? normalizarDataISO(validade) : null,
            subtotalFinal,
            normalizarDecimal(desconto),
            normalizarDecimal(acrescimo),
            totalFinal,
            observacao || null,
            id, empresaResolvida.id
          ]
        );

        await client.query('COMMIT');
        return ok(res, { orcamento: updated.rows[0] });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[orcamentos] PUT:', err.message);
      return erro(res, 500, 'Erro ao editar orçamento');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /orcamentos/:id — só rascunho
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/:id', auth, writeRateLimiter, requirePermissao(pool, 'orcamentos', 'deletar'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const atual = await pool.query(`SELECT status FROM orcamentos WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]);
      if (atual.rowCount === 0) return erro(res, 404, 'Orçamento não encontrado');
      if (atual.rows[0].status !== 'rascunho') return erro(res, 400, 'Apenas orçamentos em rascunho podem ser excluídos');

      await pool.query(`DELETE FROM orcamentos WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]);
      return ok(res, { mensagem: 'Orçamento excluído' });
    } catch (err) {
      console.error('[orcamentos] DELETE:', err.message);
      return erro(res, 500, 'Erro ao excluir orçamento');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Transições de status
  // ─────────────────────────────────────────────────────────────────────────

  async function transicaoStatus(req, res, id, novoStatus, statusPermitidos, extraUpdate = {}) {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

    const atual = await pool.query(`SELECT * FROM orcamentos WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]);
    if (atual.rowCount === 0) return erro(res, 404, 'Orçamento não encontrado');
    if (!statusPermitidos.includes(atual.rows[0].status)) {
      return erro(res, 400, `Orçamento no status "${atual.rows[0].status}" não pode ser ${novoStatus}`);
    }

    const campos = Object.entries({ status: novoStatus, ...extraUpdate })
      .map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const valores = [id, novoStatus, ...Object.values(extraUpdate), empresaResolvida.id];

    const r = await pool.query(
      `UPDATE orcamentos SET ${campos}, atualizado_em = NOW() WHERE id = $1 AND empresa_id = $${valores.length} RETURNING *`,
      valores
    );
    return ok(res, { orcamento: r.rows[0] });
  }

  // POST /orcamentos/:id/enviar
  router.post('/:id/enviar', auth, writeRateLimiter, requirePermissao(pool, 'orcamentos', 'editar'), async (req, res) => {
    try {
      return await transicaoStatus(req, res, Number(req.params.id), 'enviado', ['rascunho']);
    } catch (err) {
      console.error('[orcamentos] enviar:', err.message);
      return erro(res, 500, 'Erro ao enviar orçamento');
    }
  });

  // POST /orcamentos/:id/aprovar
  router.post('/:id/aprovar', auth, writeRateLimiter, requirePermissao(pool, 'orcamentos', 'editar'), async (req, res) => {
    try {
      return await transicaoStatus(req, res, Number(req.params.id), 'aprovado', ['enviado', 'rascunho']);
    } catch (err) {
      console.error('[orcamentos] aprovar:', err.message);
      return erro(res, 500, 'Erro ao aprovar orçamento');
    }
  });

  // POST /orcamentos/:id/recusar
  router.post('/:id/recusar', auth, writeRateLimiter, requirePermissao(pool, 'orcamentos', 'editar'), async (req, res) => {
    try {
      return await transicaoStatus(req, res, Number(req.params.id), 'recusado', ['enviado', 'rascunho', 'aprovado']);
    } catch (err) {
      console.error('[orcamentos] recusar:', err.message);
      return erro(res, 500, 'Erro ao recusar orçamento');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /orcamentos/:id/converter — converte em pedido
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/converter', auth, writeRateLimiter, requirePermissao(pool, 'orcamentos', 'criar'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const [orcResult, itensResult] = await Promise.all([
        pool.query(`SELECT * FROM orcamentos WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]),
        pool.query(`SELECT * FROM orcamento_itens WHERE orcamento_id = $1`, [id])
      ]);

      if (orcResult.rowCount === 0) return erro(res, 404, 'Orçamento não encontrado');
      const orc = orcResult.rows[0];

      if (!['aprovado', 'enviado', 'rascunho'].includes(orc.status)) {
        return erro(res, 400, `Orçamento no status "${orc.status}" não pode ser convertido`);
      }
      if (orc.status === 'convertido') return erro(res, 400, 'Orçamento já foi convertido em pedido');

      // Próximo número de pedido
      const numPedido = await pool.query(
        `SELECT COALESCE(MAX(numero), 0) + 1 AS proximo FROM pedidos WHERE empresa_id = $1`,
        [empresaResolvida.id]
      );

      const { forma_pagamento, parcelas = 1, previsao_entrega, endereco_entrega, observacao } = req.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const pedido = await client.query(
          `INSERT INTO pedidos
             (empresa_id, empresa, numero, orcamento_id, cliente_id, cliente_nome,
              forma_pagamento, parcelas, previsao_entrega, endereco_entrega,
              subtotal, desconto, acrescimo, total, observacao, criado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING *`,
          [
            empresaResolvida.id, empresaResolvida.nome,
            numPedido.rows[0].proximo, orc.id,
            orc.cliente_id, orc.cliente_nome,
            forma_pagamento || null, normalizarInt(parcelas) || 1,
            previsao_entrega ? normalizarDataISO(previsao_entrega) : null,
            endereco_entrega || null,
            orc.subtotal, orc.desconto, orc.acrescimo, orc.total,
            observacao || orc.observacao || null, req.user.id
          ]
        );

        for (const item of itensResult.rows) {
          await client.query(
            `INSERT INTO pedido_itens
               (pedido_id, empresa_id, produto_id, produto_nome, grade_id,
                quantidade, preco_unitario, total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [pedido.rows[0].id, empresaResolvida.id, item.produto_id, item.produto_nome,
             item.grade_id, item.quantidade, item.preco_unitario, item.total]
          );
        }

        // Marca orçamento como convertido
        await client.query(
          `UPDATE orcamentos SET status = 'convertido', convertido_em = NOW(), atualizado_em = NOW() WHERE id = $1 AND empresa_id = $2`,
          [id, empresaResolvida.id]
        );

        await client.query('COMMIT');
        return ok(res, { pedido: pedido.rows[0], mensagem: 'Orçamento convertido em pedido com sucesso' });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[orcamentos] converter:', err.message);
      return erro(res, 500, 'Erro ao converter orçamento em pedido');
    }
  });

  return router;
};
