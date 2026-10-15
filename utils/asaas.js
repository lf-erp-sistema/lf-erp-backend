/**
 * Asaas API — utilitário para boleto bancário
 * Documentação: https://docs.asaas.com/reference
 */

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const ASAAS_PROD    = 'https://api.asaas.com';
const ASAAS_SANDBOX = 'https://sandbox.asaas.com';

const ASAAS_TIMEOUT_MS = Number(process.env.ASAAS_TIMEOUT_MS) || 30000;

function baseUrl(sandbox) {
  return sandbox ? ASAAS_SANDBOX : ASAAS_PROD;
}

// Requisição HTTP genérica para a API Asaas
async function asaasRequest(apiKey, sandbox, method, path, body = null) {
  const base = baseUrl(sandbox);
  const url  = new URL(`/api/v3${path}`, base);

  const options = {
    method,
    headers: {
      'Content-Type':  'application/json',
      'access_token':  apiKey,
      'User-Agent':    'LF-ERP/1.0'
    }
  };

  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = parsed?.errors?.[0]?.description
              || parsed?.message
              || `Asaas HTTP ${res.statusCode}`;
            const err = new Error(msg);
            err.status = res.statusCode;
            err.payload = parsed;
            return reject(err);
          }
          resolve(parsed);
        } catch {
          reject(new Error(`Asaas: resposta inválida (${res.statusCode})`));
        }
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error(`Asaas: timeout após ${ASAAS_TIMEOUT_MS}ms`));
    }, ASAAS_TIMEOUT_MS);

    req.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Asaas: ${e.message}`));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Busca ou cria o cliente Asaas pelo CPF/CNPJ
async function resolverClienteAsaas(apiKey, sandbox, { nome, cpfCnpj, email, telefone }) {
  const cpfLimpo = String(cpfCnpj || '').replace(/\D/g, '');

  if (cpfLimpo.length >= 11) {
    // Busca cliente existente pelo CPF/CNPJ
    const lista = await asaasRequest(apiKey, sandbox, 'GET', `/customers?cpfCnpj=${cpfLimpo}&limit=1`);
    if (lista.data && lista.data.length > 0) {
      return lista.data[0].id;
    }
  }

  // Cria novo cliente
  const cliente = await asaasRequest(apiKey, sandbox, 'POST', '/customers', {
    name:    nome || 'Cliente LF ERP',
    cpfCnpj: cpfLimpo || null,
    email:   email || null,
    phone:   telefone ? String(telefone).replace(/\D/g, '') : null
  });

  return cliente.id;
}

// Cria boleto (ou usa sandbox demo se não houver chave real)
async function criarBoleto(apiKey, sandbox, {
  customerId,
  valor,
  vencimento,
  descricao,
  externalReference
}) {
  if (!apiKey) {
    // Modo demo — sem chave configurada
    return {
      id:             `DEMO_${Date.now()}`,
      invoiceUrl:     null,
      bankSlipUrl:    null,
      status:         'PENDING',
      demo:           true
    };
  }

  const payment = await asaasRequest(apiKey, sandbox, 'POST', '/payments', {
    customer:          customerId,
    billingType:       'BOLETO',
    value:             Number(valor),
    dueDate:           vencimento,          // YYYY-MM-DD
    description:       descricao || 'Cobrança LF ERP',
    externalReference: String(externalReference),
    fine:              { value: 2 },        // 2% multa
    interest:          { value: 1 }         // 1% juros ao mês
  });

  // Busca linha digitável (pode demorar alguns segundos para ficar disponível)
  let linhaDigitavel = null;
  try {
    const idField = await asaasRequest(apiKey, sandbox, 'GET', `/payments/${payment.id}/identificationField`);
    linhaDigitavel = idField.identificationField || null;
  } catch {
    // Linha digitável pode não estar pronta imediatamente
  }

  return {
    id:              payment.id,
    invoiceUrl:      payment.invoiceUrl    || null,
    bankSlipUrl:     payment.bankSlipUrl   || null,
    linhaDigitavel,
    status:          payment.status        || 'PENDING',
    demo:            false
  };
}

// Consulta status de um boleto existente
async function consultarBoleto(apiKey, sandbox, boletoId) {
  if (!apiKey || boletoId.startsWith('DEMO_')) {
    return { id: boletoId, status: 'PENDING', demo: true };
  }

  const payment = await asaasRequest(apiKey, sandbox, 'GET', `/payments/${boletoId}`);

  let linhaDigitavel = null;
  if (payment.status === 'PENDING' || payment.status === 'OVERDUE') {
    try {
      const idField = await asaasRequest(apiKey, sandbox, 'GET', `/payments/${boletoId}/identificationField`);
      linhaDigitavel = idField.identificationField || null;
    } catch { /* ok */ }
  }

  return {
    id:             payment.id,
    status:         payment.status,
    invoiceUrl:     payment.invoiceUrl  || null,
    bankSlipUrl:    payment.bankSlipUrl || null,
    linhaDigitavel,
    dataPagamento:  payment.paymentDate || null,
    valorPago:      payment.value       || null
  };
}

// Verifica o header asaas-access-token em qualquer webhook Asaas do sistema
// (boleto de Contas a Receber e assinatura SaaS compartilham a mesma conta/token).
// Se ASAAS_WEBHOOK_TOKEN não estiver configurado, REJEITA a requisição (fail-closed).
// Sem essa validação, qualquer requisição forjada poderia marcar cobranças como pagas.
function verificarWebhookAsaas(req, res) {
  const token = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!token) {
    console.error('[webhook-asaas] ASAAS_WEBHOOK_TOKEN nao configurado — requisicao rejeitada por seguranca');
    res.status(503).json({ erro: 'Webhook nao configurado' });
    return false;
  }
  const headerToken = req.headers['asaas-access-token'] || '';
  const bufA = Buffer.from(token);
  const bufB = Buffer.from(headerToken);
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    console.warn('[webhook-asaas] Token invalido — requisicao rejeitada IP:', req.ip);
    res.status(401).json({ erro: 'Unauthorized' });
    return false;
  }
  return true;
}

module.exports = { resolverClienteAsaas, criarBoleto, consultarBoleto, verificarWebhookAsaas };
