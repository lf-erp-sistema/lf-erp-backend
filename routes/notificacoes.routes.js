'use strict';
const express = require('express');
const { requirePermissao } = require('../utils/permissoes');
const { hoje, addDias } = require('../utils/normalizadores');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function notificacoesRoutes({ auth, pool, validarAcessoEmpresa, podeGerenciarFinanceiro }) {
  const router = express.Router();

// â”€â”€ NotificaÃ§Ãµes in-app â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /notificacoes â€” retorna notificaÃ§Ãµes relevantes para a empresa logada
router.get('/notificacoes', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return res.json({ sucesso: true, notificacoes: [] });
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const dataHoje = hoje();
    const amanha   = addDias(dataHoje, 1);
    const em7dias  = addDias(dataHoje, 7);

    const [estoqueResult, crResult, cpResult, trialResult] = await Promise.all([
      // Produtos abaixo do estoque mÃ­nimo
      pool.query(
        `SELECT id, nome, estoque, estoque_minimo FROM produtos
         WHERE empresa_id = $1 AND deletado_em IS NULL
           AND estoque_minimo > 0 AND estoque < estoque_minimo
         ORDER BY (estoque_minimo - estoque) DESC LIMIT 10`,
        [empresaResolvida.id]
      ),
      // Contas a receber vencendo hoje ou jÃ¡ atrasadas
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(COALESCE(valor_atualizado, valor)), 0) AS valor_total
         FROM contas_receber
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $3))
           AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago')
           AND data_vencimento <= $2`,
        [empresaResolvida.id, dataHoje, empresaResolvida.nome]
      ),
      // Contas a pagar vencendo hoje ou amanhÃ£
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(valor), 0) AS valor_total
         FROM contas_pagar
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $3))
           AND LOWER(COALESCE(status,'pendente')) = 'pendente'
           AND data_vencimento <= $2`,
        [empresaResolvida.id, amanha, empresaResolvida.nome]
      ),
      // Trial expirando em atÃ© 7 dias
      pool.query(
        `SELECT trial_fim FROM empresas
         WHERE id = $1 AND assinatura_status = 'trial'
           AND trial_fim IS NOT NULL AND trial_fim <= $2`,
        [empresaResolvida.id, em7dias]
      )
    ]);

    const notifs = [];

    // Estoque baixo
    const prodAbaixo = estoqueResult.rows;
    if (prodAbaixo.length > 0) {
      notifs.push({
        tipo:   'estoque',
        icone:  'fa-boxes-stacked',
        cor:    '#d69e2e',
        titulo: `${prodAbaixo.length} produto(s) abaixo do estoque mÃ­nimo`,
        texto:  prodAbaixo.slice(0, 3).map((p) => `${p.nome} (${p.estoque}/${p.estoque_minimo})`).join(', ') + (prodAbaixo.length > 3 ? ` e mais ${prodAbaixo.length - 3}` : ''),
        link:   'estoque'
      });
    }

    // CR vencidas/vencendo
    const cr = crResult.rows[0];
    if (Number(cr.total) > 0) {
      notifs.push({
        tipo:   'contas_receber',
        icone:  'fa-money-bill-wave',
        cor:    '#e53e3e',
        titulo: `${cr.total} conta(s) a receber em atraso`,
        texto:  `Total: R$ ${Number(cr.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
        link:   'contas-receber'
      });
    }

    // CP vencendo
    const cp = cpResult.rows[0];
    if (Number(cp.total) > 0) {
      notifs.push({
        tipo:   'contas_pagar',
        icone:  'fa-calendar-xmark',
        cor:    '#e53e3e',
        titulo: `${cp.total} conta(s) a pagar vencendo hoje/amanhÃ£`,
        texto:  `Total: R$ ${Number(cp.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
        link:   'contas-pagar'
      });
    }

    // Trial expirando
    if (trialResult.rowCount > 0) {
      const tf = trialResult.rows[0].trial_fim;
      const diasRestantes = Math.ceil((new Date(tf) - new Date(dataHoje)) / 86400000);
      notifs.push({
        tipo:   'trial',
        icone:  'fa-clock',
        cor:    '#d69e2e',
        titulo: diasRestantes <= 0 ? 'Seu trial expirou' : `Trial expira em ${diasRestantes} dia(s)`,
        texto:  'Escolha um plano para continuar usando o sistema.',
        link:   'configuracoes'
      });
    }

    res.json({ sucesso: true, notificacoes: notifs, total: notifs.length });
  } catch (err) {
    console.error('[notificacoes]', err.message);
    jsonErro(res, 500, 'Erro ao carregar notificaÃ§Ãµes');
  }
});


// â”€â”€ SSE (Server-Sent Events) â€” notificaÃ§Ãµes em tempo real â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const _sseClients = new Map(); // empresaId â†’ Set<Response>

async function _sseQueryNotificacoes(empresaId) {
  const dataHoje = hoje();
  const amanha   = addDias(dataHoje, 1);
  const em7dias  = addDias(dataHoje, 7);

  const [estoqueResult, crResult, cpResult, trialResult] = await Promise.all([
    pool.query(
      `SELECT id, nome, estoque, estoque_minimo FROM produtos
       WHERE empresa_id = $1 AND deletado_em IS NULL
         AND estoque_minimo > 0 AND estoque < estoque_minimo
       ORDER BY (estoque_minimo - estoque) DESC LIMIT 10`,
      [empresaId]
    ),
    pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(COALESCE(valor_atualizado, valor)), 0) AS valor_total
       FROM contas_receber
       WHERE empresa_id = $1
         AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago')
         AND data_vencimento <= $2`,
      [empresaId, dataHoje]
    ),
    pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(valor), 0) AS valor_total
       FROM contas_pagar
       WHERE empresa_id = $1
         AND LOWER(COALESCE(status,'pendente')) = 'pendente'
         AND data_vencimento <= $2`,
      [empresaId, amanha]
    ),
    pool.query(
      `SELECT trial_fim FROM empresas
       WHERE id = $1 AND assinatura_status = 'trial'
         AND trial_fim IS NOT NULL AND trial_fim <= $2`,
      [empresaId, em7dias]
    )
  ]);

  const notifs = [];

  const prodAbaixo = estoqueResult.rows;
  if (prodAbaixo.length > 0) {
    notifs.push({
      tipo:   'estoque',
      icone:  'fa-boxes-stacked',
      cor:    '#d69e2e',
      titulo: `${prodAbaixo.length} produto(s) abaixo do estoque mÃ­nimo`,
      texto:  prodAbaixo.slice(0, 3).map(p => `${p.nome} (${p.estoque}/${p.estoque_minimo})`).join(', ') +
              (prodAbaixo.length > 3 ? ` e mais ${prodAbaixo.length - 3}` : ''),
      link:   'estoque'
    });
  }

  const cr = crResult.rows[0];
  if (Number(cr.total) > 0) {
    notifs.push({
      tipo:   'contas_receber',
      icone:  'fa-money-bill-wave',
      cor:    '#e53e3e',
      titulo: `${cr.total} conta(s) a receber em atraso`,
      texto:  `Total: R$ ${Number(cr.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
      link:   'contas-receber'
    });
  }

  const cp = cpResult.rows[0];
  if (Number(cp.total) > 0) {
    notifs.push({
      tipo:   'contas_pagar',
      icone:  'fa-calendar-xmark',
      cor:    '#e53e3e',
      titulo: `${cp.total} conta(s) a pagar vencendo hoje/amanhÃ£`,
      texto:  `Total: R$ ${Number(cp.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
      link:   'contas-pagar'
    });
  }

  if (trialResult.rowCount > 0) {
    const tf = trialResult.rows[0].trial_fim;
    const diasRestantes = Math.ceil((new Date(tf) - new Date(dataHoje)) / 86400000);
    notifs.push({
      tipo:   'trial',
      icone:  'fa-clock',
      cor:    '#d69e2e',
      titulo: diasRestantes <= 0 ? 'Seu trial expirou' : `Trial expira em ${diasRestantes} dia(s)`,
      texto:  'Escolha um plano para continuar usando o sistema.',
      link:   'configuracoes'
    });
  }

  return { notificacoes: notifs, total: notifs.length };
}

async function ssePush(res, empresaId) {
  try {
    const dados = await _sseQueryNotificacoes(empresaId);
    res.write(`event: notificacoes\ndata: ${JSON.stringify(dados)}\n\n`);
  } catch (err) {
    console.error('[SSE] ssePush:', err.message);
  }
}

function sseNotificarEmpresa(empresaId) {
  const clientes = _sseClients.get(empresaId);
  if (!clientes || clientes.size === 0) return;
  for (const res of [...clientes]) {
    ssePush(res, empresaId).catch(() => clientes.delete(res));
  }
}

// GET /sse-notificacoes â€” stream de eventos para o frontend
router.get('/sse-notificacoes', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const SSE_MAX_EMPRESAS = 1000;
    const empresaId = empresaResolvida.id;
    if (!_sseClients.has(empresaId)) {
      if (_sseClients.size >= SSE_MAX_EMPRESAS) {
        const [primeiraKey] = _sseClients.keys();
        const primeiroSet = _sseClients.get(primeiraKey);
        for (const r of primeiroSet) { try { r.end(); } catch {} }
        _sseClients.delete(primeiraKey);
      }
      _sseClients.set(empresaId, new Set());
    }
    const clientes = _sseClients.get(empresaId);
    if (clientes.size >= 30) {
      return jsonErro(res, 429, 'Limite de conexÃµes SSE atingido para esta empresa');
    }
    clientes.add(res);

    // Envio imediato
    await ssePush(res, empresaId);

    // Heartbeat a cada 25s (menor que timeout de proxy)
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);
    heartbeat.unref();

    // Refresh a cada 60s
    const refresh = setInterval(async () => {
      await ssePush(res, empresaId).catch(() => {});
    }, 60000);
    refresh.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(refresh);
      clientes.delete(res);
    });
  } catch (err) {
    console.error('[SSE] ConexÃ£o:', err.message);
    if (!res.headersSent) jsonErro(res, 500, 'Erro no SSE');
  }
});

  return router;
};