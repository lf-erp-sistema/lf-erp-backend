'use strict';
const express = require('express');
const { normalizarDecimal, normalizarDataISO, hoje } = require('../../utils/normalizadores');
const { requirePermissao } = require('../../utils/permissoes');
const { dispararWebhookComRetry } = require('../../utils/webhookContabil');
const { jsonErro } = require('../../utils/routeHelpers');

// Parte 2/3 de contas-receber.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// baixa de pagamento (total/parcial), estorno de baixa total e estorno de baixa parcial.
module.exports = function contasReceberBaixaRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, atualizarStatusContasReceberPorEmpresa,
  registrarLogFinanceiro
}) {
  const router = express.Router();

  router.post('/contas-receber/pagar/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return jsonErro(res, 400, 'ID inválido');

    const client = await pool.connect();
    try {

      await client.query('BEGIN');

      const contaResult = req.user?.is_saas_owner
        ? await client.query(`SELECT * FROM contas_receber WHERE id = $1 FOR UPDATE`, [id])
        : await client.query(
            `SELECT * FROM contas_receber
             WHERE id = $1
               AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
             FOR UPDATE`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (contaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return jsonErro(res, 404, 'Conta não encontrada');
      }

      const conta = contaResult.rows[0];
      const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);

      if (!empresaResolvida) {
        await client.query('ROLLBACK');
        return jsonErro(res, 403, 'Sem acesso');
      }

      if (String(conta.status || '').toLowerCase() === 'pago') {
        await client.query('ROLLBACK');
        return jsonErro(res, 400, 'Esta conta já está paga');
      }

      // conta.valor vem do PostgreSQL como string "480.00" (NUMERIC). normalizarDecimal
      // trata ponto como separador de milhar (formato BR) e corromperia para 48000.
      // Para valores do banco usamos Number(); normalizarDecimal é só para input do usuário.
      const valorAtual = Number(conta.valor || 0);
      const valorPagoInformado = normalizarDecimal(req.body?.valor_pago || 0);
      const valorPago = valorPagoInformado > 0 ? valorPagoInformado : valorAtual;

      if (valorPago <= 0) {
        await client.query('ROLLBACK');
        return jsonErro(res, 400, 'Valor de pagamento inválido');
      }

      if (valorPago > valorAtual) {
        await client.query('ROLLBACK');
        return jsonErro(res, 400, 'Valor pago não pode ser maior que o saldo da conta');
      }

      const dataPagamento = normalizarDataISO(req.body?.data_pagamento) || hoje();

      const pagamentoTotal = valorPago >= valorAtual;
      const novoValor = pagamentoTotal ? valorAtual : Number((valorAtual - valorPago).toFixed(2));
      const novoStatus = pagamentoTotal ? 'pago' : 'parcial';

      const formaPagamentoBaixa = req.body?.forma_pagamento ? String(req.body.forma_pagamento).trim() : null;
      await client.query(
        `
        UPDATE contas_receber
        SET status = $1,
            valor_original = COALESCE(valor_original, valor),
            valor = $2,
            data_pagamento = CASE WHEN $1 = 'pago' THEN $3::text ELSE data_pagamento END,
            forma_pagamento = CASE WHEN $7::text IS NOT NULL AND $7::text != '' THEN $7::text ELSE forma_pagamento END,
            atualizado_em = NOW()
        WHERE id = $4 AND (empresa_id = $5 OR (empresa_id IS NULL AND empresa = $6))
        `,
        [novoStatus, novoValor, dataPagamento, id, empresaResolvida.id, empresaResolvida.nome, formaPagamentoBaixa]
      );

      if (!pagamentoTotal) {
        await client.query(
          `
          INSERT INTO lancamentos_financeiros (
    empresa,
    empresa_id,
    tipo,
    categoria,
    descricao,
    valor,
    status,
    vencimento,
    pagamento_data,
    observacao,
    conta_receber_id,
    criado_em,
    atualizado_em
  )
  VALUES (
    $1,
    $2,
    'receita',
    'contas_receber',
    $3,
    $4,
    'pago',
    $5,
    $5,
    $6,
    $7,
    NOW() AT TIME ZONE 'America/Fortaleza',
    NOW() AT TIME ZONE 'America/Fortaleza'
  )
          `,
          [
            empresaResolvida.nome,
            empresaResolvida.id,
            `Recebimento parcial da conta #${id}`,
            valorPago,
            dataPagamento,
            `Baixa parcial registrada automaticamente. Saldo restante: ${novoValor}`,
            id
          ]
        );
      }

      await client.query('COMMIT');

      try { await registrarLogFinanceiro({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        tipo: pagamentoTotal ? 'baixa' : 'baixa_parcial',
        entidade: 'contas_receber',
        entidade_id: id,
        descricao: pagamentoTotal
          ? `Baixa total da conta a receber #${id}`
          : `Baixa parcial da conta a receber #${id}`,
        valor: valorPago,
        usuario_id: req.user?.id
      }); } catch (logErr) { console.error('[cr-pagar] log:', logErr.message); }

      // Notifica integração contábil em background
      dispararWebhookComRetry(pool, empresaResolvida.id, 'recebimento.registrado', {
        id, valor: valorPago, cliente: conta.cliente_nome, status: novoStatus
      }).catch((e) => console.error(`[webhook-contabil] recebimento=${id}:`, e.message));

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[cr-pagar] status-cr:', e.message); }

      // Re-fetch resiliente: o pagamento JÁ foi commitado. Se o SELECT falhar,
      // ainda retornamos sucesso com os dados que já temos em memória.
      let contaAtualizada = null;
      try {
        const contaAtualizadaResult = await pool.query(
          `
          SELECT
            *,
            CASE
              WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN 'pago'
             WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial'
      AND data_vencimento IS NOT NULL
      AND data_vencimento < $2::text
    THEN 'parcial_atrasado'
    WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial' THEN 'parcial'
    WHEN data_vencimento IS NOT NULL AND data_vencimento < $2::text THEN 'atrasado'
              ELSE 'pendente'
            END AS status_exibicao
          FROM contas_receber
          WHERE id = $1 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
          `,
          [id, hoje(), empresaResolvida.id, empresaResolvida.nome]
        );
        contaAtualizada = contaAtualizadaResult.rows[0] || null;
      } catch (refetchErr) {
        console.error('[cr-pagar] re-fetch falhou (pagamento já commitado):', refetchErr.message);
      }

      res.json({
        sucesso: true,
        mensagem: pagamentoTotal
          ? 'Conta baixada com sucesso'
          : 'Baixa parcial registrada com sucesso',
        conta: contaAtualizada
          ? {
              ...contaAtualizada,
              valor: Number(contaAtualizada.valor || 0),
              parcela: Number(contaAtualizada.parcela || 1),
              total_parcelas: Number(contaAtualizada.total_parcelas || 1),
              status: contaAtualizada.status_exibicao
            }
          : { id, valor: novoValor, status: novoStatus }
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('[cr-pagar] ERRO id=%d: %s\n%s', id, error.message, error.stack || '');
      jsonErro(res, 500, 'Erro ao baixar conta');
    } finally {
      client.release();
    }
  });

  router.post('/contas-receber/estornar/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
    const id = Number(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const contaResult = req.user.is_saas_owner
        ? await client.query(`SELECT * FROM contas_receber WHERE id = $1 FOR UPDATE`, [id])
        : await client.query(
            `SELECT * FROM contas_receber WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) FOR UPDATE`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (contaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return jsonErro(res, 404, 'Conta não encontrada');
      }

      const conta = contaResult.rows[0];
      const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);

      if (!empresaResolvida) {
        await client.query('ROLLBACK');
        return jsonErro(res, 403, 'Sem acesso');
      }

      if (String(conta.status || '').toLowerCase() !== 'pago') {
        await client.query('ROLLBACK');
        return jsonErro(res, 400, 'Esta conta não está paga');
      }

      const novoStatus =
        conta.data_vencimento &&
        String(conta.data_vencimento).slice(0, 10) < hoje()
          ? 'atrasado'
          : 'pendente';

      await client.query(
        `
        UPDATE contas_receber
        SET status = $1,
            data_pagamento = NULL,
            valor = COALESCE(valor_original, valor),
            atualizado_em = NOW()
        WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
        `,
        [novoStatus, id, empresaResolvida.id, empresaResolvida.nome]
      );

      await client.query('COMMIT');

      try {
        await registrarLogFinanceiro({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          tipo: 'estorno',
          entidade: 'contas_receber',
          entidade_id: id,
          descricao: `Estorno da baixa da conta a receber #${id}`,
          valor: conta.valor_atualizado || conta.valor || 0,
          usuario_id: req.user?.id
        });
      } catch (logErr) {
        console.error('[cr-estornar] log financeiro:', logErr.message);
      }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[cr-estornar] status-cr:', e.message); }

      const contaAtualizadaResult = await pool.query(
        `
        SELECT *
        FROM contas_receber
        WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        `,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      const contaAtualizada = contaAtualizadaResult.rows[0];

      res.json({
        sucesso: true,
        mensagem: 'Baixa estornada com sucesso',
        conta: {
          ...contaAtualizada,
          valor: Number(contaAtualizada.valor || 0),
          parcela: Number(contaAtualizada.parcela || 1),
          total_parcelas: Number(contaAtualizada.total_parcelas || 1),
          multa: Number(contaAtualizada.multa || 0),
          juros: Number(contaAtualizada.juros || 0),
          valor_atualizado: Number(contaAtualizada.valor_atualizado || contaAtualizada.valor || 0),
          dias_atraso: Number(contaAtualizada.dias_atraso || 0)
        }
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Erro ao estornar baixa de conta a receber:', error);
      jsonErro(res, 500, 'Erro ao estornar baixa de conta a receber');
    } finally {
      client.release();
    }
  });

  router.post('/contas-receber/estornar-parcial/:lancamentoId', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
    const lancamentoId = Number(req.params.lancamentoId);
    if (!lancamentoId || isNaN(lancamentoId)) return jsonErro(res, 400, 'ID inválido');

    const client = await pool.connect();
    try {

      await client.query('BEGIN');

      const lancamentoResult = await client.query(
        req.user.is_saas_owner
          ? `SELECT * FROM lancamentos_financeiros WHERE id = $1 LIMIT 1 FOR UPDATE`
          : `SELECT * FROM lancamentos_financeiros WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1 FOR UPDATE`,
        req.user.is_saas_owner
          ? [lancamentoId]
          : [lancamentoId, req.user.empresa_id || 0, req.user.empresa || '']
      );

      if (lancamentoResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return jsonErro(res, 404, 'Recebimento parcial não encontrado');
      }

      const lancamento = lancamentoResult.rows[0];

      if (String(lancamento.status || '').toLowerCase() === 'estornado') {
        await client.query('ROLLBACK');
        return jsonErro(res, 400, 'Este recebimento parcial já foi estornado');
      }
      if (String(lancamento.status || '').toLowerCase() !== 'pago') {
        await client.query('ROLLBACK');
        return jsonErro(res, 400, 'Este recebimento parcial ainda não foi pago');
      }

      const contaId = Number(lancamento.conta_receber_id || 0);

      if (!contaId) {
        await client.query('ROLLBACK');
        return jsonErro(res, 400, 'Não foi possível identificar a conta vinculada');
      }

      const contaResult = await client.query(
        `
        SELECT *
        FROM contas_receber
        WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        FOR UPDATE
        `,
        [contaId, lancamento.empresa_id || 0, lancamento.empresa || '']
      );

      if (contaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return jsonErro(res, 404, 'Conta vinculada não encontrada');
      }

      const conta = contaResult.rows[0];
      const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);

      if (!empresaResolvida) {
        await client.query('ROLLBACK');
        return jsonErro(res, 403, 'Sem acesso');
      }

      // Valores vindos do banco (NUMERIC vem como string "480.00"): usar Number(),
      // não normalizarDecimal (que trataria o ponto como separador de milhar BR).
      const valorEstorno = Number(lancamento.valor || 0);
      const valorAtualConta = Number(conta.valor || 0);
      const novoValorConta = Number((valorAtualConta + valorEstorno).toFixed(2));
      const valorOriginalConta = Number(conta.valor_original || 0);
      const estaVencido = conta.data_vencimento && String(conta.data_vencimento).slice(0, 10) < hoje();

      const novoStatus =
        valorOriginalConta > 0 && novoValorConta < valorOriginalConta
          ? (estaVencido ? 'parcial_atrasado' : 'parcial')
          : (estaVencido ? 'atrasado' : 'pendente');

      await client.query(
        `
        UPDATE contas_receber
        SET valor = $1,
            status = $2,
            atualizado_em = NOW()
        WHERE id = $3
          AND (empresa_id = $4 OR (empresa_id IS NULL AND empresa = $5))
        `,
        [novoValorConta, novoStatus, contaId, empresaResolvida.id, empresaResolvida.nome]
      );

      await client.query(
        `
        UPDATE lancamentos_financeiros
        SET status = 'estornado',
            observacao = COALESCE(observacao, '') || ' | Estornado em ' || NOW(),
            atualizado_em = NOW()
        WHERE id = $1
          AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        `,
        [lancamentoId, empresaResolvida.id, empresaResolvida.nome]
      );

      await client.query('COMMIT');

      try { await registrarLogFinanceiro({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        tipo: 'estorno_baixa_parcial',
        entidade: 'lancamentos_financeiros',
        entidade_id: lancamentoId,
        descricao: `Estorno do recebimento parcial #${lancamentoId} da conta #${contaId}`,
        valor: valorEstorno,
        usuario_id: req.user?.id
      }); } catch (logErr) { console.error('[log-financeiro] estorno parcial:', logErr.message); }

      res.json({
        sucesso: true,
        mensagem: 'Recebimento parcial estornado com sucesso',
        conta_id: contaId,
        valor_estornado: valorEstorno,
        novo_saldo: novoValorConta
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao estornar recebimento parcial:', error);
      jsonErro(res, 500, 'Erro ao estornar recebimento parcial');
    } finally {
      client.release();
    }
  });

  return router;
};
