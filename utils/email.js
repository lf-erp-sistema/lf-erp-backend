/**
 * Email transacional — LF ERP SaaS
 * Usa nodemailer com config SMTP armazenada em saas_config.
 */

const nodemailer = require('nodemailer');

// Timeouts conservadores e configuráveis por ambiente — sem eles, o Nodemailer usa
// defaults bem mais longos (connectionTimeout 2min, greetingTimeout 30s, socketTimeout
// 10min), deixando a requisição HTTP pendente por muito tempo se o SMTP estiver
// inacessível ou lento. Nunca logar usuário/senha/token SMTP, só os timeouts em si.
const SMTP_CONNECTION_TIMEOUT_MS = Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 10000;
const SMTP_GREETING_TIMEOUT_MS   = Number(process.env.SMTP_GREETING_TIMEOUT_MS)   || 10000;
const SMTP_SOCKET_TIMEOUT_MS     = Number(process.env.SMTP_SOCKET_TIMEOUT_MS)     || 20000;

async function getSaasSmtp(pool) {
  const r = await pool.query(
    `SELECT smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, app_url
     FROM saas_config LIMIT 1`
  );
  return r.rows[0] || {};
}

function criarTransporter(cfg) {
  if (!cfg.smtp_host || !cfg.smtp_user || !cfg.smtp_pass) return null;
  return nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   Number(cfg.smtp_port || 587),
    secure: Number(cfg.smtp_port) === 465,
    auth:   { user: cfg.smtp_user, pass: cfg.smtp_pass },
    tls:    { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false' },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout:   SMTP_GREETING_TIMEOUT_MS,
    socketTimeout:     SMTP_SOCKET_TIMEOUT_MS
  });
}

async function enviarEmailBoasVindas(pool, { nomeEmpresa, nomeUsuario, email, usuario, trialFim }) {
  if (!email) return;

  const cfg = await getSaasSmtp(pool);
  const transporter = criarTransporter(cfg);
  if (!transporter) {
    console.warn('[email] SMTP não configurado — email de boas-vindas não enviado');
    return;
  }

  const appUrl = cfg.app_url || 'https://lf-erp-frontend.vercel.app';
  const dtTrial = trialFim
    ? new Date(`${trialFim}T12:00:00`).toLocaleDateString('pt-BR')
    : '14 dias';

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
  .wrapper { max-width: 560px; margin: 32px auto; }
  .card { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  .header { background: #2563eb; padding: 32px 32px 24px; text-align: center; }
  .header h1 { color: #fff; margin: 0 0 6px; font-size: 24px; }
  .header p { color: rgba(255,255,255,.8); margin: 0; font-size: 15px; }
  .body { padding: 28px 32px; }
  .body p { color: #444; line-height: 1.7; margin: 0 0 14px; }
  .highlight { background: #f0f7ff; border-left: 4px solid #2563eb; padding: 14px 18px; border-radius: 6px; margin: 18px 0; }
  .highlight strong { color: #2563eb; display: block; font-size: 13px; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
  .btn { display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 700; font-size: 15px; margin: 8px 0; }
  .steps { counter-reset: step; margin: 18px 0; }
  .step { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
  .step-num { width: 26px; height: 26px; border-radius: 50%; background: #2563eb; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }
  .step-txt { font-size: 14px; color: #555; padding-top: 4px; }
  .footer { text-align: center; padding: 20px 32px; border-top: 1px solid #eee; font-size: 12px; color: #aaa; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="card">
    <div class="header">
      <h1>🚀 Bem-vindo ao LF ERP!</h1>
      <p>Sua conta foi criada com sucesso</p>
    </div>
    <div class="body">
      <p>Olá, <strong>${nomeUsuario || nomeEmpresa}</strong>! Estamos muito felizes em ter você.</p>
      <p>A empresa <strong>${nomeEmpresa}</strong> está configurada e pronta para uso. Seu período de teste começa agora.</p>

      <div class="highlight">
        <strong>Dados de acesso</strong>
        Usuário: <strong>${usuario}</strong><br>
        Trial válido até: <strong>${dtTrial}</strong>
      </div>

      <p style="text-align:center;margin:24px 0">
        <a href="${appUrl}" class="btn">Acessar o sistema</a>
      </p>

      <p><strong>Próximos passos:</strong></p>
      <div class="steps">
        <div class="step"><div class="step-num">1</div><div class="step-txt">Acesse o sistema e configure os dados da sua empresa em <strong>Configurações</strong></div></div>
        <div class="step"><div class="step-num">2</div><div class="step-txt">Cadastre seus primeiros produtos em <strong>Cadastros → Produtos</strong></div></div>
        <div class="step"><div class="step-num">3</div><div class="step-txt">Registre sua primeira venda no <strong>PDV</strong></div></div>
        <div class="step"><div class="step-num">4</div><div class="step-txt">Explore o <strong>Dashboard</strong> para ver os indicadores em tempo real</div></div>
      </div>

      <p>Em caso de dúvidas, responda este e-mail.</p>
    </div>
    <div class="footer">LF ERP — Gestão empresarial profissional &nbsp;|&nbsp; Você está recebendo este email por ter se cadastrado na plataforma.</div>
  </div>
</div>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from:    cfg.smtp_from || cfg.smtp_user,
      to:      email,
      subject: `Bem-vindo ao LF ERP — ${nomeEmpresa} está pronta!`,
      html
    });
    console.log(`[email] boas-vindas enviado para ${email}`);
  } catch (err) {
    console.error(`[email] falha ao enviar boas-vindas para ${email}:`, err.message);
  }
}

module.exports = {
  enviarEmailBoasVindas, getSaasSmtp, criarTransporter,
  SMTP_CONNECTION_TIMEOUT_MS, SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS
};
