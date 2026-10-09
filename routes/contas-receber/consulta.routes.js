'use strict';
const express = require('express');
const { normalizarInt, hoje } = require('../../utils/normalizadores');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../../utils/periodoUtils');
const { requirePermissao } = require('../../utils/permissoes');
const { jsonErro, erroFromException } = require('../../utils/routeHelpers');

// Parte 1/3 de contas-receber.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// consultas/listagem (GET) — leitura da listagem paginada, detalhe, origem de venda,
// histórico de cliente, promissórias agrupadas e recebimentos parciais de uma conta.
module.exports = function contasReceberConsultaRoutes({
  auth, pool,
  validarAcessoEmpresa, atualizarStatusContasReceberPorEmpresa,
  podeGerenciarFinanceiro
}) {
  const router = express.Router();

  router.get('/contas-receber-clientes/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
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
          FROM clientes
          WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
            AND deletado_em IS NULL
          ORDER BY nome ASC
          LIMIT 500
          `,
        [empresaResolvida.id, empresaResolvida.nome]
      );

      res.json(result.rows);
    } catch (error) {
      console.error('Erro ao buscar clientes de contas a receber:', error);
      jsonErro(res, 500, 'Erro ao buscar clientes');
    }
  });

  // ── GET /contas-receber/promissorias — visão agrupada por cliente ─────────────
  router.get('/contas-receber/promissorias', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT
           cr.id,
           cr.cliente_id,
           cr.cliente_nome,
           cr.observacao,
           cr.valor,
           cr.valor_original,
           cr.data_vencimento,
           cr.status,
           cr.parcela,
           cr.total_parcelas,
           c.telefone
         FROM contas_receber cr
         LEFT JOIN clientes c ON c.id = cr.cliente_id
           AND (c.empresa_id = cr.empresa_id OR (c.empresa_id IS NULL AND c.empresa = cr.empresa))
         WHERE (cr.empresa_id = $1 OR (cr.empresa_id IS NULL AND cr.empresa = $2))
           AND cr.forma_pagamento ILIKE 'promiss%'
           AND LOWER(COALESCE(cr.status, 'pendente')) NOT IN ('pago', 'cancelado', 'estornado')
         ORDER BY cr.cliente_nome, cr.data_vencimento
         LIMIT 2000`,
        [empresaResolvida.id, empresaResolvida.nome]
      );

      const clienteMap = new Map();
      for (const row of result.rows) {
        const key = row.cliente_id ?? `nome_${row.cliente_nome}`;
        if (!clienteMap.has(key)) {
          clienteMap.set(key, {
            cliente_id:    row.cliente_id,
            cliente_nome:  row.cliente_nome || 'Cliente',
            telefone:      row.telefone || null,
            itens:         [],
            total:         0,
            total_original: 0
          });
        }
        const cli    = clienteMap.get(key);
        const valor  = Number(row.valor || 0);
        const orig   = Number(row.valor_original || valor);
        cli.itens.push({
          id:              row.id,
          descricao:       row.observacao || 'Produto',
          valor,
          valor_original:  orig,
          data_vencimento: row.data_vencimento,
          status:          row.status || 'pendente',
          parcela:         row.parcela,
          total_parcelas:  row.total_parcelas
        });
        cli.total          += valor;
        cli.total_original += orig;
      }

      const clientes = Array.from(clienteMap.values()).map(c => ({
        ...c,
        total:          Math.round(c.total * 100) / 100,
        total_original: Math.round(c.total_original * 100) / 100
      }));

      return res.json({ clientes, empresa: empresaResolvida.nome });
    } catch (err) {
      console.error('[promissorias] GET:', err.message);
      return jsonErro(res, 500, 'Erro ao buscar promissórias');
    }
  });

  router.get('/contas-receber/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return jsonErro(res, 403, 'Sem acesso');
      }

      try {
        await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id);
      } catch (statusErr) {
        console.error('[status-cr] Erro não-crítico ao atualizar status:', statusErr.message);
      }

      const status = (req.query.status || '').trim().toLowerCase();
      const cliente = (req.query.cliente || '').trim().toLowerCase();
      const clienteId = normalizarInt(req.query.cliente_id || 0);
      const busca = (req.query.busca || '').trim().toLowerCase();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      let sql = `
        SELECT
          cr.*,
          v.id AS venda_origem_id,
          v.data AS venda_data,
          v.total AS venda_total,
          v.pagamento AS venda_pagamento,
          CASE
            WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'pago' THEN 'pago'
            WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'parcial'
    AND cr.data_vencimento IS NOT NULL
    AND cr.data_vencimento < $2
  THEN 'parcial_atrasado'

  WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'parcial'
  THEN 'parcial'

  WHEN cr.data_vencimento IS NOT NULL
    AND cr.data_vencimento < $2
  THEN 'atrasado'
            ELSE 'pendente'
          END AS status_exibicao
        FROM contas_receber cr
        LEFT JOIN vendas v
          ON v.id = cr.venda_id
         AND (v.empresa_id = cr.empresa_id OR (cr.empresa_id IS NULL AND v.empresa = cr.empresa))
        WHERE (cr.empresa_id = $3 OR (cr.empresa_id IS NULL AND cr.empresa = $1))
      `;

      const params = [empresaResolvida.nome, hoje(), empresaResolvida.id];
      let idx = 4;

      if (status === 'pago') {
        sql += ` AND LOWER(COALESCE(cr.status, 'pendente')) = 'pago' `;
      } else if (status === 'pendente') {
        sql += `
          AND LOWER(COALESCE(cr.status, 'pendente')) <> 'pago'
          AND (cr.data_vencimento IS NULL OR cr.data_vencimento >= $2)
        `;
      } else if (status === 'atrasado') {
        sql += `
          AND LOWER(COALESCE(cr.status, 'pendente')) <> 'pago'
          AND cr.data_vencimento IS NOT NULL
          AND cr.data_vencimento < $2
        `;
      } else if (status === 'parcial') {
        sql += ` AND LOWER(COALESCE(cr.status, 'pendente')) = 'parcial' AND (cr.data_vencimento IS NULL OR cr.data_vencimento >= $2) `;
      } else if (status === 'parcial_atrasado') {
        sql += ` AND LOWER(COALESCE(cr.status, 'pendente')) = 'parcial' AND cr.data_vencimento IS NOT NULL AND cr.data_vencimento < $2 `;
      }

      if (clienteId > 0) {
        sql += ` AND cr.cliente_id = $${idx} `;
        params.push(clienteId);
        idx++;
      }

      if (cliente) {
        const clienteEsc = cliente.replace(/[%_\\]/g, '\\$&');
        sql += ` AND LOWER(COALESCE(cr.cliente_nome, '')) LIKE $${idx} ESCAPE '\\' `;
        params.push(`%${clienteEsc}%`);
        idx++;
      }

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        sql += `
          AND (
            LOWER(COALESCE(cr.cliente_nome, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(cr.observacao, '')) LIKE $${idx} ESCAPE '\\'
            OR CAST(cr.id AS TEXT) LIKE $${idx} ESCAPE '\\'
            OR CAST(cr.venda_id AS TEXT) LIKE $${idx} ESCAPE '\\'
          )
        `;
        params.push(`%${buscaEsc}%`);
        idx++;
      }

      sql += adicionarFiltroPeriodo({
        campo: 'cr.data_vencimento',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      const pagina = Math.max(1, normalizarInt(req.query.page || 1));
      const limite = Math.min(normalizarInt(req.query.limit) || 50, 200);

      const filterParamsCR = [...params];
      const resumoGlobalSqlCR = `
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

      const offset = (pagina - 1) * limite;
      const sqlPaginado = sql + ` ORDER BY cr.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limite, offset);

      const [result, resumoGlobalResult, recebidosParciaisResult] = await Promise.all([
        pool.query(sqlPaginado, params).catch(e => { console.error('[cr-q1] lista:', e.message); throw e; }),
        pool.query(resumoGlobalSqlCR, filterParamsCR).catch(e => { console.error('[cr-q2] resumo:', e.message); throw e; }),
        pool.query(
          `
    SELECT COALESCE(SUM(lf.valor), 0) AS total
    FROM lancamentos_financeiros lf
    WHERE (lf.empresa_id = $2 OR (lf.empresa_id IS NULL AND lf.empresa = $1))
      AND LOWER(COALESCE(lf.tipo, '')) = 'receita'
      AND LOWER(COALESCE(lf.status, 'pendente')) = 'pago'
      AND LOWER(COALESCE(lf.categoria, '')) = 'contas_receber'
      AND lf.pagamento_data IS NOT NULL
      AND (
        (lf.conta_receber_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM contas_receber cr
          WHERE cr.id = lf.conta_receber_id
            AND (cr.empresa_id = lf.empresa_id OR (cr.empresa_id IS NULL AND cr.empresa = lf.empresa))
        ))
        OR (lf.conta_receber_id IS NULL AND EXISTS (
          SELECT 1 FROM contas_receber cr
          WHERE cr.id = (
            CASE WHEN REGEXP_REPLACE(lf.descricao, '\\D', '', 'g') ~ '^[1-9][0-9]*$'
                 THEN REGEXP_REPLACE(lf.descricao, '\\D', '', 'g')::INTEGER
                 ELSE NULL END
          )
            AND (cr.empresa_id = lf.empresa_id OR (cr.empresa_id IS NULL AND cr.empresa = lf.empresa))
        ))
      )
    `,
          [empresaResolvida.nome, empresaResolvida.id]
        ).catch(e => { console.error('[cr-q3] parciais:', e.message); throw e; })
      ]);

      const contas = result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0),
        parcela: Number(row.parcela || 1),
        total_parcelas: Number(row.total_parcelas || 1),
        venda_total: Number(row.venda_total || 0),
        status: row.status_exibicao
      }));

      const rg = resumoGlobalResult.rows[0];
      const resumo = {
        total:                 Number(rg.total_valor || 0),
        total_pago:            Number(rg.total_pago || 0),
        total_pendente:        Number(rg.total_pendente || 0),
        total_atrasado:        Number(rg.total_atrasado || 0),
        total_recebido_parcial: Number(recebidosParciaisResult.rows[0].total || 0),
        qtd_pago:              Number(rg.qtd_pago || 0),
        qtd_pendente:          Number(rg.qtd_pendente || 0),
        qtd_atrasado:          Number(rg.qtd_atrasado || 0)
      };

      const totalRegistros = Number(rg.total || 0);
      res.json({
        contas,
        resumo,
        paginacao: {
          pagina,
          limite,
          total: totalRegistros,
          total_paginas: Math.ceil(totalRegistros / limite) || 1
        }
      });
    } catch (error) {
      console.error('Erro ao buscar contas a receber:', error);
      erroFromException(res, error, 'Erro ao buscar contas a receber');
    }
  });

  router.get('/contas-receber/detalhe/:id', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const id = Number(req.params.id);

      let _detParams = [id, hoje()];
      let _detEmpresaWhere = '';
      if (!req.user.is_saas_owner) {
        _detParams = [..._detParams, req.user.empresa_id || 0, req.user.empresa || ''];
        _detEmpresaWhere = `AND (cr.empresa_id = $3 OR (cr.empresa_id IS NULL AND cr.empresa = $4))`;
      }

      const contaResult = await pool.query(
        `
          SELECT
            cr.*,
            CASE
              WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'pago'
  THEN 'pago'

  WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'parcial'
    AND cr.data_vencimento IS NOT NULL
    AND cr.data_vencimento < $2
  THEN 'parcial_atrasado'

  WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'parcial'
  THEN 'parcial'

  WHEN cr.data_vencimento IS NOT NULL
    AND cr.data_vencimento < $2
  THEN 'atrasado'

  ELSE 'pendente'
            END AS status_exibicao
          FROM contas_receber cr
          WHERE cr.id = $1 ${_detEmpresaWhere}
          LIMIT 1
          `,
        _detParams
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
      console.error('Erro ao buscar detalhe da conta:', error);
      jsonErro(res, 500, 'Erro ao buscar detalhe da conta');
    }
  });

  router.get('/contas-receber/origem-venda/:id', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const id = Number(req.params.id);

      const contaResult = req.user.is_saas_owner
        ? await pool.query(`SELECT * FROM contas_receber WHERE id = $1 LIMIT 1`, [id])
        : await pool.query(
            `SELECT * FROM contas_receber WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (contaResult.rowCount === 0) {
        return jsonErro(res, 404, 'Conta não encontrada');
      }

      const conta = contaResult.rows[0];

      if (!await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id)) {
        return jsonErro(res, 403, 'Sem acesso');
      }

      if (!conta.venda_id) {
        return jsonErro(res, 404, 'Esta conta não possui venda de origem');
      }

      const vendaResult = await pool.query(
        `
          SELECT *
          FROM vendas
          WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
          LIMIT 1
          `,
        [conta.venda_id, conta.empresa_id, conta.empresa]
      );

      if (vendaResult.rowCount === 0) {
        return jsonErro(res, 404, 'Venda de origem não encontrada');
      }

      const itensResult = await pool.query(
        `
          SELECT
            vi.*,
            p.categoria,
            p.codigo_barras
          FROM venda_itens vi
          LEFT JOIN produtos p
            ON p.id = vi.produto_id
            AND (p.empresa_id = vi.empresa_id OR p.empresa = vi.empresa)
          WHERE vi.venda_id = $1 AND (vi.empresa_id = $2 OR (vi.empresa_id IS NULL AND vi.empresa = $3))
          ORDER BY vi.id ASC
          `,
        [conta.venda_id, conta.empresa_id, conta.empresa]
      );

      const parcelasResult = await pool.query(
        `
          SELECT *
          FROM contas_receber
          WHERE venda_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
          ORDER BY parcela ASC, id ASC
          `,
        [conta.venda_id, conta.empresa_id, conta.empresa]
      );

      res.json({
        conta: {
          ...conta,
          valor: Number(conta.valor || 0),
          parcela: Number(conta.parcela || 1),
          total_parcelas: Number(conta.total_parcelas || 1)
        },
        venda: {
          ...vendaResult.rows[0],
          subtotal: Number(vendaResult.rows[0].subtotal || 0),
          desconto: Number(vendaResult.rows[0].desconto || 0),
          acrescimo: Number(vendaResult.rows[0].acrescimo || 0),
          total: Number(vendaResult.rows[0].total || 0),
          parcelas: Number(vendaResult.rows[0].parcelas || 1)
        },
        itens: itensResult.rows.map((item) => ({
          ...item,
          quantidade: Number(item.quantidade || 0),
          preco_unitario: Number(item.preco_unitario || 0),
          custo_unitario: Number(item.custo_unitario || 0),
          total: Number(item.total || 0)
        })),
        parcelas: parcelasResult.rows.map((item) => ({
          ...item,
          valor: Number(item.valor || 0),
          parcela: Number(item.parcela || 1),
          total_parcelas: Number(item.total_parcelas || 1)
        }))
      });
    } catch (error) {
      console.error('Erro ao buscar origem da venda:', error);
      jsonErro(res, 500, 'Erro ao buscar origem da venda');
    }
  });

  // ================= HISTÓRICO FINANCEIRO DO CLIENTE =================
  router.get('/contas-receber/cliente-historico/:clienteId', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      const clienteId = Number(req.params.clienteId);

      if (!clienteId) {
        return jsonErro(res, 400, 'Cliente inválido');
      }

      if (!req.user?.is_saas_owner && !req.empresa_id && !req.empresa_nome) {
        return jsonErro(res, 403, 'Empresa não identificada');
      }
      const _chEmpresaWhere = req.user?.is_saas_owner
        ? ''
        : `AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`;
      const _chParams = req.user?.is_saas_owner
        ? [clienteId]
        : [clienteId, req.empresa_id || 0, req.empresa_nome || ''];

      const clienteResult = await pool.query(
        `SELECT * FROM clientes WHERE id = $1 AND deletado_em IS NULL ${_chEmpresaWhere} LIMIT 1`,
        _chParams
      );

      if (clienteResult.rowCount === 0) {
        return jsonErro(res, 404, 'Cliente não encontrado');
      }

      const cliente = clienteResult.rows[0];

      const empresaResolvida = await validarAcessoEmpresa(req, cliente.empresa);

      if (!empresaResolvida) {
        return jsonErro(res, 403, 'Sem acesso');
      }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[cr-list] status-cr:', e.message); }

      const contasResult = await pool.query(
        `
        SELECT
          *,
          CASE
            WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN 'pago'
            WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial'
    AND data_vencimento IS NOT NULL
    AND data_vencimento < $4
  THEN 'parcial_atrasado'

  WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial'
  THEN 'parcial'

  WHEN data_vencimento IS NOT NULL
    AND data_vencimento < $4
  THEN 'atrasado'
            ELSE 'pendente'
          END AS status_exibicao
        FROM contas_receber
        WHERE cliente_id = $1
          AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        ORDER BY id DESC
        LIMIT 500
        `,
        [clienteId, empresaResolvida.id, empresaResolvida.nome, hoje()]
      );

      const contas = contasResult.rows.map((conta) => ({
        ...conta,
        valor: Number(conta.valor || 0),
        status: conta.status_exibicao
      }));

      const recebimentosParciaisResult = await pool.query(
        `
    SELECT COALESCE(SUM(lf.valor), 0) AS total
    FROM lancamentos_financeiros lf
    WHERE (lf.empresa_id = $2 OR (lf.empresa_id IS NULL AND lf.empresa = $1))
      AND LOWER(COALESCE(lf.tipo, '')) = 'receita'
      AND LOWER(COALESCE(lf.status, '')) = 'pago'
      AND LOWER(COALESCE(lf.categoria, '')) = 'contas_receber'
      AND lf.pagamento_data IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM contas_receber cr
        WHERE cr.cliente_id = $3
          AND (cr.empresa_id = $2 OR (cr.empresa_id IS NULL AND cr.empresa = $1))
          AND (
            (lf.conta_receber_id IS NOT NULL AND cr.id = lf.conta_receber_id)
            OR (lf.conta_receber_id IS NULL AND cr.id = CASE WHEN REGEXP_REPLACE(lf.descricao, '\\D', '', 'g') ~ '^[1-9][0-9]*$' THEN REGEXP_REPLACE(lf.descricao, '\\D', '', 'g')::INTEGER ELSE NULL END)
          )
      )
    `,
        [empresaResolvida.nome, empresaResolvida.id, clienteId]
      );

      const resumo = contas.reduce(
        (acc, conta) => {
          acc.total += conta.valor;

          if (conta.status === 'pago') {
            acc.total_pago += conta.valor;
          } else if (conta.status === 'parcial') {
            acc.total_parcial += conta.valor;
            acc.total_pendente += conta.valor;
          } else if (conta.status === 'parcial_atrasado') {
            acc.total_parcial += conta.valor;
            acc.total_atrasado += conta.valor;
          } else if (conta.status === 'atrasado') {
            acc.total_atrasado += conta.valor;
          } else {
            acc.total_pendente += conta.valor;
          }

          return acc;
        },
        {
          total: 0,
          total_pago: 0,
          total_pendente: 0,
          total_atrasado: 0,
          total_parcial: 0,
          total_recebido_parcial: Number(recebimentosParciaisResult.rows[0].total || 0)
        }
      );

      res.json({
        cliente: {
          id: cliente.id,
          nome: cliente.nome,
          telefone: cliente.telefone || null
        },
        resumo,
        contas
      });
    } catch (error) {
      console.error('Erro ao buscar histórico do cliente:', error);
      jsonErro(res, 500, 'Erro ao buscar histórico do cliente');
    }
  });

  router.get('/contas-receber/:id/recebimentos-parciais', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
    try {
      if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');

      const id = Number(req.params.id);

      const contaResult = req.user?.is_saas_owner
        ? await pool.query(`SELECT * FROM contas_receber WHERE id = $1 LIMIT 1`, [id])
        : await pool.query(
            `SELECT * FROM contas_receber
             WHERE id = $1
               AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
             LIMIT 1`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (contaResult.rowCount === 0) {
        return jsonErro(res, 404, 'Conta não encontrada');
      }

      const conta = contaResult.rows[0];
      const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);

      if (!empresaResolvida) {
        return jsonErro(res, 403, 'Sem acesso');
      }

      const result = await pool.query(
        `
        SELECT
          id,
          descricao,
          valor,
          pagamento_data,
          observacao,
          criado_em
        FROM lancamentos_financeiros
        WHERE (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $1))
          AND LOWER(COALESCE(tipo, '')) = 'receita'
          AND LOWER(COALESCE(categoria, '')) = 'contas_receber'
          AND LOWER(COALESCE(status, '')) = 'pago'
          AND (conta_receber_id = $3 OR (conta_receber_id IS NULL AND descricao = $4))
        ORDER BY pagamento_data DESC, id DESC
        `,
        [empresaResolvida.nome, empresaResolvida.id, id, `Recebimento parcial da conta #${id}`]
      );

      res.json({
        conta_id: id,
        recebimentos: result.rows.map((item) => ({
          ...item,
          valor: Number(item.valor || 0)
        }))
      });
    } catch (error) {
      console.error('Erro ao buscar recebimentos parciais:', error);
      jsonErro(res, 500, 'Erro ao buscar recebimentos parciais');
    }
  });

  return router;
};
