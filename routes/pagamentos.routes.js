'use strict';
const express    = require('express');
const https      = require('https');
const { requirePermissao }        = require('../utils/permissoes');
const { encryptField, decryptField } = require('../utils/pixCrypto');
const { resolverClienteAsaas, criarBoleto: criarBoletoAsaas, consultarBoleto: consultarBoletoAsaas, verificarWebhookAsaas } = require('../utils/asaas');
const { enviarEmailBoasVindas, getSaasSmtp, criarTransporter } = require('../utils/email');
const { dispararWebhookComRetry } = require('../utils/webhookContabil');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function pagamentosRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
}) {
  const router = express.Router();
// ================= PIX (EFÍ / Gerencianet) =================


function httpsPost(url, headers, body, agentOptions = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const agent = agentOptions.pfx
      ? new https.Agent(agentOptions)
      : undefined;

    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      agent
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, headers, agentOptions = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const agent = agentOptions.pfx
      ? new https.Agent(agentOptions)
      : undefined;

    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers, agent };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function efiAuth(config) {
  const base = config.pix_sandbox
    ? 'https://api-pix-h.gerencianet.com.br'
    : 'https://api-pix.gerencianet.com.br';

  const creds = Buffer.from(`${config.pix_client_id}:${config.pix_client_secret}`).toString('base64');
  const agentOpts = config.pix_certificado
    ? { pfx: Buffer.from(config.pix_certificado, 'base64'), passphrase: '' }
    : {};

  const res = await httpsPost(
    `${base}/oauth/token`,
    { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
    JSON.stringify({ grant_type: 'client_credentials' }),
    agentOpts
  );

  if (res.status !== 200 || !res.body.access_token) {
    throw new Error(`Falha na autenticação EFÍ: ${JSON.stringify(res.body)}`);
  }

  return { accessToken: res.body.access_token, base, agentOpts };
}

// Descriptografa os campos sensíveis do PIX antes de usar nas chamadas à EFÍ
function resolvePixConfig(config) {
  if (!config) return {};
  return {
    ...config,
    pix_client_id:     decryptField(config.pix_client_id),
    pix_client_secret: decryptField(config.pix_client_secret),
    pix_certificado:   decryptField(config.pix_certificado)
  };
}

// GET /pagamentos/pix/config
router.get('/pagamentos/pix/config', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const result = await pool.query(
      `SELECT pix_gateway, pix_chave, pix_sandbox,
              CASE WHEN pix_client_id IS NOT NULL THEN '****' ELSE NULL END AS pix_client_id,
              CASE WHEN pix_client_secret IS NOT NULL THEN '****' ELSE NULL END AS pix_client_secret,
              CASE WHEN pix_certificado IS NOT NULL THEN 'configurado' ELSE NULL END AS pix_certificado
       FROM configuracoes WHERE empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2) LIMIT 1`,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    const row = result.rows[0] || { pix_gateway: 'efi', pix_sandbox: true };
    res.json(row);
  } catch (error) {
    console.error('Erro ao buscar config PIX:', error);
    jsonErro(res, 500, 'Erro ao buscar configuração PIX');
  }
});

// PUT /pagamentos/pix/config
router.put('/pagamentos/pix/config', auth, writeRateLimiter, requirePermissao(pool, 'configuracoes', 'editar'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { pix_client_id, pix_client_secret, pix_certificado, pix_chave, pix_sandbox } = req.body;

    const encClientId = pix_client_id && pix_client_id !== '****'
      ? encryptField(pix_client_id) : pix_client_id;
    const encClientSecret = pix_client_secret && pix_client_secret !== '****'
      ? encryptField(pix_client_secret) : pix_client_secret;
    const encCertificado = pix_certificado && pix_certificado !== 'configurado'
      ? encryptField(pix_certificado) : pix_certificado;

    await pool.query(
      `UPDATE configuracoes
       SET pix_gateway       = 'efi',
           pix_client_id     = COALESCE(NULLIF($3, '****'), pix_client_id),
           pix_client_secret = COALESCE(NULLIF($4, '****'), pix_client_secret),
           pix_certificado   = COALESCE(NULLIF($5, 'configurado'), pix_certificado),
           pix_chave         = $6,
           pix_sandbox       = $7,
           atualizado_em     = NOW()
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`,
      [empresaResolvida.id, empresaResolvida.nome,
       encClientId, encClientSecret, encCertificado,
       pix_chave, pix_sandbox ?? true]
    );

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao salvar config PIX:', error);
    jsonErro(res, 500, 'Erro ao salvar configuração PIX');
  }
});

// POST /pagamentos/pix/gerar
router.post('/pagamentos/pix/gerar', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { conta_receber_id, valor, cliente_nome } = req.body;
    if (!valor || Number(valor) <= 0) return jsonErro(res, 400, 'Valor inválido');

    if (conta_receber_id) {
      const crCheck = await pool.query(
        `SELECT 1 FROM contas_receber WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
        [Number(conta_receber_id), empresaResolvida.id, empresaResolvida.nome]
      );
      if (crCheck.rowCount === 0) return jsonErro(res, 403, 'Conta a receber não pertence à empresa');
    }

    const cfg = await pool.query(
      `SELECT * FROM configuracoes WHERE empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2) LIMIT 1`,
      [empresaResolvida.id, empresaResolvida.nome]
    );
    const config = resolvePixConfig(cfg.rows[0] || {});

    const expiracao = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    let txid, pixCopiaECola, qrImage;

    if (config.pix_sandbox || !config.pix_client_id) {
      // ── Modo sandbox: dados de demonstração ──────────────────────────────
      txid = `SANDBOX_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      pixCopiaECola = `00020126580014br.gov.bcb.pix0136${config.pix_chave || 'chave-pix-sandbox'}5204000053039865802BR5925SANDBOX DEMO LF ERP6009SAO PAULO62070503***6304DEMO`;
      qrImage = null; // frontend mostra placeholder
    } else {
      // ── Modo produção: chamada real à EFÍ ────────────────────────────────
      const { accessToken, base, agentOpts } = await efiAuth(config);

      const valorStr = Number(valor).toFixed(2);
      const cobPayload = {
        calendario: { expiracao: 1800 },
        valor: { original: valorStr },
        chave: config.pix_chave,
        infoAdicionais: [
          { nome: 'Sistema', valor: 'LF ERP' },
          ...(cliente_nome ? [{ nome: 'Cliente', valor: cliente_nome }] : [])
        ]
      };

      const cobRes = await httpsPost(
        `${base}/v2/cob`,
        { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        JSON.stringify(cobPayload),
        agentOpts
      );

      if (cobRes.status !== 201) throw new Error(`EFÍ /v2/cob: ${JSON.stringify(cobRes.body)}`);
      txid = cobRes.body.txid;
      pixCopiaECola = cobRes.body.pixCopiaECola;

      // Buscar QR code image
      const locId = cobRes.body.loc?.id;
      if (locId) {
        const qrRes = await httpsGet(`${base}/v2/loc/${locId}/qrcode`,
          { 'Authorization': `Bearer ${accessToken}` }, agentOpts);
        if (qrRes.status === 200) qrImage = qrRes.body.imagemQrcode;
      }
    }

    await pool.query(
      `INSERT INTO cobrancas_pix (empresa, empresa_id, conta_receber_id, txid, valor, cliente_nome, status, pix_copia_e_cola, qr_image, expiracao)
       VALUES ($1,$2,$3,$4,$5,$6,'ATIVA',$7,$8,$9)
       ON CONFLICT (txid) DO NOTHING`,
      [empresaResolvida.nome, empresaResolvida.id, conta_receber_id || null,
       txid, Number(valor), cliente_nome || null, pixCopiaECola, qrImage, expiracao]
    );

    res.json({
      sucesso: true,
      txid,
      pix_copia_e_cola: pixCopiaECola,
      qr_image: qrImage,
      expiracao: expiracao.toISOString(),
      sandbox: config.pix_sandbox || !config.pix_client_id
    });
  } catch (error) {
    console.error('Erro ao gerar PIX:', error);
    jsonErro(res, 500, 'Erro ao gerar cobrança PIX');
  }
});

// GET /pagamentos/pix/status/:txid
router.get('/pagamentos/pix/status/:txid', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const { txid } = req.params;
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const local = await pool.query(
      `SELECT * FROM cobrancas_pix WHERE txid = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
      [txid, empresaResolvida.id, empresaResolvida.nome]
    );

    if (!local.rowCount) return jsonErro(res, 404, 'Cobrança não encontrada');
    const cobr = local.rows[0];

    // Sandbox: status sempre ATIVA (demo)
    if (cobr.status === 'CONCLUIDA') return res.json({ status: 'CONCLUIDA', pago_em: cobr.pago_em });

    const cfg = await pool.query(
      `SELECT * FROM configuracoes WHERE empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2) LIMIT 1`,
      [empresaResolvida.id, empresaResolvida.nome]
    );
    const config = resolvePixConfig(cfg.rows[0] || {});

    if (config.pix_sandbox || !config.pix_client_id || txid.startsWith('SANDBOX_')) {
      return res.json({ status: 'ATIVA', sandbox: true });
    }

    const { accessToken, base, agentOpts } = await efiAuth(config);
    const checkRes = await httpsGet(`${base}/v2/cob/${txid}`,
      { 'Authorization': `Bearer ${accessToken}` }, agentOpts);

    if (checkRes.status === 200 && checkRes.body.status === 'CONCLUIDA') {
      const pixClient = await pool.connect();
      try {
        await pixClient.query('BEGIN');

        await pixClient.query(
          `UPDATE cobrancas_pix SET status='CONCLUIDA', pago_em=NOW() AT TIME ZONE 'America/Fortaleza'
           WHERE txid=$1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [txid, empresaResolvida.id, empresaResolvida.nome]
        );

        if (cobr.conta_receber_id) {
          const crUpd = await pixClient.query(
            `UPDATE contas_receber
               SET status='pago', data_pagamento=(NOW() AT TIME ZONE 'America/Fortaleza')::date,
                   atualizado_em=NOW() AT TIME ZONE 'America/Fortaleza'
             WHERE id=$1 AND status != 'pago'
               AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
             RETURNING id, descricao, valor, data_vencimento`,
            [cobr.conta_receber_id, empresaResolvida.id, empresaResolvida.nome]
          );

          if (crUpd.rowCount > 0) {
            const cr = crUpd.rows[0];
            await pixClient.query(
              `INSERT INTO lancamentos_financeiros
                 (empresa, empresa_id, tipo, categoria, descricao, valor, vencimento, pagamento_data,
                  status, conta_receber_id, criado_em, atualizado_em)
               VALUES ($1,$2,'receita','contas_receber',$3,$4,$5,
                       (NOW() AT TIME ZONE 'America/Fortaleza')::date,
                       'pago',$6,
                       NOW() AT TIME ZONE 'America/Fortaleza',
                       NOW() AT TIME ZONE 'America/Fortaleza')`,
              [empresaResolvida.nome, empresaResolvida.id,
               `PIX recebido - ${cr.descricao || txid}`,
               Number(cr.valor), cr.data_vencimento, cobr.conta_receber_id]
            );
          }
        }

        await pixClient.query('COMMIT');
      } catch (pixErr) {
        await pixClient.query('ROLLBACK').catch(() => {});
        console.error('[PIX] Erro ao registrar pagamento:', pixErr.message);
      } finally {
        pixClient.release();
      }
    }

    res.json({ status: checkRes.body.status || 'ATIVA' });
  } catch (error) {
    console.error('Erro ao verificar status PIX:', error);
    jsonErro(res, 500, 'Erro ao verificar status da cobrança');
  }
});

// ================= BOLETO ASAAS =================


async function getAsaasConfig(empresaResolvida) {
  const cfg = await pool.query(
    `SELECT asaas_api_key, asaas_sandbox FROM configuracoes
     WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) LIMIT 1`,
    [empresaResolvida.id, empresaResolvida.nome]
  );
  const row = cfg.rows[0] || {};
  return {
    apiKey:  decryptField(row.asaas_api_key) || null,
    sandbox: row.asaas_sandbox !== false   // default true (sandbox)
  };
}

// GET /pagamentos/boleto/config
router.get('/pagamentos/boleto/config', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const cfg = await pool.query(
      `SELECT
         CASE WHEN asaas_api_key IS NOT NULL THEN '****' ELSE NULL END AS asaas_api_key,
         asaas_sandbox
       FROM configuracoes
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) LIMIT 1`,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json({ sucesso: true, ...(cfg.rows[0] || { asaas_sandbox: true }) });
  } catch (err) {
    console.error('[boleto] GET config:', err.message);
    jsonErro(res, 500, 'Erro ao buscar configuração Asaas');
  }
});

// PUT /pagamentos/boleto/config
router.put('/pagamentos/boleto/config', auth, writeRateLimiter, requirePermissao(pool, 'configuracoes', 'editar'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { asaas_api_key, asaas_sandbox } = req.body;
    const _asaasKeyParaSalvar = (asaas_api_key && asaas_api_key !== '****')
      ? encryptField(asaas_api_key)
      : (asaas_api_key || null);

    await pool.query(
      `UPDATE configuracoes
       SET asaas_api_key = COALESCE(NULLIF($3, '****'), asaas_api_key),
           asaas_sandbox = $4,
           atualizado_em = NOW()
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`,
      [empresaResolvida.id, empresaResolvida.nome, _asaasKeyParaSalvar, asaas_sandbox !== false]
    );

    res.json({ sucesso: true });
  } catch (err) {
    console.error('[boleto] PUT config:', err.message);
    jsonErro(res, 500, 'Erro ao salvar configuração Asaas');
  }
});

// POST /pagamentos/boleto/gerar
router.post('/pagamentos/boleto/gerar', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { conta_receber_id } = req.body;
    if (!conta_receber_id) return jsonErro(res, 400, 'conta_receber_id é obrigatório');

    // Busca a conta a receber
    const crResult = await pool.query(
      `SELECT cr.*, c.cpf, c.cpf_cnpj, c.telefone, c.email
       FROM contas_receber cr
       LEFT JOIN clientes c ON c.id = cr.cliente_id
         AND (c.empresa_id = cr.empresa_id OR (c.empresa_id IS NULL AND c.empresa = cr.empresa))
       WHERE cr.id = $1 AND (cr.empresa_id = $2 OR (cr.empresa_id IS NULL AND cr.empresa = $3))`,
      [Number(conta_receber_id), empresaResolvida.id, empresaResolvida.nome]
    );

    if (crResult.rowCount === 0) return jsonErro(res, 404, 'Conta a receber não encontrada');

    const cr = crResult.rows[0];

    if (['pago', 'parcial'].includes(String(cr.status || '').toLowerCase())) {
      return jsonErro(res, 400, 'Esta conta já foi paga ou está parcialmente paga');
    }

    // Boleto já emitido e válido
    if (cr.boleto_id && !cr.boleto_id.startsWith('DEMO_')) {
      const { apiKey, sandbox } = await getAsaasConfig(empresaResolvida);
      if (apiKey) {
        const boleto = await consultarBoletoAsaas(apiKey, sandbox, cr.boleto_id);
        if (boleto.status !== 'OVERDUE' && boleto.status !== 'CANCELLED') {
          return res.json({ sucesso: true, boleto, reaproveitado: true });
        }
      }
    }

    const { apiKey, sandbox } = await getAsaasConfig(empresaResolvida);

    // Cria ou busca cliente Asaas
    let customerId = null;
    if (apiKey && (cr.cliente_id || cr.cliente_nome)) {
      customerId = await resolverClienteAsaas(apiKey, sandbox, {
        nome:     cr.cliente_nome || 'Cliente',
        cpfCnpj:  cr.cpf || cr.cpf_cnpj || null,
        email:    cr.email || null,
        telefone: cr.telefone || null
      });
    }

    const vencimento = cr.data_vencimento || hoje();
    const descricao  = `Parcela ${cr.parcela || 1}/${cr.total_parcelas || 1} — ${cr.cliente_nome || 'Cliente'}`;

    const boleto = await criarBoletoAsaas(apiKey, sandbox, {
      customerId,
      valor:             Number(cr.valor_atualizado || cr.valor),
      vencimento,
      descricao,
      externalReference: String(cr.id)
    });

    // Persiste dados do boleto
    await pool.query(
      `UPDATE contas_receber
       SET boleto_id            = $1,
           boleto_url           = $2,
           boleto_linha_digitavel = $3,
           boleto_status        = $4,
           boleto_gerado_em     = NOW(),
           atualizado_em        = NOW()
       WHERE id = $5
         AND (empresa_id = $6 OR (empresa_id IS NULL AND empresa = $7))`,
      [
        boleto.id,
        boleto.invoiceUrl || boleto.bankSlipUrl || null,
        boleto.linhaDigitavel || null,
        boleto.status || 'PENDING',
        cr.id,
        empresaResolvida.id,
        empresaResolvida.nome
      ]
    );

    res.json({ sucesso: true, boleto, sandbox: boleto.demo || sandbox || !apiKey });
  } catch (err) {
    console.error('[boleto] POST gerar:', err.message);
    jsonErro(res, 500, 'Erro ao gerar boleto');
  }
});

// GET /pagamentos/boleto/status/:contaReceberID
router.get('/pagamentos/boleto/status/:contaReceberID', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const crId = Number(req.params.contaReceberID);
    const crResult = await pool.query(
      `SELECT boleto_id, boleto_url, boleto_linha_digitavel, boleto_status, boleto_gerado_em
       FROM contas_receber WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
      [crId, empresaResolvida.id, empresaResolvida.nome]
    );

    if (crResult.rowCount === 0) return jsonErro(res, 404, 'Conta não encontrada');

    const cr = crResult.rows[0];
    if (!cr.boleto_id) return jsonErro(res, 404, 'Nenhum boleto gerado para esta conta');

    const { apiKey, sandbox } = await getAsaasConfig(empresaResolvida);
    const boleto = await consultarBoletoAsaas(apiKey, sandbox, cr.boleto_id);

    // Atualiza status no banco se necessário
    if (boleto.status !== cr.boleto_status) {
      await pool.query(
        `UPDATE contas_receber SET boleto_status = $1, atualizado_em = NOW() WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))`,
        [boleto.status, crId, empresaResolvida.id, empresaResolvida.nome]
      );
    }

    // Se Asaas confirma pagamento, baixa automaticamente a conta (requer permissão financeira)
    if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(boleto.status) && podeGerenciarFinanceiro(req)) {
      const clientBol = await pool.connect();
      try {
        await clientBol.query('BEGIN');
        const updBol = await clientBol.query(
          `UPDATE contas_receber
           SET status = 'pago', data_pagamento = COALESCE($1::date, (NOW() AT TIME ZONE 'America/Fortaleza')::DATE),
               atualizado_em = NOW()
           WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4)) AND LOWER(COALESCE(status,'pendente')) != 'pago'
           RETURNING id`,
          [boleto.dataPagamento, crId, empresaResolvida.id, empresaResolvida.nome]
        );
        await clientBol.query('COMMIT');
        if (updBol.rowCount > 0) {
          console.log(`[boleto] Baixa automática conta_receber id=${crId} empresa=${empresaResolvida.nome}`);
        }
      } catch (bolErr) {
        await clientBol.query('ROLLBACK').catch(() => {});
        console.error('[boleto] Erro na baixa automática:', bolErr.message);
      } finally {
        clientBol.release();
      }
    }

    res.json({ sucesso: true, boleto: { ...boleto, ...cr } });
  } catch (err) {
    console.error('[boleto] GET status:', err.message);
    jsonErro(res, 500, 'Erro ao consultar boleto');
  }
});

// POST /pagamentos/boleto/webhook — notificações Asaas (PAYMENT_RECEIVED, etc.)
router.post('/pagamentos/boleto/webhook', async (req, res) => {
  try {
    if (!verificarWebhookAsaas(req, res)) return;

    const { event, payment } = req.body || {};

    if (!payment?.externalReference) return res.status(200).json({ ok: true });

    const contaId = Number(payment.externalReference);

    if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event) && contaId > 0) {
      // Busca empresa_id da conta para garantir filtro multiempresa no UPDATE
      const contaCheck = await pool.query(
        `SELECT empresa_id, empresa FROM contas_receber WHERE id = $1 LIMIT 1`,
        [contaId]
      );
      if (contaCheck.rowCount > 0) {
        const { empresa_id: empId, empresa: empNome } = contaCheck.rows[0];
        await pool.query(
          `UPDATE contas_receber
           SET status = 'pago', boleto_status = 'RECEIVED',
               data_pagamento = COALESCE($2::date, (NOW() AT TIME ZONE 'America/Fortaleza')::DATE), atualizado_em = NOW()
           WHERE id = $1 AND boleto_id = $3 AND LOWER(COALESCE(status,'pendente')) != 'pago'
             AND (empresa_id = $4 OR (empresa_id IS NULL AND empresa = $5))`,
          [contaId, payment.paymentDate || null, payment.id || '', empId || 0, empNome || '']
        );
      }
    }

    if (event === 'PAYMENT_OVERDUE' && contaId > 0) {
      const overdueCheck = await pool.query(
        `SELECT empresa_id, empresa FROM contas_receber WHERE id = $1 LIMIT 1`,
        [contaId]
      );
      if (overdueCheck.rowCount > 0) {
        const { empresa_id: empId, empresa: empNome } = overdueCheck.rows[0];
        await pool.query(
          `UPDATE contas_receber SET boleto_status = 'OVERDUE', atualizado_em = NOW()
           WHERE id = $1 AND boleto_id IS NOT NULL
             AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [contaId, empId || 0, empNome || '']
        );
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[boleto] webhook:', err.message);
    res.status(200).json({ ok: true }); // Sempre 200 para Asaas não retentar
  }
});

  return router;
};