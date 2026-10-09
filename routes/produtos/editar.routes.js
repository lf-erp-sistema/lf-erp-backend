'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 3/4 de produtos.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): edição de produto.
module.exports = function produtosEditarRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa,
  normalizarDecimal, normalizarInt,
  registrarMovimentacaoEstoque, registrarAuditoria
}) {
  const router = express.Router();

  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'produtos', 'editar'), async (req, res) => {
    try {
      const id = Number(req.params.id);

      const {
        empresa,
        nome,
        preco,
        custo,
        custo_unitario,
        custo_medio,
        preco_promocional,
        promocao_ativa,
        estoque,
        estoque_minimo,
        codigo_barras,
        categoria,
        codigo_interno,
        gtin,
        unidade,
        descricao_completa,
        peso_bruto,
        peso_liquido,
        comprimento_cm,
        largura_cm,
        altura_cm,
        ncm,
        cfop_padrao,
        origem,
        icms_cst,
        icms_aliquota,
        icms_base_calculo,
        pis_cst,
        pis_aliquota,
        cofins_cst,
        cofins_aliquota,
        ipi_cst,
        ipi_aliquota
      } = req.body;

      if (!id) {
        return erro(res, 400, 'Produto inválido');
      }

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do produto');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      // PRD-M1: validar negativos antes de abrir transação
      const precoN   = normalizarDecimal(preco);
      const custoN   = normalizarDecimal(custo_unitario ?? custo);
      const estoqueN = normalizarInt(estoque);
      if (precoN < 0)   return erro(res, 400, 'Preço não pode ser negativo');
      if (custoN < 0)   return erro(res, 400, 'Custo não pode ser negativo');
      if (preco_promocional != null && normalizarDecimal(preco_promocional) < 0) return erro(res, 400, 'Preço promocional não pode ser negativo');
      if (estoqueN < 0) return erro(res, 400, 'Estoque não pode ser negativo');
      if (estoque_minimo !== undefined && normalizarInt(estoque_minimo) < 0) return erro(res, 400, 'estoque_minimo não pode ser negativo');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // SELECT ... FOR UPDATE trava a linha do produto até o COMMIT, evitando que
        // duas edições concorrentes calculem a diferença de estoque com base no
        // mesmo valor "atual" e uma delas sobrescreva o resultado da outra.
        const atualResult = await client.query(
          `SELECT * FROM produtos WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL FOR UPDATE`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (atualResult.rowCount === 0) {
          await client.query('ROLLBACK');
          return erro(res, 404, 'Produto não encontrado');
        }

        const atual = atualResult.rows[0];

        const precoFinal = normalizarDecimal(preco);
        // Input do usuário (custo_unitario/custo) usa normalizarDecimal (formato BR);
        // fallback atual.custo vem do banco (NUMERIC string) e usa Number().
        const custoBase = (custo_unitario != null)
          ? normalizarDecimal(custo_unitario)
          : (custo != null)
            ? normalizarDecimal(custo)
            : Number(atual.custo || 0);
        // custo_medio: se enviado explicitamente, usa o valor enviado.
        // Se custo foi alterado, reseta custo_medio para custoBase (evita herdar valor corrompido).
        // Só preserva atual.custo_medio (valor do banco → Number) se custo NÃO foi enviado.
        const custoMedioFinal = (custo_medio != null && custo_medio !== '')
          ? normalizarDecimal(custo_medio)
          : (custo != null || custo_unitario != null)
            ? custoBase
            : Number(atual.custo_medio || custoBase);
        const lucroUnitario = Number((precoFinal - custoMedioFinal).toFixed(2));
        const margemLucro =
          precoFinal > 0 ? Number(((lucroUnitario / precoFinal) * 100).toFixed(2)) : 0;

        const estoqueAtual = normalizarInt(atual.estoque);
        const estoqueNovo = normalizarInt(estoque);
        const diferenca = estoqueNovo - estoqueAtual;

        await client.query(
          `UPDATE produtos
          SET nome = $1,
            preco = $2,
            custo = $3,
            custo_unitario = $4,
            custo_medio = $5,
            lucro_unitario = $6,
            margem_lucro = $7,
            preco_promocional = $8,
            promocao_ativa = $9,
            estoque = $10,
            estoque_minimo = $11,
            codigo_barras = $12,
            categoria = $13,
            codigo_interno = $14,
            gtin = $15,
            unidade = $16,
            descricao_completa = $17,
            peso_bruto = $18,
            peso_liquido = $19,
            comprimento_cm = $20,
            largura_cm = $21,
            altura_cm = $22,
            ncm = $23,
            cfop_padrao = $24,
            origem = $25,
            icms_cst = $26,
            icms_aliquota = $27,
            icms_base_calculo = $28,
            pis_cst = $29,
            pis_aliquota = $30,
            cofins_cst = $31,
            cofins_aliquota = $32,
            ipi_cst = $33,
            ipi_aliquota = $34,
            atualizado_em = NOW()
          WHERE id = $35 AND (empresa_id = $36 OR (empresa_id IS NULL AND empresa = $37))`,
          [
            nome,
            precoFinal,
            custoBase,
            custoBase,
            custoMedioFinal,
            lucroUnitario,
            margemLucro,
            preco_promocional !== undefined ? normalizarDecimal(preco_promocional) : (atual.preco_promocional != null ? Number(atual.preco_promocional) : null),
            promocao_ativa !== undefined ? Boolean(promocao_ativa) : Boolean(atual.promocao_ativa),
            estoqueNovo,
            estoque_minimo !== undefined ? normalizarInt(estoque_minimo) : normalizarInt(atual.estoque_minimo),
            (codigo_barras || '').trim() || null,
            categoria || '',
            codigo_interno !== undefined ? (codigo_interno || null) : atual.codigo_interno,
            gtin !== undefined ? (gtin || null) : atual.gtin,
            unidade || atual.unidade || 'UN',
            descricao_completa !== undefined ? (descricao_completa || null) : atual.descricao_completa,
            peso_bruto !== undefined ? (peso_bruto ? normalizarDecimal(peso_bruto) : null) : atual.peso_bruto,
            peso_liquido !== undefined ? (peso_liquido ? normalizarDecimal(peso_liquido) : null) : atual.peso_liquido,
            comprimento_cm !== undefined ? (comprimento_cm ? normalizarDecimal(comprimento_cm) : null) : atual.comprimento_cm,
            largura_cm !== undefined ? (largura_cm ? normalizarDecimal(largura_cm) : null) : atual.largura_cm,
            altura_cm !== undefined ? (altura_cm ? normalizarDecimal(altura_cm) : null) : atual.altura_cm,
            ncm !== undefined ? (ncm || null) : atual.ncm,
            cfop_padrao !== undefined ? (cfop_padrao || null) : atual.cfop_padrao,
            origem !== undefined ? normalizarInt(origem) : atual.origem,
            icms_cst !== undefined ? (icms_cst || null) : atual.icms_cst,
            icms_aliquota !== undefined ? normalizarDecimal(icms_aliquota) : atual.icms_aliquota,
            icms_base_calculo !== undefined ? normalizarDecimal(icms_base_calculo) : atual.icms_base_calculo,
            pis_cst !== undefined ? (pis_cst || null) : atual.pis_cst,
            pis_aliquota !== undefined ? normalizarDecimal(pis_aliquota) : atual.pis_aliquota,
            cofins_cst !== undefined ? (cofins_cst || null) : atual.cofins_cst,
            cofins_aliquota !== undefined ? normalizarDecimal(cofins_aliquota) : atual.cofins_aliquota,
            ipi_cst !== undefined ? (ipi_cst || null) : atual.ipi_cst,
            ipi_aliquota !== undefined ? normalizarDecimal(ipi_aliquota) : atual.ipi_aliquota,
            id,
            empresaResolvida.id,
            empresaResolvida.nome
          ]
        );

        if (diferenca !== 0) {
          await registrarMovimentacaoEstoque({
            empresa: empresaResolvida.nome,
            empresa_id: empresaResolvida.id,
            produto_id: id,
            tipo: diferenca > 0 ? 'ajuste_entrada' : 'ajuste_saida',
            quantidade: Math.abs(diferenca),
            observacao: 'Ajuste manual na edição do produto',
            referencia_tipo: 'produto',
            referencia_id: id,
            usuario_id: req.user.id,
            client
          });
        }

        await registrarAuditoria({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          usuario_id: req.user.id,
          usuario_nome: req.user.nome || '',
          modulo: 'produtos',
          acao: 'edicao',
          referencia_id: id,
          dados_anteriores: atual,
          dados_novos: {
            nome,
            preco: precoFinal,
            custo: custoBase,
            custo_unitario: custoBase,
            custo_medio: custoMedioFinal,
            lucro_unitario: lucroUnitario,
            margem_lucro: margemLucro,
            preco_promocional: normalizarDecimal(preco_promocional),
            promocao_ativa: Boolean(promocao_ativa),
            estoque: estoqueNovo,
            estoque_minimo,
            codigo_barras,
            categoria
          },
          req,
          client
        });

        await client.query('COMMIT');

        return ok(res, {
          mensagem: 'Produto atualizado com sucesso'
        });
      } catch (errTx) {
        await client.query('ROLLBACK');
        throw errTx;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Erro real ao atualizar produto:', error);
      return erro(res, 500, 'Erro ao atualizar produto');
    }
  });

  return router;
};
