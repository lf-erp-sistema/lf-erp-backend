'use strict';
const express = require('express');
const { normalizarDecimal, normalizarDataISO, hoje } = require('../utils/normalizadores');
const { obterPeriodo, adicionarFiltroPeriodo, adicionarFiltroPeriodoRange } = require('../utils/periodoUtils');
const { requirePermissao } = require('../utils/permissoes');
const { jsonErro, erroFromException } = require('../utils/routeHelpers');

module.exports = function lancamentosRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
  atualizarStatusContasReceberPorEmpresa,
  registrarLogFinanceiro
}) {
  const router = express.Router();
router.post('/financeiro/lancamentos', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const {
      empresa,
      empresa_id,
      tipo,
      categoria,
      descricao,
      valor,
      vencimento,
      pagamento_data,
      status,
      forma_pagamento,
      recorrente,
      frequencia,
      observacao
    } = req.body;

    if (!tipo || !categoria || !descricao) {
      return jsonErro(res, 400, 'Preencha os campos obrigatórios do lançamento');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (!['receita', 'despesa'].includes(String(tipo).toLowerCase())) {
      return jsonErro(res, 400, 'Tipo de lançamento inválido');
    }

    const _statusesValidos = ['pendente', 'pago', 'atrasado'];
    const statusFinal = _statusesValidos.includes(String(status || '').toLowerCase())
      ? String(status).toLowerCase()
      : 'pendente';

    const valorFinal = normalizarDecimal(valor);
    if (valorFinal <= 0) {
      return jsonErro(res, 400, 'Valor inválido');
    }

    const result = await pool.query(
      `
      INSERT INTO lancamentos_financeiros
      (
        empresa,
        empresa_id,
        tipo,
        categoria,
        descricao,
        valor,
        vencimento,
        pagamento_data,
        status,
        forma_pagamento,
        recorrente,
        frequencia,
        observacao,
        criado_por,
        criado_em,
        atualizado_em
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
      RETURNING *
      `,
      [
        empresaResolvida.nome,
        empresaResolvida.id,
        String(tipo).toLowerCase(),
        categoria,
        descricao,
        valorFinal,
        normalizarDataISO(vencimento) || null,
        normalizarDataISO(pagamento_data) || null,
        statusFinal,
        forma_pagamento || '',
        Boolean(recorrente),
        frequencia || '',
        observacao || '',
        req.user.id
      ]
    );

    res.json({
      sucesso: true,
      item: {
        ...result.rows[0],
        valor: Number(result.rows[0].valor || 0)
      }
    });
  } catch (error) {
    console.error('Erro ao cadastrar lançamento financeiro:', error);
    jsonErro(res, 500, 'Erro ao cadastrar lançamento financeiro');
  }
});

router.get('/financeiro/lancamentos/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const tipo = (req.query.tipo || '').trim().toLowerCase();
    const status = (req.query.status || '').trim().toLowerCase();
    const categoria = (req.query.categoria || '').trim().toLowerCase();
    const busca = (req.query.busca || '').trim().toLowerCase();
    const { dataInicial, dataFinal } = obterPeriodo(req);

    let sql = `
      SELECT
        *
      FROM lancamentos_financeiros
      WHERE (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $1))
    `;

    const params = [empresaResolvida.nome, empresaResolvida.id];
    let idx = 3;

    if (tipo) {
      sql += ` AND LOWER(COALESCE(tipo, '')) = $${idx} `;
      params.push(tipo);
      idx++;
    }

    if (status) {
      sql += ` AND LOWER(COALESCE(status, '')) = $${idx} `;
      params.push(status);
      idx++;
    }

    if (categoria) {
      const categoriaEsc = categoria.replace(/[%_\\]/g, '\\$&');
      sql += ` AND LOWER(COALESCE(categoria, '')) LIKE $${idx} ESCAPE '\\' `;
      params.push(`%${categoriaEsc}%`);
      idx++;
    }

    if (busca) {
      const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
      sql += `
        AND (
          LOWER(COALESCE(descricao, '')) LIKE $${idx} ESCAPE '\\'
          OR LOWER(COALESCE(observacao, '')) LIKE $${idx} ESCAPE '\\'
          OR LOWER(COALESCE(categoria, '')) LIKE $${idx} ESCAPE '\\'
          OR CAST(id AS TEXT) LIKE $${idx} ESCAPE '\\'
        )
      `;
      params.push(`%${buscaEsc}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodoRange({
      campoInicial: 'vencimento',
      campoFinal: 'pagamento_data',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const paginaL = Math.max(1, normalizarInt(req.query.page || 1));
    const limiteL = Math.min(normalizarInt(req.query.limit) || 50, 200);
    const filterParamsL = [...params];

    const offsetL = (paginaL - 1) * limiteL;
    const sqlPaginado = sql + ` ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const paramsPaginado = [...params, limiteL, offsetL];

    const resumoSqlL = `
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(CASE WHEN tipo = 'receita' THEN valor ELSE 0 END), 0)::float AS receitas,
        COALESCE(SUM(CASE WHEN tipo != 'receita' THEN valor ELSE 0 END), 0)::float AS despesas
      FROM (${sql}) AS q`;

    const [result, resumoResultL] = await Promise.all([
      pool.query(sqlPaginado, paramsPaginado),
      pool.query(resumoSqlL, filterParamsL)
    ]);

    const rgL = resumoResultL.rows[0];
    const totalL = Number(rgL.total || 0);

    res.json({
      itens: result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0),
        recorrente: Boolean(row.recorrente)
      })),
      resumo: {
        receitas: Number(rgL.receitas || 0),
        despesas: Number(rgL.despesas || 0),
        saldo: Number(rgL.receitas || 0) - Number(rgL.despesas || 0)
      },
      paginacao: {
        pagina: paginaL,
        limite: limiteL,
        total: totalL,
        total_paginas: Math.ceil(totalL / limiteL) || 1
      }
    });
  } catch (error) {
    console.error('Erro ao buscar lançamentos financeiros:', error);
    erroFromException(res, error, 'Erro ao buscar lançamentos financeiros');
  }
});

router.get('/financeiro/lancamentos-detalhe/:id', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = req.user.is_saas_owner
      ? await pool.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1`, [id])
      : await pool.query(
          `SELECT * FROM lancamentos_financeiros WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [id, req.user.empresa_id || 0, req.user.empresa || '']
        );

    if (result.rowCount === 0) {
      return jsonErro(res, 404, 'Lançamento não encontrado');
    }

    const item = result.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, item.empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    res.json({
      ...item,
      valor: Number(item.valor || 0),
      recorrente: Boolean(item.recorrente)
    });
  } catch (error) {
    console.error('Erro ao buscar detalhe do lançamento:', error);
    jsonErro(res, 500, 'Erro ao buscar detalhe do lançamento');
  }
});

router.put('/financeiro/lancamentos/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const id = Number(req.params.id);

    // Validate body fields early, before opening transaction
    const {
      tipo,
      categoria,
      descricao,
      valor,
      vencimento,
      pagamento_data,
      status,
      forma_pagamento,
      recorrente,
      frequencia,
      observacao
    } = req.body;

    if (!tipo || !categoria || !descricao) {
      return jsonErro(res, 400, 'Preencha os campos obrigatórios do lançamento');
    }

    if (!['receita', 'despesa'].includes(String(tipo).toLowerCase())) {
      return jsonErro(res, 400, 'Tipo de lançamento inválido');
    }

    const valorFinal = normalizarDecimal(valor);
    if (valorFinal <= 0) {
      return jsonErro(res, 400, 'Valor inválido');
    }

    let empresaResolvida;
    const client7 = await pool.connect();
    try {
      await client7.query('BEGIN');

      // SELECT with FOR UPDATE inside transaction to prevent lost updates
      const atualResult = req.user.is_saas_owner
        ? await client7.query(
            `SELECT * FROM lancamentos_financeiros WHERE id = $1 FOR UPDATE`,
            [id]
          )
        : await client7.query(
            `SELECT * FROM lancamentos_financeiros WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) FOR UPDATE`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (atualResult.rowCount === 0) {
        await client7.query('ROLLBACK');
        return jsonErro(res, 404, 'Lançamento não encontrado');
      }

      const atual = atualResult.rows[0];
      empresaResolvida = await validarAcessoEmpresa(req, atual.empresa, atual.empresa_id);

      if (!empresaResolvida) {
        await client7.query('ROLLBACK');
        return jsonErro(res, 403, 'Sem acesso');
      }

      if (atual.conta_receber_id) {
        await client7.query('ROLLBACK');
        return jsonErro(res, 400, 'Lançamentos vinculados a contas a receber não podem ser editados diretamente');
      }

      await client7.query(
        `
      UPDATE lancamentos_financeiros
      SET tipo = $1,
          categoria = $2,
          descricao = $3,
          valor = $4,
          vencimento = $5,
          pagamento_data = $6,
          status = $7,
          forma_pagamento = $8,
          recorrente = $9,
          frequencia = $10,
          observacao = $11,
          atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
      WHERE id = $12 AND (empresa_id = $13 OR (empresa_id IS NULL AND empresa = $14))
`,
        [
          String(tipo).toLowerCase(),
          categoria,
          descricao,
          valorFinal,
          normalizarDataISO(vencimento) || null,
          normalizarDataISO(pagamento_data) || null,
          ['pendente', 'pago', 'atrasado'].includes(String(status || '').toLowerCase())
            ? String(status).toLowerCase()
            : 'pendente',
          forma_pagamento || '',
          Boolean(recorrente),
          frequencia || '',
          observacao || '',
          id,
          empresaResolvida.id,
          empresaResolvida.nome
        ]
      );
      await client7.query('COMMIT');
    } catch (txErr) {
      await client7.query('ROLLBACK');
      throw txErr;
    } finally {
      client7.release();
    }

    try {
      await registrarLogFinanceiro({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        tipo: 'edicao',
        entidade: 'lancamentos_financeiros',
        entidade_id: id,
        descricao: `Lançamento editado: ${descricao}`,
        valor: valorFinal,
        usuario_id: req.user?.id
      });
    } catch (logErr) {
      console.error('[lancamentos-put] log financeiro:', logErr.message);
    }

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao atualizar lançamento financeiro:', error);
    jsonErro(res, 500, 'Erro ao atualizar lançamento financeiro');
  }
});

router.post('/financeiro/lancamentos/pagar/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const id = Number(req.params.id);

    const client8 = await pool.connect();
    let atual, empresaResolvida;
    try {
      await client8.query('BEGIN');

      const atualResult = req.user.is_saas_owner
        ? await client8.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1 FOR UPDATE`, [id])
        : await client8.query(
            `SELECT * FROM lancamentos_financeiros WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) FOR UPDATE`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (atualResult.rowCount === 0) {
        await client8.query('ROLLBACK');
        return jsonErro(res, 404, 'Lançamento não encontrado');
      }

      atual = atualResult.rows[0];
      empresaResolvida = await validarAcessoEmpresa(req, atual.empresa);

      if (!empresaResolvida) {
        await client8.query('ROLLBACK');
        return jsonErro(res, 403, 'Sem acesso');
      }

      await client8.query(
        `
      UPDATE lancamentos_financeiros
      SET status = 'pago',
          pagamento_data = $1,
          atualizado_em = NOW()
      WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
      `,
        [normalizarDataISO(req.body?.pagamento_data) || hoje(), id, empresaResolvida.id, empresaResolvida.nome]
      );

      await client8.query('COMMIT');
    } catch (txErr) {
      await client8.query('ROLLBACK');
      throw txErr;
    } finally {
      client8.release();
    }

    try {
      await registrarLogFinanceiro({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        tipo: 'pagamento',
        entidade: 'lancamentos_financeiros',
        entidade_id: id,
        descricao: `Lançamento pago: ${atual.descricao || ''}`,
        valor: Number(atual.valor || 0),
        usuario_id: req.user?.id
      });
    } catch (logErr) {
      console.error('[lancamentos-pagar] log financeiro:', logErr.message);
    }

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao pagar lançamento financeiro:', error);
    jsonErro(res, 500, 'Erro ao pagar lançamento financeiro');
  }
});

router.delete('/financeiro/lancamentos/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'deletar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const id = Number(req.params.id);

    let atual, empresaResolvida;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const atualResult = req.user.is_saas_owner
        ? await client.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1 FOR UPDATE`, [id])
        : await client.query(
            `SELECT * FROM lancamentos_financeiros WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) FOR UPDATE`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (atualResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return jsonErro(res, 404, 'Lançamento não encontrado');
      }

      atual = atualResult.rows[0];
      empresaResolvida = await validarAcessoEmpresa(req, atual.empresa, atual.empresa_id);

      if (!empresaResolvida) {
        await client.query('ROLLBACK');
        return jsonErro(res, 403, 'Sem acesso');
      }

      const delResult = await client.query(
        `DELETE FROM lancamentos_financeiros WHERE id = $1 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $2)) RETURNING id`,
        [id, empresaResolvida.nome, empresaResolvida.id]
      );
      if (delResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return jsonErro(res, 404, 'Lançamento não encontrado');
      }

      // Restaurar CR se este lançamento era uma baixa parcial de conta a receber
      if (atual.conta_receber_id) {
        const valorLancamento = normalizarDecimal(atual.valor || 0);
        await client.query(
          `UPDATE contas_receber
           SET valor = valor + $1,
               status = CASE
                 WHEN (valor + $1) >= COALESCE(valor_original, valor + $1) THEN
                   CASE WHEN data_vencimento IS NOT NULL AND data_vencimento < CURRENT_DATE THEN 'atrasado' ELSE 'pendente' END
                 ELSE
                   CASE WHEN data_vencimento IS NOT NULL AND data_vencimento < CURRENT_DATE THEN 'parcial_atrasado' ELSE 'parcial' END
               END,
               atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
           WHERE id = $2
             AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))`,
          [valorLancamento, atual.conta_receber_id, empresaResolvida.id, empresaResolvida.nome]
        );
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    try {
      await registrarLogFinanceiro({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        tipo: 'exclusao',
        entidade: 'lancamentos_financeiros',
        entidade_id: id,
        descricao: `Lançamento excluído: ${atual.descricao || ''}`,
        valor: Number(atual.valor || 0),
        usuario_id: req.user?.id
      });
    } catch (logErr) {
      console.error('[lancamentos-delete] log financeiro:', logErr.message);
    }

    if (atual.conta_receber_id) {
      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[lancamentos-delete] status-cr:', e.message); }
    }

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao excluir lançamento financeiro:', error);
    jsonErro(res, 500, 'Erro ao excluir lançamento financeiro');
  }
});


  return router;
};
