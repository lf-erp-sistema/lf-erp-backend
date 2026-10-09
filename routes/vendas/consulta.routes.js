'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../../utils/periodoUtils');
const { erro } = require('../../utils/routeHelpers');

// Parte 3/4 de vendas.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// listagem paginada/filtrada e detalhe de uma venda.
module.exports = function vendasConsultaRoutes({
  auth, pool,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  normalizarInt, hoje
}) {
  const router = express.Router();

  router.get('/:empresa', auth, requirePermissao(pool, 'vendas', 'ver'), async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const busca = (req.query.busca || '').trim().toLowerCase();
      const clienteId = normalizarInt(req.query.cliente_id || 0);
      const pagamento = (req.query.pagamento || '').trim();
      const statusPagamento = (req.query.status_pagamento || '').trim();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [];

      let sql = `
  SELECT v.*
  FROM vendas v
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    alias: 'v',
    params,
    empresaResolvida
  })}
`;
      let idx = params.length + 1;

      if (clienteId > 0) {
        sql += ` AND v.cliente_id = $${idx}`;
        params.push(clienteId);
        idx++;
      }

      if (pagamento) {
        sql += ` AND v.pagamento = $${idx}`;
        params.push(pagamento);
        idx++;
      }

      if (statusPagamento) {
        sql += ` AND v.status_pagamento = $${idx}`;
        params.push(statusPagamento);
        idx++;
      }

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        sql += ` AND (
          LOWER(COALESCE(v.cliente_nome,'')) LIKE $${idx} ESCAPE '\\'
          OR LOWER(COALESCE(v.observacao,'')) LIKE $${idx} ESCAPE '\\'
          OR CAST(v.id AS TEXT) LIKE $${idx} ESCAPE '\\'
        )`;
        params.push(`%${buscaEsc}%`);
        idx++;
      }

      sql += adicionarFiltroPeriodo({
        campo: 'v.data',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      const limite = Math.min(normalizarInt(req.query.limit) || 100, 500);
      const offset = Math.max(normalizarInt(req.query.offset || 0), 0);
      const filterParams = [...params];
      const limIdx = filterParams.length + 1;
      const offIdx = filterParams.length + 2;

      const [countResult, result] = await Promise.all([
        pool.query(sql.replace('SELECT v.*', 'SELECT COUNT(*) AS total'), filterParams),
        pool.query(
          sql + ` ORDER BY v.id DESC LIMIT $${limIdx} OFFSET $${offIdx}`,
          [...filterParams, limite, offset]
        )
      ]);

      return res.json({
        sucesso: true,
        dados: result.rows.map((row) => ({
          ...row,
          subtotal: Number(row.subtotal || 0),
          desconto: Number(row.desconto || 0),
          acrescimo: Number(row.acrescimo || 0),
          total: Number(row.total || 0),
          parcelas: Number(row.parcelas || 1)
        })),
        total:  Number(countResult.rows[0]?.total || 0),
        limite,
        offset
      });
    } catch (error) {
      console.error('Erro real ao buscar vendas:', error);
      return erro(res, 500, 'Erro ao buscar vendas');
    }
  });

  router.get('/detalhe/:id', auth, requirePermissao(pool, 'vendas', 'ver'), async (req, res) => {
    try {
      const id = Number(req.params.id);

      const vendaResult = req.user.is_saas_owner
        ? await pool.query(`SELECT * FROM vendas WHERE id = $1`, [id])
        : await pool.query(
            `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (vendaResult.rowCount === 0) {
        return erro(res, 404, 'Venda não encontrada');
      }

      const venda = vendaResult.rows[0];

      // FIX 1: empresaBase era INTEGER quando empresa_id preenchido — agora passa nome e id separados
      const empresaResolvida = await validarAcessoEmpresa(req, venda.empresa || null, venda.empresa_id || null);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const [itensResult] = await Promise.all([
        pool.query(
          `SELECT vi.* FROM venda_itens vi
           WHERE vi.venda_id = $1
             AND (vi.empresa_id = $2 OR (vi.empresa_id IS NULL AND vi.empresa = $3))
           ORDER BY vi.id ASC`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        )
      ]);

      const contasReceberResult = await pool.query(
        `
        SELECT
          *,
          CASE
            WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN 'pago'
            WHEN data_vencimento IS NOT NULL AND data_vencimento < $2 THEN 'atrasado'
            ELSE COALESCE(status, 'pendente')
          END AS status_exibicao
        FROM contas_receber
        WHERE venda_id = $1
AND (
  empresa_id = $3
  OR (
    empresa_id IS NULL
    AND empresa = $4
  )
)
ORDER BY parcela ASC
        `,
        [id, hoje(), empresaResolvida.id, empresaResolvida.nome]
      );

      return res.json({
        ...venda,
        subtotal: Number(venda.subtotal || 0),
        desconto: Number(venda.desconto || 0),
        acrescimo: Number(venda.acrescimo || 0),
        total: Number(venda.total || 0),
        parcelas: Number(venda.parcelas || 1),
        pagamentos: venda.pagamentos
          ? (typeof venda.pagamentos === 'string' ? JSON.parse(venda.pagamentos) : venda.pagamentos)
          : [{ forma: venda.pagamento || 'Dinheiro', valor: Number(venda.total || 0) }],
        itens: itensResult.rows.map((item) => ({
          ...item,
          quantidade: Number(item.quantidade || 0),
          preco_unitario: Number(item.preco_unitario || 0),
          custo_unitario: Number(item.custo_unitario || 0),
          total: Number(item.total || 0)
        })),
        contas_receber: contasReceberResult.rows.map((cr) => ({
          ...cr,
          status: cr.status_exibicao || cr.status || 'pendente',
          status_exibicao: cr.status_exibicao || cr.status || 'pendente',
          valor: Number(cr.valor || 0),
          parcela: Number(cr.parcela || 1),
          total_parcelas: Number(cr.total_parcelas || 1),
          multa: Number(cr.multa || 0),
          juros: Number(cr.juros || 0),
          valor_atualizado: Number(cr.valor_atualizado || cr.valor || 0),
          dias_atraso: Number(cr.dias_atraso || 0)
        }))
      });
    } catch (error) {
      console.error('Erro real ao buscar venda:', error);
      return erro(res, 500, 'Erro ao buscar venda');
    }
  });

  return router;
};
