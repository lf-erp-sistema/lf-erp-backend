'use strict';

const _statusThrottleReceber = new Map();
const _statusThrottlePagar   = new Map();
const STATUS_THROTTLE_MS     = 60_000;

const _configCache      = new Map();
const CONFIG_CACHE_TTL_MS = 60_000;

function createFinanceiroOps(pool, { hoje, normalizarDecimal, normalizarInt, addDias }) {
  async function obterConfigEmpresa(empresa, empresaId = null, executor = pool) {
    const agora = Date.now();
    const cached = _configCache.get(empresa);
    if (cached && agora - cached.ts < CONFIG_CACHE_TTL_MS) return cached.data;
    const result = await executor.query(
      `SELECT taxa_multa, taxa_juros_dia FROM configuracoes
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) LIMIT 1`,
      [empresaId || 0, empresa]
    );
    const data = result.rows[0] || {};
    if (_configCache.size > 500) {
      for (const [k, v] of _configCache) {
        if (agora - v.ts > CONFIG_CACHE_TTL_MS) _configCache.delete(k);
      }
    }
    _configCache.set(empresa, { ts: agora, data });
    return data;
  }

  async function atualizarStatusContasReceberPorEmpresa(empresa, empresaId = null, { force = false } = {}) {
    const agora = Date.now();
    if (!force && _statusThrottleReceber.has(empresa) && agora - _statusThrottleReceber.get(empresa) < STATUS_THROTTLE_MS) return;
    if (_statusThrottleReceber.size > 500) {
      for (const [k, v] of _statusThrottleReceber) {
        if (agora > v + STATUS_THROTTLE_MS) _statusThrottleReceber.delete(k);
      }
    }
    _statusThrottleReceber.set(empresa, agora);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockKey = Number(empresaId || 0);
      const lock = await client.query(`SELECT pg_try_advisory_xact_lock($1, 1)`, [lockKey]);
      if (!lock.rows[0].pg_try_advisory_xact_lock) {
        await client.query('ROLLBACK');
        return false;
      }

      const dataHoje = hoje();
      const config = await obterConfigEmpresa(empresa, empresaId, client);
      const taxaMulta    = Number(config?.taxa_multa    ?? 0.02);
      const taxaJurosDia = Number(config?.taxa_juros_dia ?? 0.00033);

      await client.query(
        `
        UPDATE contas_receber
        SET status = CASE
              WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial' THEN status
              ELSE 'atrasado'
            END,
            dias_atraso = GREATEST(($2::date - data_vencimento::date), 0),
            multa = ROUND((valor * $3)::numeric, 2),
            juros = ROUND((valor * $4 * GREATEST(($2::date - data_vencimento::date), 0))::numeric, 2),
            valor_atualizado = ROUND(
              (
                valor
                + (valor * $3)
                + (valor * $4 * GREATEST(($2::date - data_vencimento::date), 0))
              )::numeric,
              2
            ),
            atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
        WHERE (empresa_id = $5 OR (empresa_id IS NULL AND empresa = $1))
          AND LOWER(COALESCE(status, 'pendente')) IN ('pendente', 'atrasado', 'parcial')
          AND data_vencimento IS NOT NULL
          AND data_vencimento < $2
        `,
        [empresa, dataHoje, taxaMulta, taxaJurosDia, empresaId]
      );

      await client.query(
        `
        UPDATE contas_receber
        SET dias_atraso = 0,
            multa = 0,
            juros = 0,
            valor_atualizado = valor,
            atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
        WHERE (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $1))
          AND LOWER(COALESCE(status, 'pendente')) = 'pendente'
          AND data_vencimento IS NOT NULL
          AND data_vencimento >= $2
        `,
        [empresa, dataHoje, empresaId]
      );

      await client.query(
        `
        UPDATE contas_receber
        SET status = 'pendente',
            dias_atraso = 0,
            multa = 0,
            juros = 0,
            valor_atualizado = valor,
            atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
        WHERE (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $1))
          AND LOWER(COALESCE(status, 'pendente')) = 'atrasado'
          AND data_vencimento IS NOT NULL
          AND data_vencimento >= $2
        `,
        [empresa, dataHoje, empresaId]
      );

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function atualizarStatusContasReceberGlobal() {
    await pool.query(
      `UPDATE contas_receber
        SET status = 'atrasado',
            atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
        WHERE status = 'pendente'
          AND data_vencimento IS NOT NULL
          AND data_vencimento < $1`,
      [hoje()]
    );
  }

  async function atualizarStatusContasPagarPorEmpresa(empresa, empresaId = null, { force = false } = {}) {
    const agora = Date.now();
    if (!force && _statusThrottlePagar.has(empresa) && agora - _statusThrottlePagar.get(empresa) < STATUS_THROTTLE_MS) return;
    if (_statusThrottlePagar.size > 500) {
      for (const [k, v] of _statusThrottlePagar) {
        if (agora > v + STATUS_THROTTLE_MS) _statusThrottlePagar.delete(k);
      }
    }
    _statusThrottlePagar.set(empresa, agora);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockKey = Number(empresaId || 0);
      const lock = await client.query(`SELECT pg_try_advisory_xact_lock($1, 2)`, [lockKey]);
      if (!lock.rows[0].pg_try_advisory_xact_lock) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE contas_pagar
          SET status = 'atrasado',
              atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
          WHERE (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $1))
            AND LOWER(COALESCE(status, 'pendente')) = 'pendente'
            AND data_vencimento IS NOT NULL
            AND data_vencimento < $2`,
        [empresa, hoje(), empresaId]
      );
      await client.query(
        `UPDATE contas_pagar
          SET status = 'pendente',
              atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
          WHERE (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $1))
            AND LOWER(COALESCE(status, 'pendente')) = 'atrasado'
            AND data_vencimento IS NOT NULL
            AND data_vencimento >= $2`,
        [empresa, hoje(), empresaId]
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function atualizarStatusContasPagarGlobal() {
    await pool.query(
      `UPDATE contas_pagar
        SET status = 'atrasado',
            atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
        WHERE status = 'pendente'
          AND data_vencimento IS NOT NULL
          AND data_vencimento < $1`,
      [hoje()]
    );
  }

  function agendarAtualizacaoNoturna() {
    const { createManutencaoDiaria } = require('./manutencaoDiaria');
    const executar = createManutencaoDiaria({ pool, hoje,
      atualizarReceber: (nome, id) => atualizarStatusContasReceberPorEmpresa(nome, id, { force: true }),
      atualizarPagar: (nome, id) => atualizarStatusContasPagarPorEmpresa(nome, id, { force: true }) });
    async function rodar() {
      try {
        await executar();
      } catch (err) {
        console.error('[scheduler] Erro na manutenção financeira:', err.message);
      } finally {
        // Recupera execução perdida no boot e tenta novamente após falha.
        // O registro no banco evita refazer atualizações a cada verificação.
        setTimeout(rodar, 5 * 60_000).unref();
      }
    }
    rodar();
  }

  async function criarParcelasContasReceber({
    client,
    empresa,
    empresa_id,
    venda_id,
    cliente_id,
    cliente_nome,
    total,
    quantidade_parcelas,
    data_primeiro_vencimento,
    intervalo_dias,
    observacao,
    criado_por,
    forma_pagamento
  }) {
    const parcelas = Math.min(normalizarInt(quantidade_parcelas) || 0, 360);
    const valorTotal = normalizarDecimal(total);
    const primeiroVencimento = data_primeiro_vencimento || hoje();

    if (parcelas <= 0) return [];

    const valorBase = Math.round((valorTotal / parcelas) * 100) / 100;
    let acumulado = 0;
    const parcelasGeradas = [];

    for (let i = 1; i <= parcelas; i++) {
      let valorParcela = valorBase;

      if (i === parcelas) {
        valorParcela = Number((valorTotal - acumulado).toFixed(2));
      }

      acumulado = Number((acumulado + valorParcela).toFixed(2));

      const vencimento =
        i === 1
          ? primeiroVencimento
          : addDias(primeiroVencimento, (i - 1) * normalizarInt(intervalo_dias || 30));

      const result = await client.query(
        `INSERT INTO contas_receber
        (
          empresa,
          empresa_id,
          venda_id,
          cliente_id,
          cliente_nome,
          parcela,
          total_parcelas,
          valor,
          valor_original,
          data_vencimento,
          data_pagamento,
          status,
          forma_pagamento,
          observacao,
          criado_por,
          criado_em,
          atualizado_em
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, NULL, 'pendente', $10, $11, $12,
                NOW() AT TIME ZONE 'America/Fortaleza', NOW() AT TIME ZONE 'America/Fortaleza')
        RETURNING *`,
        [
          empresa,
          empresa_id || null,
          venda_id,
          cliente_id || null,
          cliente_nome || '',
          i,
          parcelas,
          valorParcela,
          vencimento,
          forma_pagamento || 'Promissória',
          observacao || '',
          criado_por || null
        ]
      );

      parcelasGeradas.push(result.rows[0]);
    }

    return parcelasGeradas;
  }

  async function registrarMovimentacaoEstoque({
    empresa,
    empresa_id,
    produto_id,
    grade_id = null,
    tipo,
    quantidade,
    observacao,
    referencia_tipo,
    referencia_id,
    usuario_id,
    client = null
  }) {
    const executor = client || pool;

    await executor.query(
      `INSERT INTO movimentacoes_estoque
        (
          empresa,
          empresa_id,
          produto_id,
          grade_id,
          tipo,
          quantidade,
          observacao,
          referencia_tipo,
          referencia_id,
          usuario_id,
          data_movimentacao
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() AT TIME ZONE 'America/Fortaleza')`,
      [
        empresa,
        empresa_id || null,
        produto_id,
        grade_id || null,
        tipo,
        quantidade,
        observacao || '',
        referencia_tipo || null,
        referencia_id || null,
        usuario_id || null
      ]
    );
  }

  async function registrarAuditoria({
    empresa,
    empresa_id,
    usuario_id,
    usuario_nome,
    modulo,
    acao,
    referencia_id = null,
    dados_anteriores = null,
    dados_novos = null,
    req = null,
    client = null
  }) {
    const executor = client || pool;

    const query = executor.query(
      `INSERT INTO logs_auditoria
      (
        empresa,
        empresa_id,
        usuario_id,
        usuario_nome,
        modulo,
        acao,
        referencia_id,
        dados_anteriores,
        dados_novos,
        ip,
        user_agent,
        criado_em
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW() AT TIME ZONE 'America/Fortaleza')`,
      [
        empresa || null,
        empresa_id || null,
        usuario_id || null,
        usuario_nome || '',
        modulo,
        acao,
        referencia_id,
        dados_anteriores ? JSON.stringify(dados_anteriores) : null,
        dados_novos ? JSON.stringify(dados_novos) : null,
        req?.ip || null,
        req?.headers?.['user-agent'] || null
      ]
    );

    if (client) {
      await query;
    } else {
      query.catch((err) => console.error('[auditoria]', err));
    }
  }

  async function registrarLogFinanceiro({
    empresa,
    empresa_id,
    tipo,
    entidade,
    entidade_id,
    descricao,
    valor,
    usuario_id
  }) {
    return pool.query(
      `
      INSERT INTO financeiro_logs
      (empresa, empresa_id, tipo, entidade, entidade_id, descricao, valor, usuario_id, criado_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() AT TIME ZONE 'America/Fortaleza')
      `,
      [
        empresa || null,
        empresa_id || null,
        tipo || '',
        entidade || '',
        entidade_id || null,
        descricao || '',
        Number(valor || 0),
        usuario_id || null
      ]
    ).catch((err) => console.error('[log_financeiro]', err));
  }

  return {
    obterConfigEmpresa,
    atualizarStatusContasReceberPorEmpresa,
    atualizarStatusContasReceberGlobal,
    atualizarStatusContasPagarPorEmpresa,
    atualizarStatusContasPagarGlobal,
    agendarAtualizacaoNoturna,
    criarParcelasContasReceber,
    registrarMovimentacaoEstoque,
    registrarAuditoria,
    registrarLogFinanceiro
  };
}

module.exports = { createFinanceiroOps, _configCache };
