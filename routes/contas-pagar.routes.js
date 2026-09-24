'use strict';
const express = require('express');
const { normalizarInt, normalizarDecimal, normalizarDataISO, hoje } = require('../utils/normalizadores');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');
const { requirePermissao } = require('../utils/permissoes');
const { dispararWebhookComRetry } = require('../utils/webhookContabil');
const { jsonErro, erroFromException } = require('../utils/routeHelpers');

module.exports = function contasPagarRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, atualizarStatusContasPagarPorEmpresa,
  registrarLogFinanceiro
}) {
  const router = express.Router();
router.get('/contas-pagar-fornecedores/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          id,
          nome
        FROM fornecedores
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
          AND deletado_em IS NULL
        ORDER BY nome ASC
        `,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar fornecedores de contas a pagar:', error);
    jsonErro(res, 500, 'Erro ao buscar fornecedores');
  }
});

router.get('/contas-pagar/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    try {
      await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id);
    } catch (statusErr) {
      console.error('[status-cp] Erro não-crítico ao atualizar status:', statusErr.message);
    }

    const status = (req.query.status || '').trim().toLowerCase();
    const fornecedor = (req.query.fornecedor || '').trim().toLowerCase();
    const fornecedorId = normalizarInt(req.query.fornecedor_id || 0);
    const busca = (req.query.busca || '').trim().toLowerCase();
    const { dataInicial, dataFinal } = obterPeriodo(req);

    let sql = `
      SELECT
        cp.*,
        c.id AS compra_origem_id,
        c.data AS compra_data,
        c.total AS compra_total,
        CASE
          WHEN LOWER(COALESCE(cp.status, 'pendente')) = 'pago' THEN 'pago'
          WHEN LOWER(COALESCE(cp.status, 'pendente')) = 'parcial'
            AND cp.data_vencimento IS NOT NULL AND cp.data_vencimento < $2 THEN 'parcial_atrasado'
          WHEN LOWER(COALESCE(cp.status, 'pendente')) = 'parcial' THEN 'parcial'
          WHEN cp.data_vencimento IS NOT NULL AND cp.data_vencimento < $2 THEN 'atrasado'
          ELSE 'pendente'
        END AS status_exibicao
      FROM contas_pagar cp
      LEFT JOIN compras c
        ON c.id = cp.compra_id
       AND (c.empresa_id = cp.empresa_id OR (cp.empresa_id IS NULL AND c.empresa = cp.empresa))
      WHERE (cp.empresa_id = $3 OR (cp.empresa_id IS NULL AND cp.empresa = $1))
    `;

    const params = [empresaResolvida.nome, hoje(), empresaResolvida.id];
    let idx = 4;

    if (status === 'pago') {
      sql += ` AND LOWER(COALESCE(cp.status, 'pendente')) = 'pago' `;
    } else if (status === 'pendente') {
      sql += `
        AND LOWER(COALESCE(cp.status, 'pendente')) <> 'pago'
        AND (cp.data_vencimento IS NULL OR cp.data_vencimento >= $2)
      `;
    } else if (status === 'atrasado') {
      sql += `
        AND LOWER(COALESCE(cp.status, 'pendente')) <> 'pago'
        AND cp.data_vencimento IS NOT NULL
        AND cp.data_vencimento < $2
      `;
    } else if (status === 'parcial') {
      sql += ` AND LOWER(COALESCE(cp.status, 'pendente')) = 'parcial' AND (cp.data_vencimento IS NULL OR cp.data_vencimento >= $2) `;
    } else if (status === 'parcial_atrasado') {
      sql += ` AND LOWER(COALESCE(cp.status, 'pendente')) = 'parcial' AND cp.data_vencimento IS NOT NULL AND cp.data_vencimento < $2 `;
    }

    if (fornecedorId > 0) {
      sql += ` AND cp.fornecedor_id = $${idx} `;
      params.push(fornecedorId);
      idx++;
    }

    if (fornecedor) {
      const fornecedorEsc = fornecedor.replace(/[%_\\]/g, '\\$&');
      sql += ` AND LOWER(COALESCE(cp.fornecedor_nome, '')) LIKE $${idx} ESCAPE '\\' `;
      params.push(`%${fornecedorEsc}%`);
      idx++;
    }

    if (busca) {
      const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
      sql += `
        AND (
          LOWER(COALESCE(cp.fornecedor_nome, '')) LIKE $${idx} ESCAPE '\\'
          OR LOWER(COALESCE(cp.observacao, '')) LIKE $${idx} ESCAPE '\\'
          OR LOWER(COALESCE(cp.descricao, '')) LIKE $${idx} ESCAPE '\\'
          OR CAST(cp.id AS TEXT) LIKE $${idx} ESCAPE '\\'
          OR CAST(cp.compra_id AS TEXT) LIKE $${idx} ESCAPE '\\'
        )
      `;
      params.push(`%${buscaEsc}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodo({
      campo: 'cp.data_vencimento',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const paginaCP = Math.max(1, normalizarInt(req.query.page || 1));
    const limiteCP = Math.min(normalizarInt(req.query.limit) || 50, 200);

    const filterParamsCP = [...params];
    const resumoGlobalSqlCP = `
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(q.valor),0)::numeric AS total_valor,
        COALESCE(SUM(CASE WHEN q.status_exibicao='pago' THEN q.valor ELSE 0 END),0)::numeric AS total_pago,
        COALESCE(SUM(CASE WHEN q.status_exibicao IN ('atrasado','parcial_atrasado') THEN q.valor ELSE 0 END),0)::numeric AS total_atrasado,
        COALESCE(SUM(CASE WHEN q.status_exibicao NOT IN ('pago','atrasado','parcial_atrasado') THEN q.valor ELSE 0 END),0)::numeric AS total_pendente,
        COUNT(CASE WHEN q.status_exibicao='pago' THEN 1 END)::int AS qtd_pago,
        COUNT(CASE WHEN q.status_exibicao IN ('atrasado','parcial_atrasado') THEN 1 END)::int AS qtd_atrasado,
        COUNT(CASE WHEN q.status_exibicao NOT IN ('pago','atrasado','parcial_atrasado') THEN 1 END)::int AS qtd_pendente
      FROM (${sql}) AS q
    `;

    const offsetCP = (paginaCP - 1) * limiteCP;
    const sqlPaginadoCP = sql + ` ORDER BY cp.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limiteCP, offsetCP);

    const [resultCP, resumoGlobalResultCP] = await Promise.all([
      pool.query(sqlPaginadoCP, params),
      pool.query(resumoGlobalSqlCP, filterParamsCP)
    ]);

    const result = resultCP;

    const contas = result.rows.map((row) => ({
      ...row,
      valor: Number(row.valor || 0),
      parcela: Number(row.parcela || 1),
      total_parcelas: Number(row.total_parcelas || 1),
      compra_total: Number(row.compra_total || 0),
      status: row.status_exibicao
    }));

    const rgCP = resumoGlobalResultCP.rows[0];
    const resumo = {
      total:          Number(rgCP.total_valor || 0),
      total_pago:     Number(rgCP.total_pago || 0),
      total_pendente: Number(rgCP.total_pendente || 0),
      total_atrasado: Number(rgCP.total_atrasado || 0),
      qtd_pago:       Number(rgCP.qtd_pago || 0),
      qtd_pendente:   Number(rgCP.qtd_pendente || 0),
      qtd_atrasado:   Number(rgCP.qtd_atrasado || 0)
    };

    res.json({
      contas,
      resumo,
      paginacao: {
        pagina: paginaCP,
        limite: limiteCP,
        total: Number(rgCP.total || 0),
        total_paginas: Math.ceil(Number(rgCP.total || 0) / limiteCP) || 1
      }
    });
  } catch (error) {
    console.error('Erro ao buscar contas a pagar:', error);
    erroFromException(res, error, 'Erro ao buscar contas a pagar');
  }
});

router.get('/contas-pagar/detalhe/:id', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const _cpEmpresaId = req.user?.is_saas_owner ? null : (req.user?.empresa_id ?? 0);
    const _cpEmpresaNome = req.user?.is_saas_owner ? '' : (req.user?.empresa || '');
    const _cpEmpresaWhere = !req.user?.is_saas_owner ? 'AND (cp.empresa_id = $3 OR (cp.empresa_id IS NULL AND cp.empresa = $4))' : '';
    const _cpParams = !req.user?.is_saas_owner ? [id, hoje(), _cpEmpresaId, _cpEmpresaNome] : [id, hoje()];

    const contaResult = await pool.query(
      `
        SELECT
          cp.*,
          CASE
            WHEN LOWER(COALESCE(cp.status, 'pendente')) = 'pago' THEN 'pago'
            WHEN LOWER(COALESCE(cp.status, 'pendente')) = 'parcial'
              AND cp.data_vencimento IS NOT NULL AND cp.data_vencimento < $2 THEN 'parcial_atrasado'
            WHEN LOWER(COALESCE(cp.status, 'pendente')) = 'parcial' THEN 'parcial'
            WHEN cp.data_vencimento IS NOT NULL AND cp.data_vencimento < $2 THEN 'atrasado'
            ELSE 'pendente'
          END AS status_exibicao
        FROM contas_pagar cp
        WHERE cp.id = $1 ${_cpEmpresaWhere}
        LIMIT 1
        `,
      _cpParams
    );

    if (contaResult.rowCount === 0) {
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    if (!await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id)) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    res.json({
      ...conta,
      valor: Number(conta.valor || 0),
      parcela: Number(conta.parcela || 1),
      total_parcelas: Number(conta.total_parcelas || 1),
      status: conta.status_exibicao
    });
  } catch (error) {
    console.error('Erro ao buscar detalhe da conta a pagar:', error);
    jsonErro(res, 500, 'Erro ao buscar detalhe da conta');
  }
});

router.get('/contas-pagar/origem-compra/:id', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = req.user.is_saas_owner
      ? await pool.query(`SELECT * FROM contas_pagar WHERE id = $1 LIMIT 1`, [id])
      : await pool.query(
          `SELECT * FROM contas_pagar WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
          [id, req.user.empresa_id || 0, req.user.empresa || '']
        );

    if (contaResult.rowCount === 0) {
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    if (!await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id)) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (!conta.compra_id) {
      return jsonErro(res, 404, 'Esta conta não possui compra de origem');
    }

    const compraResult = await pool.query(
      `
        SELECT
          c.*,
          f.nome AS fornecedor_nome_origem
        FROM compras c
        LEFT JOIN fornecedores f
          ON f.id = c.fornecedor_id
        AND (f.empresa_id = c.empresa_id OR (f.empresa_id IS NULL AND f.empresa = c.empresa))
        WHERE c.id = $1 AND (c.empresa_id = $2 OR (c.empresa_id IS NULL AND c.empresa = $3))
        LIMIT 1
        `,
      [conta.compra_id, conta.empresa_id, conta.empresa]
    );

    if (compraResult.rowCount === 0) {
      return jsonErro(res, 404, 'Compra de origem não encontrada');
    }

    const itensResult = await pool.query(
      `
        SELECT *
        FROM compra_itens
        WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        ORDER BY id ASC
        `,
      [conta.compra_id, conta.empresa_id || 0, conta.empresa || '']
    );

    const parcelasResult = await pool.query(
      `
        SELECT *
        FROM contas_pagar
        WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        ORDER BY parcela ASC, id ASC
        `,
      [conta.compra_id, conta.empresa_id, conta.empresa]
    );

    res.json({
      conta: {
        ...conta,
        valor: Number(conta.valor || 0),
        parcela: Number(conta.parcela || 1),
        total_parcelas: Number(conta.total_parcelas || 1)
      },
      compra: {
        ...compraResult.rows[0],
        total: Number(compraResult.rows[0].total || 0)
      },
      itens: itensResult.rows.map((item) => ({
        ...item,
        quantidade: Number(item.quantidade || 0),
        custo_unitario: Number(item.custo_unitario || 0),
        subtotal: Number(item.subtotal || 0)
      })),
      parcelas: parcelasResult.rows.map((item) => ({
        ...item,
        valor: Number(item.valor || 0),
        parcela: Number(item.parcela || 1),
        total_parcelas: Number(item.total_parcelas || 1)
      }))
    });
  } catch (error) {
    console.error('Erro ao buscar origem da compra:', error);
    jsonErro(res, 500, 'Erro ao buscar origem da compra');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /contas-pagar/manual — criação manual (avulsa, parcelada ou fixa mensal)
// ─────────────────────────────────────────────────────────────────────────
router.post('/contas-pagar/manual', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  const {
    empresa: empresaParam,
    empresa_id: empresaIdParam,
    fornecedor_id,
    fornecedor_nome,
    descricao,
    observacao,
    forma_pagamento,
    valor,
    data_vencimento,
    recorrencia = 'nao_recorrente', // nao_recorrente | parcelar | fixa_mensal
    tipo_valor   = 'parcela',       // parcela | total
    parcela_inicial = 1,
    quantidade   = 1,
    periodicidade = 30              // dias entre parcelas
  } = req.body || {};

  const empresaResolvida = await validarAcessoEmpresa(req, empresaParam, empresaIdParam ? Number(empresaIdParam) : undefined);
  if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

  const valorNum = normalizarDecimal(valor);
  if (!valorNum || valorNum <= 0) return jsonErro(res, 400, 'Valor inválido');

  const dataBase = normalizarDataISO(data_vencimento);
  if (!dataBase) return jsonErro(res, 400, 'Data de vencimento inválida');

  const nomeFormatado = (fornecedor_nome || '').trim() || 'Avulso';
  const fornId = normalizarInt(fornecedor_id) || null;
  const qtd    = Math.min(360, Math.max(1, normalizarInt(quantidade) || 1));
  const parcIni = Math.min(qtd, Math.max(1, normalizarInt(parcela_inicial) || 1));
  const periodo = Math.max(1, normalizarInt(periodicidade) || 30);
  const desc   = (descricao || '').trim() || 'Conta a pagar';
  const obs    = (observacao || '').trim();
  const forma  = (forma_pagamento || '').trim() || null;

  // Quantas linhas criar
  let linhas;
  if (recorrencia === 'parcelar') {
    // Parcelas que faltam: de parcIni até qtd (total)
    linhas = qtd - parcIni + 1;
  } else if (recorrencia === 'fixa_mensal') {
    linhas = qtd; // cada linha é independente (parcela 1/1)
  } else {
    linhas = 1;
  }
  linhas = Math.max(1, linhas);

  // Valor por linha
  let valorLinha;
  if (tipo_valor === 'total' && recorrencia === 'parcelar' && qtd > 1) {
    valorLinha = Number((valorNum / qtd).toFixed(2));
  } else {
    valorLinha = valorNum;
  }
  // Ajuste de centavos na última linha (somente quando total dividido)
  const valorUltima = (tipo_valor === 'total' && recorrencia === 'parcelar' && qtd > 1)
    ? Number((valorNum - valorLinha * (linhas - 1)).toFixed(2))
    : valorLinha;

  function addDias(isoDate, dias) {
    const d = new Date(`${isoDate}T12:00:00`);
    d.setDate(d.getDate() + dias);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const criadas = [];
    for (let i = 0; i < linhas; i++) {
      const numParcela = recorrencia === 'parcelar' ? parcIni + i : 1;
      const totParcelas = recorrencia === 'parcelar' ? qtd : 1;
      const venc = i === 0 ? dataBase : addDias(dataBase, i * periodo);
      const valorInsert = (i === linhas - 1) ? valorUltima : valorLinha;
      const descInsert = recorrencia === 'parcelar'
        ? `${desc} — Parcela ${numParcela}/${totParcelas}`
        : recorrencia === 'fixa_mensal'
          ? `${desc} — Mês ${i + 1}`
          : desc;

      const r = await client.query(
        `INSERT INTO contas_pagar
           (empresa, empresa_id, fornecedor_id, fornecedor_nome, descricao,
            parcela, total_parcelas, valor, valor_original,
            data_vencimento, status, forma_pagamento, observacao,
            criado_por, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,'pendente',$10,$11,$12,
                 NOW() AT TIME ZONE 'America/Fortaleza',
                 NOW() AT TIME ZONE 'America/Fortaleza')
         RETURNING id`,
        [
          empresaResolvida.nome, empresaResolvida.id,
          fornId, nomeFormatado, descInsert,
          numParcela, totParcelas,
          valorInsert, venc,
          forma, obs, req.user?.id || null
        ]
      );
      criadas.push(r.rows[0].id);
    }

    await client.query('COMMIT');

    try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch {}

    res.json({ sucesso: true, ids: criadas, mensagem: `${criadas.length} título(s) criado(s)` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[cp-manual] Erro:', err.message);
    jsonErro(res, 500, 'Erro ao criar conta a pagar');
  } finally {
    client.release();
  }
});

router.post('/contas-pagar/pagar/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) return jsonErro(res, 400, 'ID inválido');

  const client = await pool.connect();
  try {

    await client.query('BEGIN');

    const contaResult = req.user?.is_saas_owner
      ? await client.query(
          `SELECT * FROM contas_pagar WHERE id = $1 FOR UPDATE`,
          [id]
        )
      : await client.query(
          `SELECT * FROM contas_pagar
           WHERE id = $1
             AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
           FOR UPDATE`,
          [id, req.user.empresa_id || 0, req.user.empresa || '']
        );

    if (contaResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];
    // Para não-saas_owner a conta já foi filtrada por empresa_id no FOR UPDATE —
    // evitar query DB dentro da transação com lock para reduzir risco de deadlock.
    let empresaResolvida;
    if (req.user?.is_saas_owner) {
      empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);
    } else {
      empresaResolvida = { id: req.user.empresa_id || conta.empresa_id || 0, nome: req.user.empresa || conta.empresa || '' };
    }

    if (!empresaResolvida) {
      await client.query('ROLLBACK');
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (String(conta.status || '').toLowerCase() === 'pago') {
      await client.query('ROLLBACK');
      return jsonErro(res, 400, 'Esta conta já está paga');
    }

    const dataPagamento = normalizarDataISO(req.body?.data_pagamento) || hoje();
    const valorAtualCP = normalizarDecimal(conta.valor || 0);
    const valorPagoCP = normalizarDecimal(req.body?.valor_pago || 0);
    if (valorPagoCP > 0 && valorPagoCP > valorAtualCP) {
      await client.query('ROLLBACK');
      return jsonErro(res, 400, 'Valor pago não pode ser maior que o saldo da conta');
    }
    const valorPagoFinal = valorPagoCP > 0 ? valorPagoCP : valorAtualCP;
    const pagamentoTotalCP = valorPagoFinal >= valorAtualCP;
    const novoValorCP = pagamentoTotalCP ? valorAtualCP : Number((valorAtualCP - valorPagoFinal).toFixed(2));
    const novoStatusCP = pagamentoTotalCP ? 'pago' : 'parcial';

    await client.query(
      `
      UPDATE contas_pagar
      SET status = $1,
          valor_original = COALESCE(valor_original, valor),
          valor = $2,
          data_pagamento = CASE WHEN $1 = 'pago' THEN $3 ELSE data_pagamento END,
          atualizado_em = NOW()
      WHERE id = $4
        AND (empresa_id = $5 OR (empresa_id IS NULL AND empresa = $6))
      `,
      [novoStatusCP, novoValorCP, dataPagamento, id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `INSERT INTO lancamentos_financeiros
        (empresa, empresa_id, tipo, categoria, descricao, valor, vencimento, pagamento_data, status, conta_pagar_id, criado_em, atualizado_em)
        VALUES ($1, $2, 'despesa', 'contas_pagar', $3, $4, $5, $6, 'pago', $7,
                NOW() AT TIME ZONE 'America/Fortaleza', NOW() AT TIME ZONE 'America/Fortaleza')`,
      [
        empresaResolvida.nome,
        empresaResolvida.id,
        pagamentoTotalCP ? `Pagamento total - ${conta.descricao || ''}` : `Pagamento parcial - ${conta.descricao || ''}`,
        valorPagoFinal,
        conta.data_vencimento || dataPagamento,
        dataPagamento,
        id
      ]
    );

    await client.query('COMMIT');

    try {
      await registrarLogFinanceiro({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        tipo: pagamentoTotalCP ? 'baixa' : 'baixa_parcial',
        entidade: 'contas_pagar',
        entidade_id: id,
        descricao: pagamentoTotalCP
          ? `Baixa total da conta a pagar #${id}`
          : `Baixa parcial da conta a pagar #${id}`,
        valor: valorPagoFinal,
        usuario_id: req.user?.id
      });
    } catch (logErr) {
      console.error('[cp-pagar] log financeiro:', logErr.message);
    }

    // Notifica integração contábil em background
    dispararWebhookComRetry(pool, empresaResolvida.id, 'pagamento.registrado', {
      id, valor: valorPagoFinal, fornecedor: conta.fornecedor
    }).catch((e) => console.error(`[webhook-contabil] pagamento=${id}:`, e.message));

    try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[cp-pagar] status-cp:', e.message); }

    const contaAtualizadaResult = await pool.query(
      `
      SELECT
        *,
        CASE
          WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN 'pago'
          WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial'
            AND data_vencimento IS NOT NULL
            AND data_vencimento < $2 THEN 'parcial_atrasado'
          WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial' THEN 'parcial'
          WHEN data_vencimento IS NOT NULL AND data_vencimento < $2 THEN 'atrasado'
          ELSE 'pendente'
        END AS status_exibicao
      FROM contas_pagar
      WHERE id = $1
        AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
      `,
      [id, hoje(), empresaResolvida.id, empresaResolvida.nome]
    );

    const contaAtualizada = contaAtualizadaResult.rows[0];

    res.json({
      sucesso: true,
      mensagem: pagamentoTotalCP ? 'Conta paga com sucesso' : 'Baixa parcial registrada com sucesso',
      conta: {
        ...contaAtualizada,
        valor: Number(contaAtualizada.valor || 0),
        valor_original: Number(contaAtualizada.valor_original || 0),
        parcela: Number(contaAtualizada.parcela || 1),
        total_parcelas: Number(contaAtualizada.total_parcelas || 1),
        status: contaAtualizada.status_exibicao
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao pagar conta:', error);
    jsonErro(res, 500, 'Erro ao pagar conta');
  } finally {
    client.release();
  }
});

  return router;
};
