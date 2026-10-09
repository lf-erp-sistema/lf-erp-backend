'use strict';
const express = require('express');
const { requirePermissao } = require('../../utils/permissoes');
const { erro, ok } = require('../../utils/routeHelpers');

// Parte 1/4 de produtos.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06): criação de produto.
module.exports = function produtosCriarRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, validarLimitePlano,
  normalizarDecimal, normalizarInt,
  registrarMovimentacaoEstoque, registrarAuditoria
}) {
  const router = express.Router();

  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'produtos', 'criar'), async (req, res) => {
    try {
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
        // novos campos F2
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
        ipi_aliquota,
        tem_grade
      } = req.body;

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do produto');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const limitePlano = await validarLimitePlano({
        empresaResolvida,
        recurso: 'produtos'
      });

      if (!limitePlano.permitido) {
        return erro(res, 403, limitePlano.mensagem);
      }

      const precoFinal = normalizarDecimal(preco);
      const custoBase = normalizarDecimal(custo_unitario || custo);
      const custoMedioFinal = normalizarDecimal(custo_medio || custoBase);

      if (precoFinal < 0) return erro(res, 400, 'Preço não pode ser negativo');
      if (custoBase < 0) return erro(res, 400, 'Custo não pode ser negativo');
      if (preco_promocional != null && normalizarDecimal(preco_promocional) < 0) return erro(res, 400, 'Preço promocional não pode ser negativo');
      if (normalizarInt(estoque) < 0) return erro(res, 400, 'Estoque inicial não pode ser negativo');
      if (normalizarInt(estoque_minimo) < 0) return erro(res, 400, 'Estoque mínimo não pode ser negativo');

      const lucroUnitario = Number((precoFinal - custoMedioFinal).toFixed(2));
      const margemLucro =
        precoFinal > 0 ? Number(((lucroUnitario / precoFinal) * 100).toFixed(2)) : 0;

      const prodClient = await pool.connect();
      let produtoId;
      try {
        await prodClient.query('BEGIN');

        // Gerar código de barras automático se não informado
        let codigoBarrasFinal = (codigo_barras || '').trim();
        if (!codigoBarrasFinal) {
          // PRD-M2: lock transacional para evitar race condition na geração do código
          await prodClient.query(
            `SELECT pg_advisory_xact_lock(hashtext($1::text || '_codigos_barras'))`,
            [String(empresaResolvida.id)]
          );
          const cbRes = await prodClient.query(
            `SELECT n AS next_cb
             FROM generate_series(1, (
               SELECT COALESCE(MAX(CAST(codigo_barras AS BIGINT)), 0) + 1
               FROM produtos
               WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
                 AND codigo_barras ~ '^[0-9]+$'
             )) AS gs(n)
             WHERE NOT EXISTS (
               SELECT 1 FROM produtos
               WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
                 AND codigo_barras ~ '^[0-9]+$'
                 AND CAST(codigo_barras AS BIGINT) = gs.n
             )
             ORDER BY n LIMIT 1`,
            [empresaResolvida.id, empresaResolvida.nome]
          );
          codigoBarrasFinal = String(Number(cbRes.rows[0].next_cb)).padStart(6, '0');
        }

        const result = await prodClient.query(
        `INSERT INTO produtos
        (empresa, empresa_id, nome, preco, custo, custo_unitario, custo_medio, lucro_unitario, margem_lucro,
         preco_promocional, promocao_ativa, estoque, estoque_minimo, codigo_barras, categoria,
         codigo_interno, gtin, unidade, descricao_completa,
         peso_bruto, peso_liquido, comprimento_cm, largura_cm, altura_cm,
         ncm, cfop_padrao, origem,
         icms_cst, icms_aliquota, icms_base_calculo,
         pis_cst, pis_aliquota,
         cofins_cst, cofins_aliquota,
         ipi_cst, ipi_aliquota,
         tem_grade,
         criado_em, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
                $28,$29,$30,$31,$32,$33,$34,$35,$36,$37,
                NOW(), NOW())
        RETURNING id`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          nome,
          precoFinal,
          custoBase,
          custoBase,
          custoMedioFinal,
          lucroUnitario,
          margemLucro,
          normalizarDecimal(preco_promocional),
          Boolean(promocao_ativa),
          normalizarInt(estoque),
          normalizarInt(estoque_minimo),
          codigoBarrasFinal,
          categoria || '',
          // novos F2
          codigo_interno || null,
          gtin || null,
          unidade || 'UN',
          descricao_completa || null,
          peso_bruto ? normalizarDecimal(peso_bruto) : null,
          peso_liquido ? normalizarDecimal(peso_liquido) : null,
          comprimento_cm ? normalizarDecimal(comprimento_cm) : null,
          largura_cm ? normalizarDecimal(largura_cm) : null,
          altura_cm ? normalizarDecimal(altura_cm) : null,
          ncm || null,
          cfop_padrao || null,
          origem !== undefined ? normalizarInt(origem) : 0,
          icms_cst || null,
          icms_aliquota ? normalizarDecimal(icms_aliquota) : 0,
          icms_base_calculo ? normalizarDecimal(icms_base_calculo) : 100,
          pis_cst || null,
          pis_aliquota ? normalizarDecimal(pis_aliquota) : 0,
          cofins_cst || null,
          cofins_aliquota ? normalizarDecimal(cofins_aliquota) : 0,
          ipi_cst || null,
          ipi_aliquota ? normalizarDecimal(ipi_aliquota) : 0,
          Boolean(tem_grade)
        ]
      );

        produtoId = result.rows[0].id;

        if (normalizarInt(estoque) > 0) {
          await registrarMovimentacaoEstoque({
            empresa: empresaResolvida.nome,
            empresa_id: empresaResolvida.id,
            produto_id: produtoId,
            tipo: 'cadastro_inicial',
            quantidade: normalizarInt(estoque),
            observacao: 'Estoque inicial do cadastro',
            referencia_tipo: 'produto',
            referencia_id: produtoId,
            usuario_id: req.user.id,
            client: prodClient
          });
        }

        await prodClient.query('COMMIT');
      } catch (txErr) {
        await prodClient.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        prodClient.release();
      }

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'produtos',
        acao: 'cadastro',
        referencia_id: produtoId,
        dados_novos: {
          nome,
          preco,
          custo,
          estoque,
          estoque_minimo,
          codigo_barras,
          categoria
        },
        req
      });

      return ok(res, {
        id: produtoId,
        dados: {
          id: produtoId
        }
      });
    } catch (error) {
      console.error('Erro real ao cadastrar produto:', error);
      return erro(res, 500, 'Erro ao cadastrar produto');
    }
  });

  return router;
};
