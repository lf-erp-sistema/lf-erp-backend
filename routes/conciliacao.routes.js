'use strict';
const express = require('express');
const { requirePermissao } = require('../utils/permissoes');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function conciliacaoRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
  jsonUpload
}) {
  const router = express.Router();
// ================= CONCILIAÇÃO BANCÁRIA =================

function ofxTagVal(bloco, tag) {
  const m = new RegExp(`<${tag}>([^<\\n\\r]+)`, 'i').exec(bloco);
  return m ? m[1].trim() : null;
}

function parseOFXDate(str) {
  const s = String(str || '').slice(0, 8);
  if (s.length < 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function parseOFX(texto) {
  if (!texto || texto.length > 10 * 1024 * 1024)
    throw new Error('Arquivo OFX inválido ou excede 10 MB');
  const itens = [];
  const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const b = m[1];
    const dtposted = ofxTagVal(b, 'DTPOSTED');
    const trnamt   = ofxTagVal(b, 'TRNAMT');
    if (!dtposted || !trnamt) continue;
    const valor = parseFloat(trnamt.replace(',', '.'));
    if (isNaN(valor)) continue;
    itens.push({
      fitid:    ofxTagVal(b, 'FITID') || `${dtposted}_${trnamt}`,
      data:     parseOFXDate(dtposted),
      descricao:(ofxTagVal(b, 'MEMO') || ofxTagVal(b, 'NAME') || '').trim(),
      valor:    Math.abs(valor),
      tipo:     valor >= 0 ? 'credito' : 'debito'
    });
  }
  return itens;
}

function parseDataBR(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function parseDataISO(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test((s || '').trim()) ? s.trim() : null;
}

function parseCSV(texto) {
  if (!texto || texto.length > 10 * 1024 * 1024)
    throw new Error('Arquivo CSV inválido ou excede 10 MB');
  const linhas = texto.split('\n').map(l => l.trim()).filter(Boolean);
  const itens = [];
  for (let i = 0; i < linhas.length; i++) {
    const cols = linhas[i].split(/[;,]/).map(c => c.replace(/^["']|["']$/g, '').trim());
    if (cols.length < 3) continue;
    const data = parseDataBR(cols[0]) || parseDataISO(cols[0]);
    if (!data) continue;
    const desc = cols[1];
    const valorStr = cols[2].replace(/\./g, '').replace(',', '.');
    const valor = parseFloat(valorStr);
    if (isNaN(valor)) continue;
    itens.push({
      fitid:    `csv_${i}_${data}`,
      data,
      descricao: desc,
      valor:    Math.abs(valor),
      tipo:     valor >= 0 ? 'credito' : 'debito'
    });
  }
  return itens;
}

// POST /conciliacao/importar
router.post('/conciliacao/importar', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), jsonUpload, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const { conteudo, tipo, nome, conta } = req.body;
    if (!conteudo || !tipo || !nome) return jsonErro(res, 400, 'Campos obrigatórios: conteudo, tipo, nome');

    const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    let itens = [];
    if (tipo === 'ofx') itens = parseOFX(conteudo);
    else if (tipo === 'csv') itens = parseCSV(conteudo);
    else return jsonErro(res, 400, 'Tipo inválido. Use ofx ou csv.');

    if (!itens.length) return jsonErro(res, 400, 'Nenhuma transação encontrada no arquivo.');

    const datas = itens.map(i => i.data).filter(Boolean).sort();
    const dataInicio = datas[0] || null;
    const dataFim    = datas[datas.length - 1] || null;

    const sessao = await pool.query(
      `INSERT INTO conciliacoes (empresa, empresa_id, nome, tipo, conta, data_inicio, data_fim, total_itens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [empresaResolvida.nome, empresaResolvida.id, nome, tipo, conta || null, dataInicio, dataFim, itens.length]
    );
    const conciliacaoId = sessao.rows[0].id;

    if (itens.length > 0) {
      const CHUNK = 8191; // 65535 params / 8 por item
      for (let offset = 0; offset < itens.length; offset += CHUNK) {
        const lote = itens.slice(offset, offset + CHUNK);
        const placeholders = lote.map((_, idx) => {
          const b = idx * 8;
          return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
        }).join(',');
        const params = lote.flatMap(it => [
          conciliacaoId, empresaResolvida.nome, empresaResolvida.id,
          it.fitid, it.data, it.descricao, it.valor, it.tipo
        ]);
        await pool.query(
          `INSERT INTO conciliacao_itens (conciliacao_id, empresa, empresa_id, fitid, data, descricao, valor, tipo) VALUES ${placeholders}`,
          params
        );
      }
    }

    res.json({ sucesso: true, conciliacao_id: conciliacaoId, total: itens.length });
  } catch (error) {
    console.error('Erro ao importar conciliação:', error);
    jsonErro(res, 500, 'Erro ao importar arquivo');
  }
});

// GET /conciliacao
router.get('/conciliacao', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const result = await pool.query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM conciliacao_itens ci WHERE ci.conciliacao_id = c.id AND ci.status = 'pendente') AS pendentes
       FROM conciliacoes c
       WHERE c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2)
       ORDER BY c.criado_em DESC LIMIT 50`,
      [empresaResolvida.id, empresaResolvida.nome]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar conciliações:', error);
    jsonErro(res, 500, 'Erro ao listar conciliações');
  }
});

// GET /conciliacao/:id/itens
router.get('/conciliacao/:id/itens', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const id = Number(req.params.id);
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const status = req.query.status || '';
    const VALID_STATUSES_CONC = ['pendente', 'conciliado', 'ignorado'];
    if (status && !VALID_STATUSES_CONC.includes(status)) {
      return jsonErro(res, 400, 'Status inválido. Use: pendente, conciliado, ignorado');
    }
    let sql = `SELECT ci.*,
        lf.descricao AS lancamento_descricao, lf.categoria AS lancamento_categoria
      FROM conciliacao_itens ci
      LEFT JOIN lancamentos_financeiros lf ON lf.id = ci.lancamento_id
      WHERE ci.conciliacao_id = $1
        AND (ci.empresa_id = $2 OR (ci.empresa_id IS NULL AND ci.empresa = $3))`;
    const params = [id, empresaResolvida.id, empresaResolvida.nome];

    if (status) { params.push(status); sql += ` AND ci.status = $${params.length}`; }
    sql += ` ORDER BY ci.data, ci.id`;

    const result = await pool.query(sql, params);
    res.json(result.rows.map(r => ({ ...r, valor: Number(r.valor || 0) })));
  } catch (error) {
    console.error('Erro ao buscar itens de conciliação:', error);
    jsonErro(res, 500, 'Erro ao buscar itens');
  }
});

// POST /conciliacao/itens/:id/ignorar
router.post('/conciliacao/itens/:id/ignorar', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const id = Number(req.params.id);
    const item = await pool.query(
      `SELECT * FROM conciliacao_itens
       WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
      [id, req.empresa_id || 0, req.empresa_nome || req.user?.empresa || '']
    );
    if (!item.rowCount) return jsonErro(res, 404, 'Item não encontrado');

    const empresaResolvida = await validarAcessoEmpresa(req, item.rows[0].empresa, item.rows[0].empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const client7 = await pool.connect();
    try {
      await client7.query('BEGIN');
      const updIgn = await client7.query(
        `UPDATE conciliacao_itens SET status = 'ignorado' WHERE id = $1 AND status = 'pendente' AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) RETURNING id`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (updIgn.rowCount === 0) {
        await client7.query('ROLLBACK');
        return jsonErro(res, 409, 'Item já processado por outra solicitação');
      }
      await client7.query(
        `UPDATE conciliacoes SET itens_ignorados = itens_ignorados + 1
         WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [item.rows[0].conciliacao_id, empresaResolvida.id, empresaResolvida.nome]
      );
      await client7.query('COMMIT');
    } catch (txErr) {
      await client7.query('ROLLBACK');
      throw txErr;
    } finally {
      client7.release();
    }
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao ignorar item:', error);
    jsonErro(res, 500, 'Erro ao ignorar item');
  }
});

// POST /conciliacao/itens/:id/criar-lancamento
router.post('/conciliacao/itens/:id/criar-lancamento', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const id = Number(req.params.id);
    const item = await pool.query(
      `SELECT * FROM conciliacao_itens
       WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
      [id, req.empresa_id || 0, req.empresa_nome || req.user?.empresa || '']
    );
    if (!item.rowCount) return jsonErro(res, 404, 'Item não encontrado');
    if (item.rows[0].status === 'conciliado') return jsonErro(res, 400, 'Item já conciliado');

    const row = item.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, row.empresa, row.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { categoria, observacao } = req.body;
    const tipoLanc = row.tipo === 'credito' ? 'receita' : 'despesa';

    const client8 = await pool.connect();
    let lancamentoId;
    try {
      await client8.query('BEGIN');
      const lanc = await client8.query(
        `INSERT INTO lancamentos_financeiros
           (empresa, empresa_id, tipo, categoria, descricao, valor, vencimento, pagamento_data, status, criado_por, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'pago',$8,NOW(),NOW()) RETURNING id`,
        [
          empresaResolvida.nome, empresaResolvida.id,
          tipoLanc,
          categoria || (row.tipo === 'credito' ? 'Receita bancária' : 'Despesa bancária'),
          row.descricao,
          row.valor,
          row.data,
          req.user.id
        ]
      );
      lancamentoId = lanc.rows[0].id;
      const updConc = await client8.query(
        `UPDATE conciliacao_itens SET status = 'conciliado', lancamento_id = $1 WHERE id = $2 AND status != 'conciliado' AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4)) RETURNING id`,
        [lancamentoId, id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (updConc.rowCount === 0) {
        await client8.query('ROLLBACK');
        return jsonErro(res, 409, 'Item já conciliado por outra solicitação');
      }
      await client8.query(
        `UPDATE conciliacoes SET itens_conciliados = itens_conciliados + 1
         WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [row.conciliacao_id, empresaResolvida.id, empresaResolvida.nome]
      );
      await client8.query('COMMIT');
    } catch (txErr) {
      await client8.query('ROLLBACK');
      throw txErr;
    } finally {
      client8.release();
    }
    res.json({ sucesso: true, lancamento_id: lancamentoId });
  } catch (error) {
    console.error('Erro ao criar lançamento da conciliação:', error);
    jsonErro(res, 500, 'Erro ao criar lançamento');
  }
});

// DELETE /conciliacao/:id
router.delete('/conciliacao/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'deletar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const id = Number(req.params.id);
    const sess = req.user.is_saas_owner
      ? await pool.query(`SELECT * FROM conciliacoes WHERE id = $1`, [id])
      : await pool.query(
          `SELECT * FROM conciliacoes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [id, req.user.empresa_id || 0, req.user.empresa || '']
        );
    if (!sess.rowCount) return jsonErro(res, 404, 'Sessão não encontrada');

    const empresaResolvida = await validarAcessoEmpresa(req, sess.rows[0].empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    await pool.query(`DELETE FROM conciliacao_itens WHERE conciliacao_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`, [id, empresaResolvida.id, empresaResolvida.nome]);
    await pool.query(
      `DELETE FROM conciliacoes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao excluir conciliação:', error);
    jsonErro(res, 500, 'Erro ao excluir conciliação');
  }
});

  return router;
};