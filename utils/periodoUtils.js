const { normalizarDataISO } = require('./normalizadores');

// Whitelist de campos permitidos para interpolação segura em SQL
const CAMPOS_PERIODO_PERMITIDOS = new Set([
  // simples
  'data', 'data_pagamento', 'data_vencimento', 'data_emissao',
  'data_entrada', 'data_saida', 'criado_em', 'atualizado_em',
  'pagamento_data', 'vencimento', 'competencia',
  'data_movimento', 'lancamento_data',
  // aliases de tabela
  'c.data', 'v.data', 'p.data', 'e.data', 'f.data', 'lf.data',
  'cr.data_vencimento', 'cp.data_vencimento', 'fl.criado_em',
  'm.data_movimentacao',
  // expressões compostas
  'COALESCE(pagamento_data, vencimento)',
  'COALESCE(pagamento_data,vencimento)'
]);

function _validarCampoPeriodo(campo) {
  if (!CAMPOS_PERIODO_PERMITIDOS.has(campo)) {
    throw new Error(`Campo de período inválido: ${campo}`);
  }
}

function obterPeriodo(req) {
  const dataInicial = normalizarDataISO(req.query.data_inicial || req.query.inicio || '');
  const dataFinal   = normalizarDataISO(req.query.data_final  || req.query.fim   || '');
  if (dataInicial && dataFinal && dataInicial > dataFinal) {
    const err = new Error(`Período inválido: início (${dataInicial}) após fim (${dataFinal})`);
    err.statusCode = 400;
    throw err;
  }
  return { dataInicial, dataFinal };
}

function adicionarFiltroPeriodo({ campo, params, dataInicial, dataFinal, castDate = true }) {
  _validarCampoPeriodo(campo);
  let sql = '';
  const campoSql = castDate ? `DATE(${campo})` : campo;
  const paramCast = castDate ? '' : '::text';

  if (dataInicial) {
    params.push(dataInicial);
    sql += ` AND ${campoSql} >= $${params.length}${paramCast}`;
  }

  if (dataFinal) {
    params.push(dataFinal);
    sql += ` AND ${campoSql} <= $${params.length}${paramCast}`;
  }

  return sql;
}

function adicionarFiltroPeriodoRange({
  campoInicial,
  campoFinal,
  params,
  dataInicial,
  dataFinal,
  castDate = true
}) {
  _validarCampoPeriodo(campoInicial);
  _validarCampoPeriodo(campoFinal);
  let sql = '';
  const inicioSql = castDate ? `DATE(${campoInicial})` : campoInicial;
  const fimSql = castDate ? `DATE(${campoFinal})` : campoFinal;
  const paramCast = castDate ? '' : '::text';

  if (dataInicial) {
    params.push(dataInicial);
    sql += ` AND COALESCE(${fimSql}, ${inicioSql}) >= $${params.length}${paramCast}`;
  }

  if (dataFinal) {
    params.push(dataFinal);
    sql += ` AND COALESCE(${fimSql}, ${inicioSql}) <= $${params.length}${paramCast}`;
  }

  return sql;
}

module.exports = {
  obterPeriodo,
  adicionarFiltroPeriodo,
  adicionarFiltroPeriodoRange
};
