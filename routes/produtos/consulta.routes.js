'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { erro, ok } = require('../../utils/routeHelpers');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../../utils/periodoUtils');

// Parte 2/4 de produtos.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// consultas/listagem. A ordem de registro é importante: /etiquetas-hoje/:empresa
// precisa continuar vindo ANTES de /:empresa (comentário original preservado abaixo).
module.exports = function produtosConsultaRoutes({
  auth, apenasAdmin, pool,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS
}) {
  const router = express.Router();

  function normalizarProduto(row) {
    return {
      ...row,
      id: Number(row.id || 0),
      empresa_id: row.empresa_id ? Number(row.empresa_id) : null,
      preco: Number(row.preco || 0),
      custo: Number(row.custo || 0),
      custo_unitario: Number(row.custo_unitario || row.custo || 0),
      custo_medio: Number(row.custo_medio || row.custo || 0),
      lucro_unitario: Number(row.lucro_unitario || 0),
      margem_lucro: Number(row.margem_lucro || 0),
      preco_promocional: Number(row.preco_promocional || 0),
      promocao_ativa: Boolean(row.promocao_ativa),
      estoque: Number(row.estoque || 0),
      estoque_minimo: Number(row.estoque_minimo || 0),
      alerta_estoque: Boolean(row.alerta_estoque),
      // campos fiscais e grade (F2)
      unidade: row.unidade || 'UN',
      origem: Number(row.origem ?? 0),
      icms_aliquota: Number(row.icms_aliquota || 0),
      icms_base_calculo: Number(row.icms_base_calculo || 100),
      pis_aliquota: Number(row.pis_aliquota || 0),
      cofins_aliquota: Number(row.cofins_aliquota || 0),
      ipi_aliquota: Number(row.ipi_aliquota || 0),
      peso_bruto: row.peso_bruto ? Number(row.peso_bruto) : null,
      peso_liquido: row.peso_liquido ? Number(row.peso_liquido) : null,
      comprimento_cm: row.comprimento_cm ? Number(row.comprimento_cm) : null,
      largura_cm: row.largura_cm ? Number(row.largura_cm) : null,
      altura_cm: row.altura_cm ? Number(row.altura_cm) : null,
      tem_grade: Boolean(row.tem_grade),
      e_kit: Boolean(row.e_kit)
    };
  }

  // Deve ficar ANTES de /:empresa para não ser engolido pelo parâmetro genérico
  router.get('/etiquetas-hoje/:empresa', auth, requirePermissao(pool, 'produtos', 'ver'), async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { rows } = await pool.query(`
        SELECT DISTINCT p.id, p.nome, p.preco, p.codigo_barras, p.categoria
        FROM produtos p
        WHERE p.deletado_em IS NULL
          AND (p.empresa_id = $1 OR (p.empresa_id IS NULL AND p.empresa = $2))
          AND (
            (p.criado_em AT TIME ZONE 'America/Fortaleza')::date
              = (NOW() AT TIME ZONE 'America/Fortaleza')::date
            OR EXISTS (
              SELECT 1 FROM compra_itens ci
              JOIN compras c ON c.id = ci.compra_id
              WHERE ci.produto_id = p.id
                AND (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))
                AND (c.criado_em AT TIME ZONE 'America/Fortaleza')::date
                  = (NOW() AT TIME ZONE 'America/Fortaleza')::date
            )
            OR EXISTS (
              SELECT 1 FROM movimentacoes_estoque me
              WHERE me.produto_id = p.id
                AND (me.empresa_id = $1 OR (me.empresa_id IS NULL AND me.empresa = $2))
                AND (me.data_movimentacao AT TIME ZONE 'America/Fortaleza')::date
                  = (NOW() AT TIME ZONE 'America/Fortaleza')::date
            )
          )
        ORDER BY p.nome
        LIMIT 1000
      `, [empresaResolvida.id, empresaResolvida.nome]);

      return ok(res, { dados: rows.map(normalizarProduto) });
    } catch (error) {
      console.error('Erro real ao buscar etiquetas de hoje:', error);
      return erro(res, 500, 'Erro ao buscar produtos de hoje');
    }
  });

  router.get('/:empresa', auth, requirePermissao(pool, 'produtos', 'ver'), async (req, res, next) => {
    if (req.params.empresa === 'admin') return next('route');
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const busca = (req.query.busca || '').trim().toLowerCase();

      const params = [];

      let sql = `
  SELECT produtos.*,
        CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN TRUE ELSE FALSE END AS alerta_estoque,
        img.url_thumbnail AS imagem_thumb
  FROM produtos
  LEFT JOIN LATERAL (
    SELECT url_thumbnail
    FROM produto_imagens
    WHERE produto_imagens.produto_id = produtos.id
      AND produto_imagens.empresa_id = produtos.empresa_id
    ORDER BY principal DESC, ordem ASC, id ASC
    LIMIT 1
  ) img ON true
  WHERE deletado_em IS NULL
${adicionarFiltroEmpresaSaaS({
  params,
  empresaResolvida
})}
`;

      let idx = params.length + 1;

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        sql += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(categoria, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(codigo_barras, '')) LIKE $${idx} ESCAPE '\\'
          )
        `;
        params.push(`%${buscaEsc}%`);
        idx++;
      }

      sql += ` ORDER BY nome ASC`;

      const limite = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 100), 500);
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const limIdx = idx;
      const offIdx = idx + 1;

      const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS contagem`;

      const [countResult, result] = await Promise.all([
        pool.query(countSql, params),
        pool.query(
          sql + ` LIMIT $${limIdx} OFFSET $${offIdx}`,
          [...params, limite, offset]
        )
      ]);

      return res.json({
        sucesso: true,
        dados: result.rows.map(normalizarProduto),
        total: Number(countResult.rows[0]?.total || 0),
        limite,
        offset
      });
    } catch (error) {
      console.error('Erro real ao buscar produtos:', error);
      return erro(res, 500, 'Erro ao buscar produtos');
    }
  });

  router.get('/admin/lista', auth, apenasAdmin, async (req, res) => {
    try {
      const params = [];
      let where = `WHERE deletado_em IS NULL`;

      const empresa = req.query.empresa || '';
      const busca = (req.query.busca || '').trim().toLowerCase();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      if (empresa) {
        const empresaResolvida = await validarAcessoEmpresa(req, empresa);

        if (!empresaResolvida) {
          return erro(res, 403, 'Sem acesso');
        }

        params.push(empresaResolvida.id, empresaResolvida.nome);
        where += ` AND (empresa_id = $${params.length - 1} OR (empresa_id IS NULL AND empresa = $${params.length}))`;
      }

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        params.push(`%${buscaEsc}%`);
        where += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${params.length}
            OR LOWER(COALESCE(categoria, '')) LIKE $${params.length}
            OR LOWER(COALESCE(codigo_barras, '')) LIKE $${params.length}
          )
        `;
      }

      where += adicionarFiltroPeriodo({
        campo: 'criado_em',
        params,
        dataInicial,
        dataFinal
      });

      const pagina = Math.max(1, parseInt(req.query.page || '1', 10));
      const limite = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);
      const offset = (pagina - 1) * limite;

      const [countResult, result] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS total FROM produtos ${where}`, params),
        pool.query(
          `SELECT *,
                  CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN TRUE ELSE FALSE END AS alerta_estoque
          FROM produtos ${where} ORDER BY empresa ASC, nome ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limite, offset]
        )
      ]);

      return res.json({
        sucesso: true,
        dados:  result.rows.map(normalizarProduto),
        total:  Number(countResult.rows[0]?.total || 0),
        pagina,
        limite
      });
    } catch (error) {
      console.error('Erro real ao buscar produtos admin:', error);
      return erro(res, 500, 'Erro ao buscar produtos');
    }
  });

  return router;
};
