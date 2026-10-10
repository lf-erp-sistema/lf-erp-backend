'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 3/3 de compras.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// importação de XML de NF-e do fornecedor. Faz o parse e retorna os dados
// estruturados — não cria nada no banco, só extrai para o frontend confirmar.
module.exports = function comprasImportarXmlRoutes({ auth, pool, writeRateLimiter, validarAcessoEmpresa }) {
  const router = express.Router();

  function xmlSanitize(xml) {
    if (!xml) return '';
    // Remove comentários XML
    let s = xml.replace(/<!--[\s\S]*?-->/g, '');
    // Expande seções CDATA: <![CDATA[content]]> → content
    s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    return s;
  }

  function xmlTag(xml, tag) {
    if (!xml) return null;
    const s = xmlSanitize(xml);
    // Aceita tanto <tag> quanto <ns:tag> (namespace prefix)
    const openRe = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:[\\s>])`);
    const openMatch = openRe.exec(s);
    if (!openMatch) return null;
    const closeAngle = s.indexOf('>', openMatch.index);
    if (closeAngle === -1) return null;
    // self-closing tag?
    if (s[closeAngle - 1] === '/') return null;
    const closeRe = new RegExp(`</(?:[\\w.-]+:)?${tag}>`);
    const rest = s.slice(closeAngle + 1);
    const closeMatch = closeRe.exec(rest);
    if (!closeMatch) return null;
    return rest.slice(0, closeMatch.index).trim() || null;
  }

  function xmlTagAll(xml, tag) {
    if (!xml) return [];
    const s = xmlSanitize(xml);
    const results = [];
    const openRe  = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:[\\s>])`, 'g');
    const closeRe = new RegExp(`</(?:[\\w.-]+:)?${tag}>`);
    let openMatch;
    while ((openMatch = openRe.exec(s)) !== null && results.length < 1000) {
      const closeAngle = s.indexOf('>', openMatch.index);
      if (closeAngle === -1) break;
      if (s[closeAngle - 1] === '/') continue; // self-closing
      const rest = s.slice(closeAngle + 1);
      const closeMatch = closeRe.exec(rest);
      if (!closeMatch) break;
      results.push(rest.slice(0, closeMatch.index).trim());
      openRe.lastIndex = closeAngle + 1 + closeMatch.index + closeMatch[0].length;
    }
    return results;
  }

  const FORMA_PGTO_NF = {
    '01': 'dinheiro', '02': 'cheque', '03': 'cartao credito',
    '04': 'cartao debito', '05': 'credito loja', '10': 'vale alimentacao',
    '11': 'vale refeicao', '12': 'vale presente', '13': 'vale combustivel',
    '14': 'duplicata mercantil', '15': 'boleto', '17': 'pix', '90': 'sem pagamento', '99': 'outros'
  };

  router.post('/importar-xml', auth, writeRateLimiter, requirePermissao(pool, 'compras', 'criar'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { conteudo } = req.body;
      if (!conteudo) return erro(res, 400, 'Conteúdo XML não informado');
      const MAX_XML_BYTES = 5 * 1024 * 1024; // 5 MB
      if (Buffer.byteLength(String(conteudo), 'utf8') > MAX_XML_BYTES) {
        return erro(res, 400, 'XML excede o limite máximo de 5 MB');
      }

      // ── Emitente (fornecedor) ────────────────────────────────────────────
      const emitBloco = xmlTag(conteudo, 'emit');
      const cnpjFornecedor = emitBloco ? (xmlTag(emitBloco, 'CNPJ') || xmlTag(emitBloco, 'CPF') || '') : '';
      const nomeFornecedor = emitBloco ? (xmlTag(emitBloco, 'xNome') || '') : '';

      // ── Identificação ────────────────────────────────────────────────────
      const ideBloco = xmlTag(conteudo, 'ide');
      const numeroNF = ideBloco ? (xmlTag(ideBloco, 'nNF') || '') : '';
      const dhEmi    = ideBloco ? (xmlTag(ideBloco, 'dhEmi') || xmlTag(ideBloco, 'dEmi') || '') : '';
      const dataEmissao = dhEmi ? dhEmi.slice(0, 10) : null;

      // ── Total ────────────────────────────────────────────────────────────
      const totalBloco = xmlTag(conteudo, 'ICMSTot');
      const totalNF = totalBloco ? parseFloat(xmlTag(totalBloco, 'vNF') || '0') : 0;

      // ── Forma de pagamento ───────────────────────────────────────────────
      const detPagBloco = xmlTag(conteudo, 'detPag') || xmlTag(conteudo, 'pag') || '';
      const tPag = xmlTag(detPagBloco, 'tPag') || '99';
      const formaPagamento = FORMA_PGTO_NF[tPag] || 'outros';

      // ── Itens ────────────────────────────────────────────────────────────
      const detBlocos = xmlTagAll(conteudo, 'det');
      const itens = detBlocos.map((det) => {
        const prod = xmlTag(det, 'prod') || det;
        const codigo  = xmlTag(prod, 'cProd') || '';
        const nome    = xmlTag(prod, 'xProd') || 'Produto';
        const ncm     = xmlTag(prod, 'NCM') || '';
        const unidade = xmlTag(prod, 'uCom') || 'UN';
        const qty     = parseFloat(xmlTag(prod, 'qCom') || '1');
        const vUnit   = parseFloat(xmlTag(prod, 'vUnCom') || '0');
        const vTotal  = parseFloat(xmlTag(prod, 'vProd') || String(qty * vUnit));
        return { codigo, nome, ncm, unidade, quantidade: qty, custo_unitario: vUnit, total: vTotal };
      }).filter(i => i.quantidade > 0);

      if (!itens.length) return erro(res, 400, 'Nenhum item encontrado no XML');

      // Tenta encontrar fornecedor pelo CNPJ
      let fornecedorId = null;
      let fornecedorNome = nomeFornecedor;
      if (cnpjFornecedor) {
        const cnpjLimpo = cnpjFornecedor.replace(/\D/g, '');
        const fRes = await pool.query(
          `SELECT id, nome FROM fornecedores
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
             AND replace(replace(replace(cnpj,'.',''),'-',''),'/','') = $3
             AND deletado_em IS NULL
           LIMIT 1`,
          [empresaResolvida.id, empresaResolvida.nome, cnpjLimpo]
        );
        if (fRes.rowCount > 0) {
          fornecedorId   = fRes.rows[0].id;
          fornecedorNome = fRes.rows[0].nome;
        }
      }

      return ok(res, {
        fornecedor_cnpj: cnpjFornecedor,
        fornecedor_nome: fornecedorNome,
        fornecedor_id:   fornecedorId,
        numero_nf:       numeroNF,
        data_emissao:    dataEmissao,
        total:           totalNF,
        forma_pagamento: formaPagamento,
        itens
      });
    } catch (error) {
      console.error('[compras] importar-xml:', error.message);
      return erro(res, 500, 'Erro ao processar o XML da nota fiscal');
    }
  });

  return router;
};
