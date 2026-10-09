'use strict';
const express = require('express');
const { normalizarInt, normalizarDecimal, normalizarDataISO, hoje } = require('../../utils/normalizadores');
const { requirePermissao } = require('../../utils/permissoes');
const { jsonErro } = require('../../utils/routeHelpers');

// Parte 3/3 de contas-receber.routes.js (achado ARCH-01 da Auditoria 360, 2026-10-06):
// edição, criação manual (promissórias antigas) e exclusão de conta a receber.
module.exports = function contasReceberCrudRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, registrarLogFinanceiro
}) {
  const router = express.Router();

  router.delete('/contas-receber/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'deletar'), async (req, res) => {
    const id = Number(req.params.id);
    const escopoRaw = req.query.escopo || 'apenas_esta';
    const escopo = ['apenas_esta', 'esta_e_proximas', 'todas'].includes(escopoRaw) ? escopoRaw : 'apenas_esta';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const contaResult = req.user?.is_saas_owner
        ? await client.query(
            `SELECT * FROM contas_receber WHERE id = $1 LIMIT 1 FOR UPDATE`,
            [id]
          )
        : await client.query(
            `SELECT * FROM contas_receber WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1 FOR UPDATE`,
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

      // Contas de venda: apenas escopo bulk é permitido
      if (conta.venda_id) {
        if (escopo === 'apenas_esta') {
          await client.query('ROLLBACK');
          return jsonErro(res, 400, 'Contas originadas de venda não podem ser excluídas individualmente. Use "Esta e as próximas" ou "Todas".');
        }

        // Bulk delete: remove pendentes/atrasadas da mesma venda
        const params = [conta.venda_id, empresaResolvida.id, empresaResolvida.nome];
        let whereParc = '';
        if (escopo === 'esta_e_proximas') {
          whereParc = `AND parcela >= $4`;
          params.push(conta.parcela);
        }

        const delResult = await client.query(
          `DELETE FROM contas_receber
           WHERE venda_id = $1
             AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
             AND status NOT IN ('pago', 'parcial', 'parcial_atrasado')
             ${whereParc}
           RETURNING id`,
          params
        );

        await client.query('COMMIT');
        return res.json({ sucesso: true, mensagem: `${delResult.rowCount} parcela(s) excluída(s)` });
      }

      // Conta manual (sem venda_id) — exclusão individual
      if (['parcial', 'parcial_atrasado'].includes(String(conta.status || '').toLowerCase())) {
        const recebimentosAtivosResult = await client.query(
          `SELECT COUNT(*) AS total FROM lancamentos_financeiros
           WHERE (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $1))
             AND LOWER(COALESCE(status, '')) = 'pago'
             AND conta_receber_id = $3`,
          [empresaResolvida.nome, empresaResolvida.id, id]
        );
        if (Number(recebimentosAtivosResult.rows[0].total || 0) > 0) {
          await client.query('ROLLBACK');
          return jsonErro(res, 400, 'Conta parcialmente recebida possui recebimentos ativos. Estorne os recebimentos antes de excluir.');
        }
      }

      if (String(conta.status || '').toLowerCase() === 'pago') {
        await client.query('ROLLBACK');
        return jsonErro(res, 400, 'Conta paga não pode ser excluída');
      }

      const delResult = await client.query(
        `DELETE FROM contas_receber WHERE id = $1 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $2)) RETURNING id`,
        [id, empresaResolvida.nome, empresaResolvida.id]
      );

      if (delResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return jsonErro(res, 404, 'Conta não encontrada');
      }

      await client.query('COMMIT');

      try {
        await registrarLogFinanceiro({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          tipo: 'exclusao',
          entidade: 'contas_receber',
          entidade_id: id,
          descricao: `Exclusão da conta manual #${id}`,
          valor: conta.valor || 0,
          usuario_id: req.user?.id
        });
      } catch (logErr) { console.error('[cr-excluir-manual] log financeiro:', logErr.message); }

      res.json({ sucesso: true, mensagem: 'Conta manual excluída com sucesso' });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao excluir conta:', error.message);
      jsonErro(res, 500, 'Erro ao excluir conta');
    } finally {
      client.release();
    }
  });

  // ================= EDIÇÃO DE CONTA A RECEBER =================
  router.put('/contas-receber/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
    const id = Number(req.params.id);
    const { observacao, data_vencimento, valor, escopo } = req.body;
    const escopoValido = ['apenas_esta', 'esta_e_proximas', 'todas'].includes(escopo) ? escopo : 'apenas_esta';

    try {
      const contaResult = req.user?.is_saas_owner
        ? await pool.query(`SELECT * FROM contas_receber WHERE id = $1 LIMIT 1`, [id])
        : await pool.query(
            `SELECT * FROM contas_receber WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (contaResult.rowCount === 0) return jsonErro(res, 404, 'Conta não encontrada');

      const conta = contaResult.rows[0];
      const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);
      if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

      const sets = [];
      const params = [];
      const camposAlterados = [];

      if (observacao !== undefined) {
        params.push(String(observacao).trim());
        sets.push(`observacao = $${params.length}`);
        camposAlterados.push('observação');
      }
      if (data_vencimento !== undefined) {
        const dataISO = normalizarDataISO(data_vencimento);
        if (!dataISO) return jsonErro(res, 400, 'Data inválida');
        params.push(dataISO);
        sets.push(`data_vencimento = $${params.length}`);
        camposAlterados.push('vencimento');
      }
      let valorFinal;
      if (valor !== undefined) {
        valorFinal = normalizarDecimal(valor);
        if (valorFinal <= 0) return jsonErro(res, 400, 'Valor inválido');
        params.push(valorFinal);
        sets.push(`valor = $${params.length}`);
        camposAlterados.push('valor');
      }

      if (!sets.length) return jsonErro(res, 400, 'Nenhum campo para atualizar');

      const usarBulk = escopoValido !== 'apenas_esta' && conta.venda_id;

      if (!usarBulk) {
        params.push(id);
        await pool.query(
          `UPDATE contas_receber SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params
        );
      } else {
        // Bulk: atualiza parcelas pendentes/atrasadas do mesmo venda_id
        const ei = params.length + 1; // empresa_id
        const en = params.length + 2; // empresa nome
        const vi = params.length + 3; // venda_id
        const extraParams = [empresaResolvida.id, empresaResolvida.nome, conta.venda_id];

        let whereParc = '';
        if (escopoValido === 'esta_e_proximas') {
          whereParc = `AND parcela >= $${params.length + 4}`;
          extraParams.push(conta.parcela);
        }

        await pool.query(
          `UPDATE contas_receber
           SET ${sets.join(', ')}
           WHERE (empresa_id = $${ei} OR (empresa_id IS NULL AND empresa = $${en}))
             AND venda_id = $${vi}
             AND status NOT IN ('pago', 'parcial', 'parcial_atrasado')
             ${whereParc}`,
          [...params, ...extraParams]
        );
      }

      try {
        await registrarLogFinanceiro({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          tipo: 'edicao',
          entidade: 'contas_receber',
          entidade_id: id,
          descricao: `Edição da conta a receber #${id} (${camposAlterados.join(', ')})${usarBulk ? ` — escopo: ${escopoValido}` : ''}`,
          valor: valorFinal !== undefined ? valorFinal : (conta.valor_atualizado || conta.valor || 0),
          usuario_id: req.user?.id
        });
      } catch (logErr) { console.error('[cr-editar] log financeiro:', logErr.message); }

      return res.json({ ok: true });
    } catch (err) {
      console.error('[PUT /contas-receber/:id]', err.message);
      return jsonErro(res, 500, 'Erro ao editar conta');
    }
  });

  // ================= CRIAÇÃO MANUAL DE CONTA A RECEBER =================
  router.post('/contas-receber/manual', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'criar'), async (req, res) => {
    try {
      const {
        empresa,
        cliente_id,
        cliente_nome,
        descricao,
        valor,
        data_vencimento,
        observacao,
        forma_pagamento,
        parcela,
        total_parcelas
      } = req.body;

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return jsonErro(res, 403, 'Sem acesso');
      }

      const valorFinal = normalizarDecimal(valor);

      if (valorFinal <= 0) {
        return jsonErro(res, 400, 'Valor inválido');
      }

      const dataVencimento = normalizarDataISO(data_vencimento) || hoje();

      let nomeCliente = String(cliente_nome || '').trim();

      if (cliente_id) {
        const clienteResult = await pool.query(
          `
          SELECT nome
          FROM clientes
          WHERE id = $1
            AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
          LIMIT 1
          `,
          [cliente_id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (clienteResult.rowCount > 0) {
          nomeCliente = clienteResult.rows[0].nome;
        }
      }

      const insertResult = await pool.query(
        `
        INSERT INTO contas_receber (
    empresa,
    empresa_id,
    cliente_id,
    cliente_nome,
    observacao,
    valor,
    valor_original,
    status,
    parcela,
    total_parcelas,
    data_vencimento,
    forma_pagamento,
    criado_em,
    atualizado_em
  )
  VALUES (
    $1,$2,$3,$4,$5,$6,$6,
    'pendente',
    $9,
    $10,
    $7,
    $8,
    NOW(),
    NOW()
  )
  RETURNING *
        `,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          cliente_id || null,
          nomeCliente || 'Cliente avulso',
          observacao || descricao || 'Promissória antiga cadastrada manualmente',
          valorFinal,
          dataVencimento,
          forma_pagamento || 'promissoria',
          normalizarInt(parcela) || 1,
          normalizarInt(total_parcelas) || 1
        ]
      );

      const conta = insertResult.rows[0];

      try {
        await registrarLogFinanceiro({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          tipo: 'criacao',
          entidade: 'contas_receber',
          entidade_id: conta.id,
          descricao: `Criação manual da conta a receber #${conta.id}`,
          valor: valorFinal,
          usuario_id: req.user?.id
        });
      } catch (logErr) { console.error('[cr-criar-manual] log financeiro:', logErr.message); }

      res.json({
        sucesso: true,
        mensagem: 'Conta manual cadastrada com sucesso',
        conta: {
          ...conta,
          valor: Number(conta.valor || 0),
          valor_original: Number(conta.valor_original || 0),
          valor_atualizado: Number(conta.valor_atualizado || 0)
        }
      });
    } catch (error) {
      console.error('Erro ao criar conta manual:', error);
      jsonErro(res, 500, 'Erro ao criar conta manual');
    }
  });

  return router;
};
