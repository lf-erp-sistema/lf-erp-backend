'use strict';

const _planoCache = new Map();
const PLANO_CACHE_TTL_MS = 60_000;

function createPlanoUtils(pool, { hoje }) {
  async function obterPlanoEmpresa(empresaId, empresaNome) {
    const cacheKey = empresaId ? `id:${empresaId}` : `nome:${empresaNome}`;
    const agora = Date.now();
    const cached = _planoCache.get(cacheKey);
    if (cached && agora - cached.ts < PLANO_CACHE_TTL_MS) return cached.data;

    const result = await pool.query(
      `
      SELECT
        e.id AS empresa_id,
        e.nome AS empresa_nome,
        e.assinatura_status,
        e.bloqueada,
        e.trial_fim,
        p.*
      FROM empresas e
      LEFT JOIN planos p ON p.id = e.plano_id
      WHERE e.id = $1 OR LOWER(e.nome) = LOWER($2)
      LIMIT 1
      `,
      [empresaId || 0, empresaNome || '']
    );

    if (result.rowCount === 0) {
      _planoCache.delete(cacheKey);
      return null;
    }

    const data = result.rows[0];
    if (_planoCache.size > 500) {
      for (const [k, v] of _planoCache) {
        if (agora - v.ts > PLANO_CACHE_TTL_MS) _planoCache.delete(k);
      }
    }
    _planoCache.set(cacheKey, { ts: agora, data });
    return data;
  }

  async function validarLimitePlano({ empresaResolvida, recurso }) {
    const plano = await obterPlanoEmpresa(empresaResolvida.id, empresaResolvida.nome);

    if (!plano) {
      return { permitido: false, mensagem: 'Plano da empresa não encontrado.' };
    }

    if (plano.bloqueada) {
      return { permitido: false, mensagem: 'Empresa bloqueada. Entre em contato com o suporte.' };
    }

    if (plano.assinatura_status === 'inativo' || plano.assinatura_status === 'cancelado') {
      return {
        permitido: false,
        mensagem: 'Assinatura inativa. Regularize o acesso para continuar.'
      };
    }

    const _planoTrialFimStr = plano.trial_fim instanceof Date
      ? plano.trial_fim.toISOString().slice(0, 10)
      : String(plano.trial_fim || '').slice(0, 10);
    if (plano.assinatura_status === 'trial' && plano.trial_fim && _planoTrialFimStr < hoje()) {
      return {
        permitido: false,
        mensagem: 'Período de teste expirado. Escolha um plano para continuar.'
      };
    }

    const limites = {
      usuarios:     { tabela: 'usuarios',     coluna: 'limite_usuarios',     softDelete: false },
      produtos:     { tabela: 'produtos',     coluna: 'limite_produtos',     softDelete: true },
      clientes:     { tabela: 'clientes',     coluna: 'limite_clientes',     softDelete: true },
      fornecedores: { tabela: 'fornecedores', coluna: 'limite_fornecedores', softDelete: true }
    };

    const config = limites[recurso];

    if (!config) {
      return { permitido: true, plano };
    }

    const limite = Number(plano[config.coluna] || 0);

    if (limite <= 0) {
      return { permitido: true, plano };
    }

    const totalResult = await pool.query(
      `SELECT COUNT(*) AS total FROM ${config.tabela}
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
         ${config.softDelete ? 'AND deletado_em IS NULL' : ''}`,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    const totalAtual = Number(totalResult.rows[0].total || 0);

    if (totalAtual >= limite) {
      return {
        permitido: false,
        mensagem: `Limite do plano atingido para ${recurso}. Plano atual permite até ${limite}.`
      };
    }

    return { permitido: true, plano };
  }

  async function validarLimiteVendasMes(empresaResolvida) {
    const plano = await obterPlanoEmpresa(empresaResolvida.id, empresaResolvida.nome);

    if (!plano) {
      return { permitido: false, mensagem: 'Plano da empresa não encontrado.' };
    }

    const limite = Number(plano.limite_vendas_mes || 0);

    if (limite <= 0) {
      return { permitido: true, plano };
    }

    const hojeData = hoje();
    const inicioMes = hojeData.slice(0, 8) + '01';

    const totalResult = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM vendas
      WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
        AND data >= $3
        AND data <= $4
      `,
      [empresaResolvida.id, empresaResolvida.nome, inicioMes, hojeData]
    );

    const totalAtual = Number(totalResult.rows[0].total || 0);

    if (totalAtual >= limite) {
      return {
        permitido: false,
        mensagem: `Limite mensal de vendas atingido. Plano atual permite até ${limite} vendas por mês.`
      };
    }

    return { permitido: true, plano };
  }

  return { obterPlanoEmpresa, validarLimitePlano, validarLimiteVendasMes };
}

module.exports = { createPlanoUtils, _planoCache };
