'use strict';
const express = require('express');
const { requirePermissao }           = require('../utils/permissoes');
const { hoje }                       = require('../utils/normalizadores');
const { encryptField, decryptField } = require('../utils/pixCrypto');
const { resolverClienteAsaas, criarBoleto: criarBoletoAsaas } = require('../utils/asaas');
const { enviarEmailBoasVindas, getSaasSmtp, criarTransporter } = require('../utils/email');
const { jsonErro } = require('../utils/routeHelpers');
const createPlanoUtils = require('../utils/plano');

module.exports = function adminRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
  apenasAdmin, _configCache, _planoCache,
}) {
  const router = express.Router();
  const { obterPlanoEmpresa } = createPlanoUtils(pool, { hoje });
// ================= CONFIGURAÇÕES =================

// BUSCAR CONFIGURAÇÕES
router.get('/configuracoes/:empresa', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `SELECT * FROM configuracoes WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) LIMIT 1`,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    if (!result.rows.length) {
      const novo = await pool.query(
        `INSERT INTO configuracoes (empresa, empresa_id, nome_empresa) VALUES ($1, $2, $3) RETURNING *`,
        [empresaResolvida.nome, empresaResolvida.id, empresaResolvida.nome]
      );

      return res.json(novo.rows[0]);
    }

    // Mascarar credenciais sensíveis — gerenciadas via endpoints dedicados /pagamentos/*/config
    const row = { ...result.rows[0] };
    if (row.pix_client_id !== undefined)     row.pix_client_id     = row.pix_client_id     ? '****' : null;
    if (row.pix_client_secret !== undefined) row.pix_client_secret = row.pix_client_secret ? '****' : null;
    if (row.pix_certificado !== undefined)   row.pix_certificado   = row.pix_certificado   ? 'configurado' : null;
    if (row.asaas_api_key !== undefined)     row.asaas_api_key     = row.asaas_api_key     ? '****' : null;

    res.json(row);
  } catch (error) {
    console.error('Erro ao buscar configurações:', error);
    jsonErro(res, 500, 'Erro ao buscar configurações');
  }
});

// SALVAR CONFIGURAÇÕES
router.put('/configuracoes', auth, writeRateLimiter, requirePermissao(pool, 'configuracoes', 'editar'), async (req, res) => {
  try {
    const { empresa, nome_empresa, taxa_multa, taxa_juros_dia, logo_url, cor_primaria } = req.body;

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const taxaMultaFinal =
      taxa_multa !== undefined ? (taxa_multa != null ? Number(taxa_multa) : null) : null;
    const taxaJurosDiaFinal =
      taxa_juros_dia !== undefined ? (taxa_juros_dia != null ? Number(taxa_juros_dia) : null) : null;

    if (logo_url) {
      if (!logo_url.startsWith('http://') && !logo_url.startsWith('https://')) {
        return jsonErro(res, 400, 'logo_url deve começar com http:// ou https://');
      }
      try {
        const _pu = new URL(logo_url);
        const _h  = _pu.hostname.toLowerCase();
        if (/^(localhost$|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.0\.0\.0$|::1$)/.test(_h)) {
          return jsonErro(res, 400, 'logo_url não pode apontar para endereços internos');
        }
      } catch {
        return jsonErro(res, 400, 'logo_url inválida');
      }
    }

    const logoFinal = logo_url !== undefined ? (logo_url || null) : undefined;

    // cor_primaria: hex válido ou null para remover; undefined = não alterar
    const corFinal = cor_primaria !== undefined
      ? (/^#[0-9a-fA-F]{6}$/.test(cor_primaria) ? cor_primaria : null)
      : undefined;

    await pool.query(
      `
        UPDATE configuracoes
        SET nome_empresa = $1,
            taxa_multa = COALESCE($3, taxa_multa),
            taxa_juros_dia = COALESCE($4, taxa_juros_dia),
            logo_url = CASE WHEN $6 THEN $5 ELSE logo_url END,
            cor_primaria = CASE WHEN $9 THEN $8 ELSE cor_primaria END,
            atualizado_em = NOW()
        WHERE (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $7))
        `,
      [
        nome_empresa,
        empresaResolvida.id,
        taxaMultaFinal,
        taxaJurosDiaFinal,
        logoFinal,
        logoFinal !== undefined,
        empresaResolvida.nome,
        corFinal,
        corFinal !== undefined
      ]
    );

    _configCache.delete(empresaResolvida.nome);

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao salvar configurações:', error);
    jsonErro(res, 500, 'Erro ao salvar configurações');
  }
});

// ================= ALERTAS =================

router.get('/alertas/:empresa', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, req.params.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const dataHoje = hoje();

    const [estoqueResult, receberResult, pagarResult, planoResult] = await Promise.all([
      pool.query(
        `SELECT id, nome, estoque, estoque_minimo FROM produtos
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
           AND deletado_em IS NULL
           AND estoque_minimo > 0
           AND estoque <= estoque_minimo
         ORDER BY estoque ASC LIMIT 10`,
        [empresaResolvida.id, empresaResolvida.nome]
      ),
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(valor_atualizado), SUM(valor)) AS valor_total
         FROM contas_receber
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
           AND LOWER(COALESCE(status, 'pendente')) IN ('pendente', 'atrasado')
           AND data_vencimento IS NOT NULL AND data_vencimento < $3::text`,
        [empresaResolvida.id, empresaResolvida.nome, dataHoje]
      ),
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(valor), 0) AS valor_total
         FROM contas_pagar
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
           AND LOWER(COALESCE(status, 'pendente')) = 'pendente'
           AND data_vencimento IS NOT NULL AND data_vencimento < $3::text`,
        [empresaResolvida.id, empresaResolvida.nome, dataHoje]
      ),
      obterPlanoEmpresa(empresaResolvida.id, empresaResolvida.nome)
    ]);

    const alertas = [];

    if (estoqueResult.rows.length > 0) {
      alertas.push({
        tipo: 'estoque_baixo',
        nivel: 'warning',
        titulo: `${estoqueResult.rows.length} produto(s) com estoque baixo`,
        itens: estoqueResult.rows.map(p => ({ id: p.id, nome: p.nome, estoque: Number(p.estoque), minimo: Number(p.estoque_minimo) }))
      });
    }

    const totalReceber = Number(receberResult.rows[0].total || 0);
    if (totalReceber > 0) {
      alertas.push({
        tipo: 'contas_receber_vencidas',
        nivel: 'danger',
        titulo: `${totalReceber} conta(s) a receber vencida(s)`,
        valor_total: Number(receberResult.rows[0].valor_total || 0)
      });
    }

    const totalPagar = Number(pagarResult.rows[0].total || 0);
    if (totalPagar > 0) {
      alertas.push({
        tipo: 'contas_pagar_vencidas',
        nivel: 'danger',
        titulo: `${totalPagar} conta(s) a pagar vencida(s)`,
        valor_total: Number(pagarResult.rows[0].valor_total || 0)
      });
    }

    if (planoResult?.assinatura_status === 'trial' && planoResult?.trial_fim) {
      const diasRestantes = Math.ceil(
        (new Date(`${planoResult.trial_fim}T00:00:00`) - new Date(`${dataHoje}T00:00:00`)) / 86400000
      );
      if (diasRestantes <= 7 && diasRestantes >= 0) {
        alertas.push({
          tipo: 'trial_expirando',
          nivel: diasRestantes <= 2 ? 'danger' : 'warning',
          titulo: diasRestantes === 0 ? 'Trial expira hoje' : `Trial expira em ${diasRestantes} dia(s)`,
          dias_restantes: diasRestantes
        });
      }
    }

    res.json({ total: alertas.length, alertas });
  } catch (error) {
    console.error('Erro ao buscar alertas:', error);
    jsonErro(res, 500, 'Erro ao buscar alertas');
  }
});

// ================= BILLING DE ASSINATURAS SAAS =================

// Configuração Asaas do dono do SaaS (não das empresas-clientes)
async function getSaasAsaasConfig() {
  const r = await pool.query(`SELECT asaas_api_key, asaas_sandbox FROM saas_config LIMIT 1`);
  const row = r.rows[0] || {};
  return { apiKey: decryptField(row.asaas_api_key) || null, sandbox: row.asaas_sandbox !== false };
}

// GET /admin/billing/config — retorna config Asaas do SaaS owner
router.get('/admin/billing/config', auth, apenasAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT CASE WHEN asaas_api_key IS NOT NULL THEN '****' ELSE NULL END AS asaas_api_key, asaas_sandbox
       FROM saas_config LIMIT 1`
    );
    res.json({ sucesso: true, ...(r.rows[0] || { asaas_sandbox: true }) });
  } catch (err) {
    console.error('[billing] GET config:', err.message);
    jsonErro(res, 500, 'Erro ao buscar config de billing');
  }
});

// PUT /admin/billing/config
router.put('/admin/billing/config', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  try {
    const { asaas_api_key, asaas_sandbox } = req.body;
    const _saasKeyParaSalvar = (asaas_api_key && asaas_api_key !== '****')
      ? encryptField(asaas_api_key)
      : (asaas_api_key || null);
    await pool.query(
      `UPDATE saas_config
       SET asaas_api_key = COALESCE(NULLIF($1,'****'), asaas_api_key),
           asaas_sandbox = $2, atualizado_em = NOW()`,
      [_saasKeyParaSalvar, asaas_sandbox !== false]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error('[billing] PUT config:', err.message);
    jsonErro(res, 500, 'Erro ao salvar config de billing');
  }
});

// POST /admin/billing/cobrar/:empresaId — gera cobrança de assinatura
router.post('/admin/billing/cobrar/:empresaId', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  try {
    const empresaId = Number(req.params.empresaId);
    const empresaResult = await pool.query(
      `SELECT e.*, p.preco_mensal, p.nome AS plano_nome
       FROM empresas e
       LEFT JOIN planos p ON p.id = e.plano_id
       WHERE e.id = $1`,
      [empresaId]
    );
    if (empresaResult.rowCount === 0) return jsonErro(res, 404, 'Empresa não encontrada');

    const empresa = empresaResult.rows[0];
    const valor = Number(empresa.preco_mensal || req.body.valor || 0);
    if (valor <= 0) return jsonErro(res, 400, 'Plano sem preço configurado');

    const { apiKey, sandbox } = await getSaasAsaasConfig();

    // Cria/busca cliente Asaas para o responsável da empresa
    let customerId = empresa.asaas_customer_id;
    if (!customerId && apiKey) {
      customerId = await resolverClienteAsaas(apiKey, sandbox, {
        nome:     empresa.responsavel_nome || empresa.nome,
        cpfCnpj:  empresa.responsavel_cpf  || empresa.cnpj || null,
        email:    empresa.responsavel_email || empresa.email || null,
        telefone: empresa.telefone || null
      });
      await pool.query(
        `UPDATE empresas SET asaas_customer_id = $1 WHERE id = $2`,
        [customerId, empresaId]
      );
    }

    const vencimento = req.body.vencimento || addDias(hoje(), 5);
    const descricao  = `Assinatura ${empresa.plano_nome || 'LF ERP'} — ${empresa.nome}`;

    const boleto = await criarBoletoAsaas(apiKey, sandbox, {
      customerId,
      valor,
      vencimento,
      descricao,
      externalReference: `assinatura_${empresaId}`
    });

    await pool.query(
      `UPDATE empresas
       SET assinatura_boleto_id  = $1,
           assinatura_boleto_url = $2,
           assinatura_vencimento = $3,
           atualizado_em         = NOW()
       WHERE id = $4`,
      [boleto.id, boleto.invoiceUrl || boleto.bankSlipUrl || null, vencimento, empresaId]
    );

    res.json({
      sucesso: true,
      boleto,
      sandbox: boleto.demo || sandbox || !apiKey,
      mensagem: boleto.demo
        ? 'Cobrança em modo demo (configure API Asaas em Billing → Configuração)'
        : `Boleto gerado para ${empresa.nome} — vencimento ${vencimento}`
    });
  } catch (err) {
    console.error('[billing] cobrar:', err.message);
    jsonErro(res, 500, 'Erro ao gerar cobrança');
  }
});

// GET /admin/billing/status/:empresaId — consulta status da cobrança
router.get('/admin/billing/status/:empresaId', auth, apenasAdmin, async (req, res) => {
  try {
    const empresaId = Number(req.params.empresaId);
    const r = await pool.query(
      `SELECT assinatura_boleto_id, assinatura_boleto_url, assinatura_status, assinatura_vencimento
       FROM empresas WHERE id = $1`,
      [empresaId]
    );
    if (r.rowCount === 0) return jsonErro(res, 404, 'Empresa não encontrada');

    const empresa = r.rows[0];
    if (!empresa.assinatura_boleto_id) {
      return res.json({ sucesso: true, status: 'sem_cobranca', empresa_id: empresaId });
    }

    const { apiKey, sandbox } = await getSaasAsaasConfig();
    const boleto = await consultarBoletoAsaas(apiKey, sandbox, empresa.assinatura_boleto_id);

    // Ativa empresa automaticamente se pagamento confirmado
    if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(boleto.status)) {
      await pool.query(
        `UPDATE empresas
         SET assinatura_status = 'ativo', bloqueada = false,
             trial_fim = NULL, atualizado_em = NOW()
         WHERE id = $1 AND assinatura_status != 'ativo'`,
        [empresaId]
      );
    }

    res.json({ sucesso: true, boleto: { ...boleto, ...empresa } });
  } catch (err) {
    console.error('[billing] status:', err.message);
    jsonErro(res, 500, 'Erro ao consultar cobrança');
  }
});

// POST /admin/billing/webhook-assinatura — Asaas notifica pagamento de assinatura
router.post('/admin/billing/webhook-assinatura', async (req, res) => {
  try {
    if (!verificarWebhookAsaas(req, res)) return;

    const { event, payment } = req.body || {};
    const ref = payment?.externalReference || '';

    if (ref.startsWith('assinatura_') && ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event)) {
      const empresaId = Number(ref.replace('assinatura_', ''));
      if (empresaId > 0) {
        await pool.query(
          `UPDATE empresas
           SET assinatura_status = 'ativo', bloqueada = false,
               trial_fim = NULL, atualizado_em = NOW()
           WHERE id = $1`,
          [empresaId]
        );
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[billing] webhook-assinatura:', err.message);
    res.status(200).json({ ok: true });
  }
});

// ================= ADMIN: LOGS DE AUDITORIA =================

router.get('/admin/logs', auth, apenasAdmin, async (req, res) => {
  try {
    const empresa = req.query.empresa || '';
    const modulo = req.query.modulo || '';
    const acao = req.query.acao || '';
    const { dataInicial, dataFinal } = obterPeriodo(req);

    const params = [];
    let where = 'WHERE 1=1';

    if (empresa) {
      params.push(empresa);
      where += ` AND (empresa = $${params.length} OR empresa_id = (SELECT id FROM empresas WHERE nome = $${params.length} LIMIT 1))`;
    }
    if (modulo) { params.push(modulo); where += ` AND modulo = $${params.length}`; }
    if (acao) { params.push(acao); where += ` AND acao = $${params.length}`; }

    where += adicionarFiltroPeriodo({ campo: 'criado_em', params, dataInicial, dataFinal });

    const result = await pool.query(
      `SELECT * FROM logs_auditoria ${where} ORDER BY criado_em DESC LIMIT 500`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar logs:', error);
    jsonErro(res, 500, 'Erro ao buscar logs de auditoria');
  }
});


// ================= ADMIN: GESTÃO DE PLANOS =================

router.get('/admin/planos', auth, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM planos ORDER BY id`);
    res.json(result.rows);
  } catch (error) {
    jsonErro(res, 500, 'Erro ao listar planos');
  }
});

router.post('/admin/planos', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  try {
    const {
      codigo, nome, preco_mensal,
      limite_usuarios, limite_produtos, limite_clientes,
      limite_fornecedores, limite_vendas_mes,
      permite_relatorios_avancados, permite_suporte_prioritario
    } = req.body;

    if (!codigo || !nome) return jsonErro(res, 400, 'Código e nome são obrigatórios');

    const result = await pool.query(
      `INSERT INTO planos
        (codigo, nome, preco_mensal, limite_usuarios, limite_produtos, limite_clientes,
         limite_fornecedores, limite_vendas_mes, permite_relatorios_avancados, permite_suporte_prioritario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        codigo, nome, Number(preco_mensal || 0),
        Number(limite_usuarios || 0), Number(limite_produtos || 0),
        Number(limite_clientes || 0), Number(limite_fornecedores || 0),
        Number(limite_vendas_mes || 0),
        Boolean(permite_relatorios_avancados), Boolean(permite_suporte_prioritario)
      ]
    );

    res.status(201).json({ sucesso: true, plano: result.rows[0] });
  } catch (error) {
    console.error('Erro ao criar plano:', error);
    jsonErro(res, 500, 'Erro ao criar plano');
  }
});

router.put('/admin/planos/:id', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      nome, preco_mensal,
      limite_usuarios, limite_produtos, limite_clientes,
      limite_fornecedores, limite_vendas_mes,
      permite_relatorios_avancados, permite_suporte_prioritario
    } = req.body;

    if (!id) return jsonErro(res, 400, 'ID inválido');

    await pool.query(
      `UPDATE planos SET
        nome = COALESCE($1, nome),
        preco_mensal = COALESCE($2, preco_mensal),
        limite_usuarios = COALESCE($3, limite_usuarios),
        limite_produtos = COALESCE($4, limite_produtos),
        limite_clientes = COALESCE($5, limite_clientes),
        limite_fornecedores = COALESCE($6, limite_fornecedores),
        limite_vendas_mes = COALESCE($7, limite_vendas_mes),
        permite_relatorios_avancados = COALESCE($8, permite_relatorios_avancados),
        permite_suporte_prioritario = COALESCE($9, permite_suporte_prioritario)
       WHERE id = $10`,
      [
        nome || null, preco_mensal !== undefined ? Number(preco_mensal) : null,
        limite_usuarios !== undefined ? Number(limite_usuarios) : null,
        limite_produtos !== undefined ? Number(limite_produtos) : null,
        limite_clientes !== undefined ? Number(limite_clientes) : null,
        limite_fornecedores !== undefined ? Number(limite_fornecedores) : null,
        limite_vendas_mes !== undefined ? Number(limite_vendas_mes) : null,
        permite_relatorios_avancados !== undefined ? Boolean(permite_relatorios_avancados) : null,
        permite_suporte_prioritario !== undefined ? Boolean(permite_suporte_prioritario) : null,
        id
      ]
    );

    _planoCache.delete(`id:${id}`);

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao atualizar plano:', error);
    jsonErro(res, 500, 'Erro ao atualizar plano');
  }
});

  return router;
};