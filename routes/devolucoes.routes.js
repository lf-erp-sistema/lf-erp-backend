/**
 * Devoluções — LF ERP
 * Montado em /devolucoes.
 *
 * Rotas:
 *   GET  /devolucoes                — listar devoluções
 *   POST /devolucoes                — registrar devolução (restaura estoque)
 *   GET  /devolucoes/:id            — detalhe com itens
 *   GET  /devolucoes/venda/:vendaId — devoluções de uma venda específica
 */

const { estornarPontosFidelidade } = require('../utils/fidelidade');
const { requirePermissao } = require('../utils/permissoes');
const { erro, ok } = require('../utils/routeHelpers');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  normalizarInt,
  registrarMovimentacaoEstoque
}) => {
  const router = require('express').Router();



  async function getEmpresa(req) {
    return validarAcessoEmpresa(req, req.query.empresa || req.body?.empresa, req.empresa_id);
  }

  // ── GET /devolucoes/venda/:vendaId — deve vir ANTES de /:id ────────────────
  router.get('/venda/:vendaId', auth, requirePermissao(pool, 'vendas', 'ver'), async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT d.*, COUNT(di.id) AS total_itens
         FROM devolucoes d
         LEFT JOIN devolucao_itens di ON di.devolucao_id = d.id
         WHERE (d.empresa_id = $1 OR (d.empresa_id IS NULL AND d.empresa = $3)) AND d.venda_id = $2
         GROUP BY d.id ORDER BY d.criado_em DESC`,
        [emp.id, Number(req.params.vendaId), emp.nome]
      );

      return ok(res, { devolucoes: result.rows });
    } catch (err) {
      console.error('[devolucoes] GET venda:', err.message);
      return erro(res, 500, 'Erro ao buscar devoluções da venda');
    }
  });

  // ── GET /devolucoes ───────────────────────────────────────────────────────
  router.get('/', auth, requirePermissao(pool, 'vendas', 'ver'), async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const pagina = Math.max(parseInt(req.query.pagina) || 1, 1);
      const limite = Math.min(Math.max(parseInt(req.query.limite) || 20, 1), 100);
      const offset = (pagina - 1) * limite;

      const [countResult, result] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) FROM devolucoes d
           WHERE (d.empresa_id = $1 OR (d.empresa_id IS NULL AND d.empresa = $2))`,
          [emp.id, emp.nome]
        ),
        pool.query(
          `SELECT d.*, COUNT(di.id) AS total_itens
           FROM devolucoes d
           LEFT JOIN devolucao_itens di ON di.devolucao_id = d.id
           WHERE (d.empresa_id = $1 OR (d.empresa_id IS NULL AND d.empresa = $2))
           GROUP BY d.id ORDER BY d.criado_em DESC
           LIMIT $3 OFFSET $4`,
          [emp.id, emp.nome, limite, offset]
        )
      ]);

      const total = parseInt(countResult.rows[0].count);

      return ok(res, {
        total,
        pagina,
        paginas: Math.ceil(total / limite),
        devolucoes: result.rows.map((r) => ({
          ...r,
          total_devolvido: Number(r.total_devolvido || 0),
          total_itens:     Number(r.total_itens     || 0)
        }))
      });
    } catch (err) {
      console.error('[devolucoes] GET lista:', err.message);
      return erro(res, 500, 'Erro ao listar devoluções');
    }
  });

  // ── POST /devolucoes ──────────────────────────────────────────────────────
  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'vendas', 'criar'), async (req, res) => {
    const { venda_id, motivo, itens = [] } = req.body;

    if (!venda_id) return erro(res, 400, 'venda_id é obrigatório');
    if (!Array.isArray(itens) || itens.length === 0) return erro(res, 400, 'Informe ao menos um item para devolver');

    const emp = await getEmpresa(req);
    if (!emp) return erro(res, 403, 'Sem acesso');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Carrega venda e seus itens originais — FOR UPDATE serializa devoluções simultâneas da mesma venda
      const vendaRes = await client.query(
        `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) FOR UPDATE`,
        [Number(venda_id), emp.id, emp.nome]
      );
      if (vendaRes.rowCount === 0) { await client.query('ROLLBACK'); return erro(res, 404, 'Venda não encontrada'); }
      const venda = vendaRes.rows[0];

      const itensVendaRes = await client.query(
        `SELECT vi.*, p.tem_grade FROM venda_itens vi
         LEFT JOIN produtos p ON p.id = vi.produto_id
         WHERE vi.venda_id = $1 AND (vi.empresa_id = $2 OR (vi.empresa_id IS NULL AND vi.empresa = $3))`,
        [Number(venda_id), emp.id, emp.nome]
      );
      const itensVendaMap = new Map(itensVendaRes.rows.map((i) => [`${Number(i.produto_id)}-${i.grade_id || ''}`, i]));

      // Pré-busca a quantidade já devolvida de cada item da venda em UMA query
      // agregada (evita N+1 — antes era uma query por item dentro do loop abaixo).
      const jaDevolvidoRes = await client.query(
        `SELECT di.produto_id, di.grade_id, COALESCE(SUM(di.quantidade), 0) AS ja_devolvido
         FROM devolucao_itens di
         JOIN devolucoes d ON d.id = di.devolucao_id
         WHERE d.venda_id = $1 AND (di.empresa_id = $2 OR (di.empresa_id IS NULL AND di.empresa = $3))
         GROUP BY di.produto_id, di.grade_id`,
        [Number(venda_id), emp.id, emp.nome]
      );
      const jaDevolvidoMap = new Map(
        jaDevolvidoRes.rows.map((r) => [`${Number(r.produto_id)}-${r.grade_id || ''}`, Number(r.ja_devolvido || 0)])
      );

      // Valida e prepara itens a devolver
      let totalDevolvido = 0;
      const itensValidados = [];

      for (const item of itens) {
        const produtoId = Number(item.produto_id);
        const gradeId   = item.grade_id ? Number(item.grade_id) : null;
        const qtd       = normalizarDecimal(item.quantidade);

        if (!produtoId || qtd <= 0) continue;

        // Encontra o item original na venda (O(1) via Map keyed por produto_id-grade_id)
        const original = itensVendaMap.get(`${produtoId}-${gradeId || ''}`);
        if (!original) { await client.query('ROLLBACK'); return erro(res, 400, `Produto ${produtoId} não encontrado na venda`); }
        if (qtd > Number(original.quantidade)) { await client.query('ROLLBACK'); return erro(res, 400, `Quantidade a devolver (${qtd}) maior que a vendida (${original.quantidade}) para ${original.produto_nome}`); }

        // Quantidade já devolvida anteriormente para este item (pré-buscada acima)
        const jaDevolvido = jaDevolvidoMap.get(`${produtoId}-${gradeId || ''}`) || 0;
        const disponivelParaDevolucao = Number(original.quantidade) - jaDevolvido;
        if (qtd > disponivelParaDevolucao) {
          await client.query('ROLLBACK');
          return erro(res, 400, `Quantidade a devolver (${qtd}) excede o disponível (${disponivelParaDevolucao}) para ${original.produto_nome}. Já devolvido: ${jaDevolvido}.`);
        }

        const preco = Number(original.preco_unitario || 0);
        const total = +(qtd * preco).toFixed(2);
        totalDevolvido += total;

        itensValidados.push({ produtoId, gradeId, qtd, preco, total, produto_nome: original.produto_nome, tem_grade: original.tem_grade });
      }

      if (itensValidados.length === 0) { await client.query('ROLLBACK'); return erro(res, 400, 'Nenhum item válido para devolução'); }

      // Advisory lock garante numeração serial por empresa sem FOR UPDATE em aggregate
      await client.query(`SELECT pg_advisory_xact_lock($1, 9001)`, [emp.id]);
      const numRes = await client.query(
        `SELECT COALESCE(MAX(numero), 0) + 1 AS proximo FROM devolucoes
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`,
        [emp.id, emp.nome]
      );
      const numero = numRes.rows[0].proximo;

      // Cria o registro de devolução
      const devRes = await client.query(
        `INSERT INTO devolucoes (empresa_id, empresa, venda_id, numero, cliente_id, cliente_nome, motivo, total_devolvido, criado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [emp.id, emp.nome, Number(venda_id), numero, venda.cliente_id || null, venda.cliente_nome || null,
         motivo || null, +totalDevolvido.toFixed(2), req.user.id]
      );
      const devolucao = devRes.rows[0];

      // Insere itens e restaura estoque
      for (const item of itensValidados) {
        await client.query(
          `INSERT INTO devolucao_itens (devolucao_id, empresa_id, empresa, produto_id, produto_nome, grade_id, quantidade, preco_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [devolucao.id, emp.id, emp.nome, item.produtoId, item.produto_nome, item.gradeId, item.qtd, item.preco, item.total]
        );

        // Restaura estoque do produto
        if (item.tem_grade && item.gradeId) {
          await client.query(
            `UPDATE produto_grades SET estoque = estoque + $1, atualizado_em = NOW() WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))`,
            [item.qtd, item.gradeId, emp.id, emp.nome]
          );
          await client.query(
            `UPDATE produtos SET estoque = (SELECT COALESCE(SUM(estoque),0) FROM produto_grades WHERE produto_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND ativo = true), atualizado_em = NOW()
             WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
            [item.produtoId, emp.id, emp.nome]
          );
        } else {
          await client.query(
            `UPDATE produtos SET estoque = estoque + $1, atualizado_em = NOW() WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))`,
            [item.qtd, item.produtoId, emp.id, emp.nome]
          );
        }
        if (typeof registrarMovimentacaoEstoque === 'function') {
          await registrarMovimentacaoEstoque({
            empresa: emp.nome, empresa_id: emp.id,
            produto_id: item.produtoId, tipo: 'devolucao', quantidade: item.qtd,
            observacao: `Devolução #${devolucao.id}`,
            referencia_tipo: 'devolucao', referencia_id: devolucao.id,
            usuario_id: req.user.id, client
          });
        }
      }

      // Cria lançamento financeiro de devolução (despesa = saída de caixa para devolver ao cliente)
      if (totalDevolvido > 0) {
        await client.query(
          `INSERT INTO lancamentos_financeiros
             (empresa, empresa_id, tipo, descricao, valor, vencimento, status, categoria, observacao)
           VALUES ($1,$2,'despesa',$3,$4,(NOW() AT TIME ZONE 'America/Fortaleza') + INTERVAL '3 days','pendente','Devoluções',$5)`,
          [
            emp.nome,
            emp.id,
            `Devolução #${numero} — ${venda.cliente_nome || 'Cliente'}`,
            +totalDevolvido.toFixed(2),
            motivo || null
          ]
        );

        // RF-A2: reduzir contas_receber pendentes da venda pelo valor devolvido
        const crPendentesRes = await client.query(
          `SELECT id, valor FROM contas_receber
           WHERE venda_id = $1
             AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
             AND LOWER(COALESCE(status, 'pendente')) NOT IN ('pago')
           ORDER BY data_vencimento ASC NULLS LAST`,
          [Number(venda_id), emp.id, emp.nome]
        );

        if (crPendentesRes.rowCount > 0) {
          let restante = +totalDevolvido.toFixed(2);
          for (const cr of crPendentesRes.rows) {
            if (restante <= 0) break;
            const valorCr = +Number(cr.valor || 0).toFixed(2);
            const reducao = +Math.min(valorCr, restante).toFixed(2);
            const novoValor = +(valorCr - reducao).toFixed(2);
            restante = +(restante - reducao).toFixed(2);
            const nota = `Devolução #${numero} — redução R$ ${reducao.toFixed(2)}`;

            if (novoValor <= 0) {
              await client.query(
                `UPDATE contas_receber
                 SET valor = 0, status = 'pago',
                     data_pagamento = (NOW() AT TIME ZONE 'America/Fortaleza')::DATE,
                     observacao = CASE WHEN observacao IS NULL THEN $2 ELSE observacao || ' | ' || $2 END,
                     atualizado_em = NOW()
                 WHERE id = $1 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))`,
                [cr.id, `Cancelado por Devolução #${numero}`, emp.id, emp.nome]
              );
            } else {
              await client.query(
                `UPDATE contas_receber
                 SET valor = $2,
                     observacao = CASE WHEN observacao IS NULL THEN $3 ELSE observacao || ' | ' || $3 END,
                     atualizado_em = NOW()
                 WHERE id = $1 AND (empresa_id = $4 OR (empresa_id IS NULL AND empresa = $5))`,
                [cr.id, novoValor, nota, emp.id, emp.nome]
              );
            }
          }
        }
      }

      await client.query('COMMIT');

      // Estorna comissão proporcionalmente para comissões pendentes da venda
      if (Number(venda.total) > 0 && totalDevolvido > 0) {
        pool.query(
          `UPDATE comissoes
           SET valor = GREATEST(0, valor - valor * ($1::numeric / NULLIF($2::numeric, 0))),
               status = CASE
                 WHEN GREATEST(0, valor - valor * ($1::numeric / NULLIF($2::numeric, 0))) = 0 THEN 'cancelado'
                 ELSE status
               END,
               observacao = COALESCE(observacao, '') || ' | Reduzido por Devolução #' || $3::text,
               atualizado_em = NOW()
           WHERE venda_id = $4 AND empresa_id = $5 AND status = 'pendente'`,
          [+totalDevolvido.toFixed(2), Number(venda.total), numero, Number(venda_id), emp.id]
        ).catch((e) => console.error(`[comissoes] falha estorno devolucao=${devolucao.id}:`, e.message));
      }

      // Estorna pontos de fidelidade em background (idempotente, não bloqueia a resposta)
      if (venda.cliente_id) {
        estornarPontosFidelidade(pool, {
          empresaId:      emp.id,
          clienteId:      venda.cliente_id,
          vendaId:        Number(venda_id),
          devolucaoId:    devolucao.id,
          totalDevolvido: +totalDevolvido.toFixed(2),
          vendaTotal:     Number(venda.total || 0)
        }).catch((e) => console.error(`[fidelidade] falha estorno devolucao=${devolucao.id}:`, e.message));
      }

      return ok(res, {
        devolucao: { ...devolucao, total_devolvido: +totalDevolvido.toFixed(2) },
        mensagem: `Devolução #${numero} registrada. Estoque restaurado.`
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[devolucoes] POST:', err.message);
      return erro(res, 500, 'Erro ao registrar devolução');
    } finally {
      client.release();
    }
  });

  // ── GET /devolucoes/:id ───────────────────────────────────────────────────
  router.get('/:id', auth, requirePermissao(pool, 'vendas', 'ver'), async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const [devRes, itensRes] = await Promise.all([
        pool.query(`SELECT * FROM devolucoes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`, [Number(req.params.id), emp.id, emp.nome]),
        pool.query(`SELECT * FROM devolucao_itens WHERE devolucao_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`, [Number(req.params.id), emp.id, emp.nome])
      ]);

      if (devRes.rowCount === 0) return erro(res, 404, 'Devolução não encontrada');

      return ok(res, { devolucao: { ...devRes.rows[0], itens: itensRes.rows } });
    } catch (err) {
      console.error('[devolucoes] GET :id:', err.message);
      return erro(res, 500, 'Erro ao buscar devolução');
    }
  });

  return router;
};
