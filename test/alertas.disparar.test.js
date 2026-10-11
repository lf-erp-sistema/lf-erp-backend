'use strict';

jest.mock('../utils/ssrfGuard', () => ({
  validarHostExterno: jest.fn().mockResolvedValue(true),
}));

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

const nodemailer = require('nodemailer');
const {
  SMTP_CONNECTION_TIMEOUT_MS, SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS,
} = require('../utils/email');
const alertasRoutes = require('../routes/alertas.routes');

function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    if (paths.includes(path) && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`Rota não encontrada: ${method.toUpperCase()} ${path}`);
}

function mockRes() {
  return {
    statusCode: 200,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
  };
}

function makePool({ clientes, cfg, historicoInserts }) {
  return {
    query: jest.fn((sql, params) => {
      if (sql.includes('FROM alertas_config')) {
        return Promise.resolve({ rows: cfg ? [cfg] : [] });
      }
      if (sql.includes('FROM contas_receber cr')) {
        return Promise.resolve({ rows: clientes });
      }
      if (sql.includes('INSERT INTO alertas_historico')) {
        // status ('enviado'/'erro') é literal no SQL, não parâmetro — guarda os dois.
        historicoInserts.push({ sql, params });
        return Promise.resolve({});
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('POST /alertas/disparar — timeouts SMTP não abortam o lote', () => {
  const noop = (req, res, next) => next();

  test('transporter é criado com os timeouts configurados', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    nodemailer.createTransport.mockReturnValue({ sendMail });

    const historicoInserts = [];
    const pool = makePool({
      clientes: [{ cliente_id: 1, cliente_nome: 'Cliente A', email: 'a@teste.com', telefone: null, valor_total: 100, max_dias: 5 }],
      cfg: { email_ativo: true, whatsapp_ativo: false, smtp_host: 'smtp.exemplo.com', smtp_port: 587, smtp_user: 'user', smtp_pass: 'pass', dias_atraso_minimo: 1 },
      historicoInserts,
    });

    const router = alertasRoutes({ auth: noop, writeRateLimiter: noop, pool, validarAcessoEmpresa: jest.fn().mockResolvedValue({ id: 1, nome: 'Loja' }) });
    const res = mockRes();
    await getHandler(router, 'post', '/disparar')({ body: {}, query: {} }, res);

    expect(res.statusCode).toBe(200);
    const opts = nodemailer.createTransport.mock.calls[0][0];
    expect(opts.connectionTimeout).toBe(SMTP_CONNECTION_TIMEOUT_MS);
    expect(opts.greetingTimeout).toBe(SMTP_GREETING_TIMEOUT_MS);
    expect(opts.socketTimeout).toBe(SMTP_SOCKET_TIMEOUT_MS);
  });

  test('timeout/erro no envio de UM destinatário não interrompe os demais — cada erro vai pro histórico isoladamente', async () => {
    // 1º destinatário: simula timeout de socket (rejeição). 2º: sucesso normal.
    const sendMail = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Socket timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({});
    nodemailer.createTransport.mockReturnValue({ sendMail });

    const historicoInserts = [];
    const pool = makePool({
      clientes: [
        { cliente_id: 1, cliente_nome: 'Cliente Lento', email: 'lento@teste.com', telefone: null, valor_total: 50, max_dias: 10 },
        { cliente_id: 2, cliente_nome: 'Cliente OK', email: 'ok@teste.com', telefone: null, valor_total: 80, max_dias: 3 },
      ],
      cfg: { email_ativo: true, whatsapp_ativo: false, smtp_host: 'smtp.exemplo.com', smtp_port: 587, smtp_user: 'user', smtp_pass: 'pass', dias_atraso_minimo: 1 },
      historicoInserts,
    });

    const router = alertasRoutes({ auth: noop, writeRateLimiter: noop, pool, validarAcessoEmpresa: jest.fn().mockResolvedValue({ id: 1, nome: 'Loja' }) });
    const res = mockRes();
    await getHandler(router, 'post', '/disparar')({ body: {}, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(2); // o lote inteiro rodou, apesar do erro no 1º
    expect(res.jsonBody.enviados_email).toBe(1);
    expect(res.jsonBody.erros_email).toBe(1);

    // Um histórico 'erro' e um 'enviado', ambos registrados (status é literal no SQL)
    expect(historicoInserts.some((h) => h.sql.includes(`'erro'`))).toBe(true);
    expect(historicoInserts.some((h) => h.sql.includes(`'enviado'`))).toBe(true);
  });
});
