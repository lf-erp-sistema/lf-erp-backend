'use strict';
const express = require('express');
const { requirePermissao } = require('../utils/permissoes');
const { hoje } = require('../utils/normalizadores');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function metasRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, podeGerenciarFinanceiro }) {
  const router = express.Router();

// â”€â”€ Metas de vendas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /metas-vendas?periodo=YYYY-MM â€” lista metas com progresso real
router.get('/metas-vendas', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const periodo = req.query.periodo || hoje().slice(0, 7); // default: mÃªs atual

    // Calcula intervalo de datas do perÃ­odo
    let dataInicio, dataFim;
    if (/^\d{4}-\d{2}$/.test(periodo)) {
      // Mensal: YYYY-MM
      dataInicio = `${periodo}-01`;
      // Ancora ao meio-dia (mesmo padrão de addDias em normalizadores.js) para não
      // sofrer off-by-one ao formatar em America/Fortaleza se o processo rodar em
      // outro fuso (ex: UTC em container) — meia-noite local recuaria pro dia anterior.
      const fim = new Date(`${periodo}-01T12:00:00`);
      fim.setMonth(fim.getMonth() + 1, 0); // dia 0 do mês seguinte = último dia deste mês
      dataFim = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(fim);
    } else {
      dataInicio = hoje().slice(0, 8) + '01';
      dataFim = hoje();
    }

    const metasResult = await pool.query(
      `SELECT m.*, u.nome_completo AS vendedor_nome, u.usuario AS vendedor_usuario
       FROM metas_vendas m
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       WHERE m.empresa_id = $1 AND m.periodo = $2
       ORDER BY m.usuario_id NULLS FIRST, m.id`,
      [empresaResolvida.id, periodo]
    );

    // Calcula progresso real via vendas do perÃ­odo â€” query Ãºnica com GROUP BY (evita N+1)
    const realizadoResult = await pool.query(
      `SELECT criado_por AS usuario_id, COALESCE(SUM(total), 0) AS realizado
       FROM vendas
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $4)) AND data >= $2 AND data <= $3
       GROUP BY criado_por`,
      [empresaResolvida.id, dataInicio, dataFim, empresaResolvida.nome || '']
    );
    const realizadoMap = {};
    let realizadoTotal = 0;
    for (const r of realizadoResult.rows) {
      const v = Number(r.realizado || 0);
      realizadoMap[r.usuario_id] = v;
      realizadoTotal += v;
    }
    const metasComProgresso = metasResult.rows.map((meta) => {
      // Meta por usuÃ¡rio â†’ apenas vendas daquele usuÃ¡rio; meta geral â†’ todas as vendas
      const realizado = meta.usuario_id ? (realizadoMap[meta.usuario_id] || 0) : realizadoTotal;
      const meta_valor = Number(meta.valor_meta || 0);
      const percentual = meta_valor > 0 ? Math.min(100, Math.round((realizado / meta_valor) * 100)) : 0;
      return { ...meta, realizado, percentual, faltando: Math.max(0, meta_valor - realizado) };
    });

    res.json({ sucesso: true, periodo, data_inicio: dataInicio, data_fim: dataFim, metas: metasComProgresso });
  } catch (err) {
    console.error('[metas] GET:', err.message);
    jsonErro(res, 500, 'Erro ao carregar metas');
  }
});

// POST /metas-vendas â€” criar ou atualizar meta
router.post('/metas-vendas', auth, writeRateLimiter, requirePermissao(pool, 'relatorios', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { usuario_id, periodo, valor_meta, descricao } = req.body;
    if (!periodo || !valor_meta) return jsonErro(res, 400, 'periodo e valor_meta sÃ£o obrigatÃ³rios');
    if (!/^\d{4}-\d{2}$/.test(periodo)) return jsonErro(res, 400, 'periodo deve ser YYYY-MM');

    if (usuario_id) {
      const uCheck = await pool.query(
        `SELECT 1 FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
        [Number(usuario_id), empresaResolvida.id, empresaResolvida.nome || '']
      );
      if (uCheck.rowCount === 0) return jsonErro(res, 400, 'UsuÃ¡rio nÃ£o pertence Ã  empresa');
    }

    const result = await pool.query(
      `INSERT INTO metas_vendas (empresa_id, usuario_id, periodo, valor_meta, descricao)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (empresa_id, usuario_id, periodo) DO UPDATE
       SET valor_meta = $4, descricao = $5, atualizado_em = NOW()
       RETURNING *`,
      [empresaResolvida.id, usuario_id || null, periodo,
       normalizarDecimal(valor_meta), descricao || null]
    );

    res.status(201).json({ sucesso: true, meta: result.rows[0] });
  } catch (err) {
    console.error('[metas] POST:', err.message);
    jsonErro(res, 500, 'Erro ao salvar meta');
  }
});

// DELETE /metas-vendas/:id
router.delete('/metas-vendas/:id', auth, writeRateLimiter, requirePermissao(pool, 'relatorios', 'deletar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const r = await pool.query(
      `DELETE FROM metas_vendas WHERE id = $1 AND empresa_id = $2`,
      [Number(req.params.id), empresaResolvida.id]
    );
    if (r.rowCount === 0) return jsonErro(res, 404, 'Meta nÃ£o encontrada');
    res.json({ sucesso: true });
  } catch (err) {
    console.error('[metas] DELETE:', err.message);
    jsonErro(res, 500, 'Erro ao excluir meta');
  }
});


// â”€â”€ Multi-depÃ³sito â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  return router;
};