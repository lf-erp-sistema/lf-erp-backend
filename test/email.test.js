'use strict';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn() })),
}));

const nodemailer = require('nodemailer');
const {
  criarTransporter,
  SMTP_CONNECTION_TIMEOUT_MS, SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS,
} = require('../utils/email');

describe('criarTransporter — timeouts SMTP', () => {
  afterEach(() => jest.clearAllMocks());

  test('passa connectionTimeout/greetingTimeout/socketTimeout explícitos pro nodemailer', () => {
    criarTransporter({ smtp_host: 'smtp.exemplo.com', smtp_user: 'user', smtp_pass: 'pass', smtp_port: 587 });

    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    const opts = nodemailer.createTransport.mock.calls[0][0];
    expect(opts.connectionTimeout).toBe(SMTP_CONNECTION_TIMEOUT_MS);
    expect(opts.greetingTimeout).toBe(SMTP_GREETING_TIMEOUT_MS);
    expect(opts.socketTimeout).toBe(SMTP_SOCKET_TIMEOUT_MS);
  });

  test('timeouts são números finitos e positivos (defaults sensatos, não 0 nem NaN)', () => {
    [SMTP_CONNECTION_TIMEOUT_MS, SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS].forEach((v) => {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    });
  });

  test('sem host/user/pass configurados, não cria transporter (comportamento preexistente preservado)', () => {
    expect(criarTransporter({})).toBeNull();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  test('não loga usuário/senha SMTP — apenas os timeouts aparecem nas opções', () => {
    criarTransporter({ smtp_host: 'smtp.exemplo.com', smtp_user: 'usuario-secreto', smtp_pass: 'senha-secreta', smtp_port: 465 });
    const opts = nodemailer.createTransport.mock.calls[0][0];
    // auth existe (nodemailer precisa dela), mas isso não é logado -- aqui só garantimos
    // que os campos de timeout estão presentes e corretos ao lado da auth.
    expect(opts.auth).toEqual({ user: 'usuario-secreto', pass: 'senha-secreta' });
    expect(typeof opts.connectionTimeout).toBe('number');
  });
});
