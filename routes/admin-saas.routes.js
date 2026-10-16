'use strict';
const express = require('express');
const { requirePermissao }           = require('../utils/permissoes');
const { hoje, addDias }              = require('../utils/normalizadores');
const { encryptField, decryptField } = require('../utils/pixCrypto');
const { getSaasSmtp, criarTransporter, enviarEmailBoasVindas } = require('../utils/email');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function adminSaasRoutes({
  auth, writeRateLimiter, pool,
  apenasAdmin, _planoCache, _configCache,
}) {
  const router = express.Router();
// â”€â”€ Config SMTP SaaS Owner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/admin/smtp/config', auth, apenasAdmin, async (req, res) => {
  try {
    const cfg = await getSaasSmtp(pool);
    res.json({
      sucesso: true,
      smtp_host:  cfg.smtp_host  || '',
      smtp_port:  cfg.smtp_port  || 587,
      smtp_user:  cfg.smtp_user  || '',
      smtp_pass:  cfg.smtp_pass  ? '***' : '',
      smtp_from:  cfg.smtp_from  || '',
      app_url:    cfg.app_url    || ''
    });
  } catch (err) {
    jsonErro(res, 500, 'Erro ao buscar config SMTP');
  }
});

router.put('/admin/smtp/config', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  try {
    const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, app_url } = req.body;
    const smtpPassParam = (smtp_pass && smtp_pass !== '***') ? encryptField(smtp_pass) : null;
    await pool.query(
      `UPDATE saas_config SET
         smtp_host = $1, smtp_port = $2, smtp_user = $3,
         smtp_pass = COALESCE($4, smtp_pass),
         smtp_from = $5, app_url = $6, atualizado_em = NOW()`,
      [smtp_host || null, Number(smtp_port || 587), smtp_user || null,
       smtpPassParam, smtp_from || null, app_url || null]
    );
    res.json({ sucesso: true });
  } catch (err) {
    jsonErro(res, 500, 'Erro ao salvar config SMTP');
  }
});

router.post('/admin/smtp/testar', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  try {
    const cfg = await getSaasSmtp(pool);
    const transporter = criarTransporter(cfg);
    if (!transporter) return jsonErro(res, 400, 'SMTP nÃ£o configurado');

    const toEmail = req.body.email || req.user.email;
    if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(toEmail))) {
      return jsonErro(res, 400, 'Email de destino invÃ¡lido');
    }
    await transporter.sendMail({
      from:    cfg.smtp_from || cfg.smtp_user,
      to:      toEmail,
      subject: 'Teste de SMTP â€” LF ERP',
      text:    'Este Ã© um email de teste do sistema LF ERP. ConfiguraÃ§Ã£o funcionando!'
    });
    res.json({ sucesso: true, mensagem: 'Email de teste enviado com sucesso' });
  } catch (err) {
    jsonErro(res, 500, 'Erro ao enviar teste de e-mail');
  }
});


// â”€â”€ GET /admin/dashboard â€” mÃ©tricas SaaS Owner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/admin/dashboard', auth, apenasAdmin, async (req, res) => {
  try {
    const [empresasResult, receitaResult, ativosResult] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE assinatura_status = 'ativo')   AS ativos,
          COUNT(*) FILTER (WHERE assinatura_status = 'trial')   AS em_trial,
          COUNT(*) FILTER (WHERE bloqueada = true)              AS bloqueados,
          COUNT(*) FILTER (WHERE assinatura_status IN ('inativo','cancelado')) AS inativos,
          COUNT(*) FILTER (WHERE criado_em >= (NOW() AT TIME ZONE 'America/Fortaleza') - INTERVAL '30 days') AS novos_30d,
          COUNT(*) FILTER (WHERE assinatura_status = 'trial' AND trial_fim < CURRENT_DATE) AS trial_expirado
        FROM empresas`),
      pool.query(`
        SELECT COALESCE(SUM(p.preco_mensal), 0) AS mrr
        FROM empresas e
        JOIN planos p ON p.id = e.plano_id
        WHERE e.assinatura_status = 'ativo' AND NOT e.bloqueada`),
      pool.query(`
        SELECT
          COUNT(*) AS total_vendas_30d,
          COALESCE(SUM(total), 0) AS volume_vendas_30d
        FROM vendas
        WHERE criado_em >= (NOW() AT TIME ZONE 'America/Fortaleza') - INTERVAL '30 days'`),
    ]);

    const e = empresasResult.rows[0];
    const mrr = Number(receitaResult.rows[0]?.mrr || 0);
    const v = ativosResult.rows[0];

    // Ãšltimas 6 empresas criadas
    const ultimasResult = await pool.query(
      `SELECT e.nome, e.assinatura_status, e.criado_em, p.nome AS plano_nome
       FROM empresas e
       LEFT JOIN planos p ON p.id = e.plano_id
       ORDER BY e.criado_em DESC LIMIT 6`
    );

    res.json({
      sucesso: true,
      metricas: {
        total_empresas:    Number(e.total),
        ativas:            Number(e.ativos),
        em_trial:          Number(e.em_trial),
        bloqueadas:        Number(e.bloqueados),
        inativos:          Number(e.inativos),
        novos_30d:         Number(e.novos_30d),
        trial_expirado:    Number(e.trial_expirado),
        mrr:               Number(mrr.toFixed(2)),
        total_vendas_30d:  Number(v.total_vendas_30d),
        volume_vendas_30d: Number(v.volume_vendas_30d || 0)
      },
      ultimas_empresas: ultimasResult.rows
    });
  } catch (err) {
    console.error('[admin] dashboard:', err.message);
    jsonErro(res, 500, 'Erro ao carregar dashboard admin');
  }
});


// ================= ADMIN: GESTÃƒO DE EMPRESAS =================

router.get('/admin/empresas', auth, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        e.id, e.nome, e.email, e.telefone, e.cnpj,
        e.assinatura_status, e.bloqueada, e.motivo_bloqueio,
        e.trial_inicio, e.trial_fim, e.criado_em, e.atualizado_em,
        p.nome AS plano_nome, p.codigo AS plano_codigo,
        (SELECT COUNT(*) FROM usuarios u WHERE u.empresa_id = e.id) AS total_usuarios,
        (SELECT COUNT(*) FROM vendas v WHERE v.empresa_id = e.id) AS total_vendas
      FROM empresas e
      LEFT JOIN planos p ON p.id = e.plano_id
      ORDER BY e.criado_em DESC
    `);

    res.json(result.rows.map((r) => ({
      ...r,
      bloqueada: Boolean(r.bloqueada),
      total_usuarios: Number(r.total_usuarios || 0),
      total_vendas: Number(r.total_vendas || 0)
    })));
  } catch (error) {
    console.error('Erro ao listar empresas:', error);
    jsonErro(res, 500, 'Erro ao listar empresas');
  }
});

router.get('/admin/empresas/:id/exportar', auth, apenasAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return jsonErro(res, 400, 'ID invÃ¡lido');

    const empresaResult = await pool.query(`SELECT * FROM empresas WHERE id = $1`, [id]);
    if (empresaResult.rowCount === 0) return jsonErro(res, 404, 'Empresa nÃ£o encontrada');
    const empresa = empresaResult.rows[0];
    const empresaNome = empresa.nome;

    const [
      clientesR, produtosR, fornecedoresR, vendasR, vendaItensR,
      comprasR, compraItensR, crR, cpR, movimR, lancamentosR
    ] = await Promise.all([
      pool.query(`SELECT * FROM clientes WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND deletado_em IS NULL ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT * FROM produtos WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND deletado_em IS NULL ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT * FROM fornecedores WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND deletado_em IS NULL ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT * FROM vendas WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT vi.* FROM venda_itens vi JOIN vendas v ON v.id=vi.venda_id WHERE (v.empresa_id=$1 OR (v.empresa_id IS NULL AND v.empresa=$2)) ORDER BY vi.venda_id,vi.id`, [id, empresaNome]),
      pool.query(`SELECT * FROM compras WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT ci.* FROM compra_itens ci JOIN compras c ON c.id=ci.compra_id WHERE (c.empresa_id=$1 OR (c.empresa_id IS NULL AND c.empresa=$2)) ORDER BY ci.compra_id`, [id, empresaNome]),
      pool.query(`SELECT * FROM contas_receber WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT * FROM contas_pagar WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT * FROM movimentacoes_estoque WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY data_movimentacao`, [id, empresaNome]),
      pool.query(`SELECT * FROM lancamentos_financeiros WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY vencimento`, [id, empresaNome])
    ]);

    const payload = {
      exportacao: {
        empresa:    { id: empresa.id, nome: empresa.nome },
        gerado_em:  new Date().toISOString(),
        gerado_por: 'admin'
      },
      clientes:               clientesR.rows,
      produtos:               produtosR.rows,
      fornecedores:           fornecedoresR.rows,
      vendas:                 vendasR.rows,
      venda_itens:            vendaItensR.rows,
      compras:                comprasR.rows,
      compra_itens:           compraItensR.rows,
      contas_receber:         crR.rows,
      contas_pagar:           cpR.rows,
      movimentacoes_estoque:  movimR.rows,
      lancamentos_financeiros: lancamentosR.rows
    };

    const nomeArquivo = `lferp-backup-${empresa.nome.replace(/\s+/g,'_').replace(/[;"\\]/g,'').replace(/[\r\n]/g,'')}-${hoje()}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error('Erro ao exportar empresa:', error);
    jsonErro(res, 500, 'Erro ao exportar dados da empresa');
  }
});

router.get('/admin/empresas/:id', auth, apenasAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return jsonErro(res, 400, 'ID invÃ¡lido');

    const [empresaResult, usuariosResult, vendasResult, logsResult] = await Promise.all([
      pool.query(
        `SELECT e.*, p.nome AS plano_nome, p.codigo AS plano_codigo
         FROM empresas e LEFT JOIN planos p ON p.id = e.plano_id
         WHERE e.id = $1`, [id]
      ),
      pool.query(`SELECT id, usuario, tipo, nome_completo, criado_em FROM usuarios WHERE empresa_id = $1 ORDER BY criado_em DESC`, [id]),
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(total), 0) AS valor_total
         FROM vendas WHERE empresa_id = $1`, [id]
      ),
      pool.query(
        `SELECT acao, usuario_nome, ip, criado_em FROM logs_auditoria
         WHERE empresa_id = $1 ORDER BY criado_em DESC LIMIT 10`, [id]
      )
    ]);

    if (empresaResult.rowCount === 0) return jsonErro(res, 404, 'Empresa nÃ£o encontrada');

    res.json({
      empresa: { ...empresaResult.rows[0], bloqueada: Boolean(empresaResult.rows[0].bloqueada) },
      usuarios: usuariosResult.rows,
      resumo_vendas: {
        total: Number(vendasResult.rows[0].total || 0),
        valor_total: Number(vendasResult.rows[0].valor_total || 0)
      },
      ultimos_acessos: logsResult.rows
    });
  } catch (error) {
    console.error('Erro ao buscar detalhe da empresa:', error);
    jsonErro(res, 500, 'Erro ao buscar empresa');
  }
});


router.post('/admin/empresas', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  let adminClient;
  try {
    const { nome, plano_id, trial_dias = 30, email, telefone, cnpj } = req.body;

    if (!nome) {
      return jsonErro(res, 400, 'Nome da empresa Ã© obrigatÃ³rio');
    }

    adminClient = await pool.connect();
    await adminClient.query('BEGIN');

    const existe = await adminClient.query(
      `SELECT id FROM empresas WHERE LOWER(nome) = LOWER($1) LIMIT 1 FOR UPDATE`,
      [nome]
    );
    if (existe.rowCount > 0) {
      await adminClient.query('ROLLBACK');
      return jsonErro(res, 400, 'JÃ¡ existe uma empresa com esse nome');
    }

    const trialFim = addDias(hoje(), trial_dias);

    const empresaResult = await adminClient.query(
      `INSERT INTO empresas
        (nome, cnpj, telefone, email, plano_id, assinatura_status, trial_inicio, trial_fim, bloqueada, criado_em, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, 'trial', $6, $7, false, NOW(), NOW())
       RETURNING *`,
      [nome, cnpj || null, telefone || null, email || null, plano_id || null, hoje(), trialFim]
    );

    const empresa = empresaResult.rows[0];

    await adminClient.query(
      `INSERT INTO configuracoes (empresa, empresa_id, nome_empresa, criado_em, atualizado_em)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [empresa.nome, empresa.id, empresa.nome]
    );

    await adminClient.query('COMMIT');

    return res.status(201).json({ sucesso: true, empresa });
  } catch (error) {
    if (adminClient) await adminClient.query('ROLLBACK').catch(() => {});
    console.error('Erro ao criar empresa:', error);
    jsonErro(res, 500, 'Erro ao criar empresa');
  } finally {
    if (adminClient) adminClient.release();
  }
});

router.put('/admin/empresas/:id/status', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { assinatura_status, bloqueada, plano_id, trial_fim, motivo_bloqueio } = req.body;

    if (!id) {
      return jsonErro(res, 400, 'ID de empresa invÃ¡lido');
    }

    const empresaExiste = await pool.query(`SELECT id, nome FROM empresas WHERE id = $1`, [id]);
    if (empresaExiste.rowCount === 0) {
      return jsonErro(res, 404, 'Empresa nÃ£o encontrada');
    }

    const nomeEmpresa = empresaExiste.rows[0].nome;

    await pool.query(
      `UPDATE empresas SET
        assinatura_status = COALESCE($1, assinatura_status),
        bloqueada = COALESCE($2, bloqueada),
        plano_id = COALESCE($3, plano_id),
        trial_fim = COALESCE($4, trial_fim),
        motivo_bloqueio = COALESCE($5, motivo_bloqueio),
        atualizado_em = NOW()
       WHERE id = $6`,
      [
        assinatura_status || null,
        bloqueada !== undefined ? Boolean(bloqueada) : null,
        plano_id || null,
        trial_fim || null,
        motivo_bloqueio || null,
        id
      ]
    );

    _planoCache.delete(`id:${id}`);
    _planoCache.delete(`nome:${nomeEmpresa}`);
    _configCache.delete(nomeEmpresa);

    return res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao atualizar status da empresa:', error);
    jsonErro(res, 500, 'Erro ao atualizar empresa');
  }
});

  return router;
};