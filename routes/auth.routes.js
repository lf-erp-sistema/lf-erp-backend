'use strict';

const express  = require('express');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { hoje, addDias } = require('../utils/normalizadores');
const { enviarEmailBoasVindas } = require('../utils/email');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function authRoutes({
  auth,
  writeRateLimiter,
  loginRateLimiter,
  pool,
  validarAcessoEmpresa,
  tokenBlacklist,
  _sseNonces,
  _tokenHash,
  JWT_EXPIRY_MS,
  validarSenhaUsuario,
  validarForcaSenha,
  registrarAuditoria,
  SECRET,
}) {
  const router = express.Router();

  // ── POST /login ────────────────────────────────────────────────────────────
  router.post('/login', loginRateLimiter, async (req, res) => {
    try {
      const { usuario: _rawUsuario, senha } = req.body;
      const usuario = _rawUsuario ? String(_rawUsuario).trim() : _rawUsuario;

      if (!usuario || !senha) {
        return jsonErro(res, 400, 'Informe usuário e senha.');
      }

      const result = await pool.query(
        `SELECT
          u.*,
          u.is_saas_owner,
          e.id AS empresa_id_real,
          e.nome AS empresa_nome_real,
          e.assinatura_status,
          e.bloqueada,
          e.trial_fim,
          p.codigo AS plano_codigo,
          p.nome AS plano_nome
        FROM usuarios u
        LEFT JOIN empresas e ON e.id = u.empresa_id
        LEFT JOIN planos p ON p.id = e.plano_id
        WHERE LOWER(u.usuario) = LOWER($1)`,
        [usuario]
      );

      if (result.rowCount === 0) {
        await bcrypt.compare(senha, '$2b$10$invalidhashusedfortimingequalize0000000000000000000000');
        registrarAuditoria({
          empresa: null, empresa_id: null, usuario_id: null,
          usuario_nome: usuario, modulo: 'acesso', acao: 'login_falha',
          dados_novos: { motivo: 'usuario_nao_encontrado', usuario }, req
        });
        return jsonErro(res, 401, 'Usuário ou senha inválidos.', 'CREDENCIAIS_INVALIDAS');
      }

      const user = result.rows[0];

      if (!user.is_saas_owner) {
        if (user.bloqueada) {
          return jsonErro(res, 403, 'Empresa bloqueada. Entre em contato com o suporte.', 'EMPRESA_BLOQUEADA');
        }
        if (user.assinatura_status === 'inativo' || user.assinatura_status === 'cancelado') {
          return jsonErro(res, 403, 'Assinatura inativa. Regularize o acesso para continuar.', 'ASSINATURA_INATIVA');
        }
        if (user.assinatura_status === 'trial' && user.trial_fim) {
          const _trialFimStr = user.trial_fim instanceof Date
            ? user.trial_fim.toISOString().slice(0, 10)
            : String(user.trial_fim || '').slice(0, 10);
          if (_trialFimStr < hoje()) {
            return jsonErro(res, 403, 'Período de teste expirado. Escolha um plano para continuar.', 'TRIAL_EXPIRADO');
          }
        }
      }

      const senhaOk = await validarSenhaUsuario(senha, user);

      if (!senhaOk) {
        registrarAuditoria({
          empresa: user.empresa_nome_real || user.empresa || null,
          empresa_id: user.empresa_id_real || user.empresa_id || null,
          usuario_id: user.id, usuario_nome: user.usuario,
          modulo: 'acesso', acao: 'login_falha',
          dados_novos: { motivo: 'senha_incorreta' }, req
        });
        return jsonErro(res, 401, 'Usuário ou senha inválidos.', 'CREDENCIAIS_INVALIDAS');
      }

      const nomeCompleto = user.nome_completo || user.usuario;

      const token = jwt.sign(
        {
          id:               user.id,
          usuario:          user.usuario,
          tipo:             user.tipo,
          is_saas_owner:    Boolean(user.is_saas_owner),
          empresa:          user.empresa || null,
          empresa_id:       user.empresa_id_real || user.empresa_id || null,
          empresa_nome:     user.empresa_nome_real || user.empresa || null,
          nome_completo:    nomeCompleto,
          plano_codigo:     user.plano_codigo || null,
          plano_nome:       user.plano_nome || null,
          assinatura_status: user.assinatura_status || null
        },
        SECRET,
        { expiresIn: '12h' }
      );

      registrarAuditoria({
        empresa: user.empresa_nome_real || user.empresa || null,
        empresa_id: user.empresa_id_real || user.empresa_id || null,
        usuario_id: user.id,
        usuario_nome: nomeCompleto,
        modulo: 'acesso',
        acao: 'login',
        req
      });

      res.json({
        token,
        authToken: token,
        empresaId: user.empresa_id_real || user.empresa_id || null,
        empresa: {
          id: user.empresa_id_real || user.empresa_id || null,
          nome: user.empresa_nome_real || user.empresa || null,
          plano: user.plano_codigo || null,
          plano_nome: user.plano_nome || null,
          assinatura_status: user.assinatura_status || null
        },
        user: {
          id: user.id,
          usuario: user.usuario,
          nome: nomeCompleto,
          nome_completo: nomeCompleto,
          perfil: user.tipo,
          tipo: user.tipo,
          empresa: user.empresa_nome_real || user.empresa || null,
          empresa_id: user.empresa_id_real || user.empresa_id || null,
          is_saas_owner: Boolean(user.is_saas_owner)
        }
      });
    } catch (error) {
      console.error('Erro ao fazer login:', error);
      jsonErro(res, 500, 'Erro ao fazer login');
    }
  });

  // ── POST /auth/refresh ─────────────────────────────────────────────────────
  router.post('/auth/refresh', auth, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT u.*, e.id AS empresa_id_real, e.nome AS empresa_nome_real,
                e.assinatura_status, e.bloqueada,
                p.codigo AS plano_codigo, p.nome AS plano_nome
         FROM usuarios u
         LEFT JOIN empresas e ON e.id = u.empresa_id
         LEFT JOIN planos p ON p.id = e.plano_id
         WHERE u.id = $1
         LIMIT 1`,
        [req.user.id]
      );
      if (result.rowCount === 0) return jsonErro(res, 403, 'Usuário inativo ou não encontrado');
      const u = result.rows[0];
      if (!u.is_saas_owner && u.bloqueada) return jsonErro(res, 403, 'Empresa bloqueada');
      if (!u.is_saas_owner && (u.assinatura_status === 'inativo' || u.assinatura_status === 'cancelado')) {
        return jsonErro(res, 403, 'Assinatura inativa. Regularize o acesso para continuar.', 'ASSINATURA_INATIVA');
      }
      const novoToken = jwt.sign(
        {
          id:               u.id,
          usuario:          u.usuario,
          tipo:             u.tipo,
          is_saas_owner:    Boolean(u.is_saas_owner),
          empresa:          u.empresa               || null,
          empresa_id:       u.empresa_id_real        || u.empresa_id || null,
          empresa_nome:     u.empresa_nome_real      || u.empresa    || null,
          nome_completo:    u.nome_completo          || u.usuario,
          plano_codigo:     u.plano_codigo           || null,
          plano_nome:       u.plano_nome             || null,
          assinatura_status: u.assinatura_status     || null
        },
        SECRET,
        { expiresIn: '12h' }
      );
      res.json({ sucesso: true, dados: { token: novoToken, authToken: novoToken } });
    } catch (error) {
      console.error('Erro ao renovar token:', error);
      jsonErro(res, 500, 'Erro ao renovar token');
    }
  });

  // ── GET /auth/sse-token ────────────────────────────────────────────────────
  router.get('/auth/sse-token', auth, writeRateLimiter, (req, res) => {
    const nonce = crypto.randomUUID();
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
    _sseNonces.set(nonce, { token, expiry: Date.now() + 30_000 });
    res.json({ sucesso: true, nonce });
  });

  // ── POST /logout ───────────────────────────────────────────────────────────
  router.post('/logout', auth, (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
    if (token) {
      const hash = _tokenHash(token);
      tokenBlacklist.set(hash, Date.now());
      const expiresAt = new Date(Date.now() + JWT_EXPIRY_MS).toISOString();
      pool.query(
        `INSERT INTO jwt_blacklist (token_hash, revoked_at, expires_at)
         VALUES ($1, NOW(), $2) ON CONFLICT DO NOTHING`,
        [hash, expiresAt]
      ).catch((e) => console.error('[logout] Falha ao invalidar token:', e));
    }

    registrarAuditoria({
      empresa: req.empresa_nome || null,
      empresa_id: req.empresa_id || null,
      usuario_id: req.user.id,
      usuario_nome: req.user.nome_completo || req.user.usuario,
      modulo: 'acesso',
      acao: 'logout',
      req
    });

    res.json({ sucesso: true });
  });

  // ── PUT /me/perfil ─────────────────────────────────────────────────────────
  router.put('/me/perfil', auth, writeRateLimiter, async (req, res) => {
    try {
      const { nome_completo, cpf, nascimento } = req.body;

      if (nome_completo && String(nome_completo).length > 200) {
        return jsonErro(res, 400, 'Nome muito longo (máx 200 caracteres)');
      }
      if (cpf) {
        const cpfLimpo = String(cpf).replace(/\D/g, '');
        if (cpfLimpo.length !== 11) return jsonErro(res, 400, 'CPF inválido');
      }

      await pool.query(
        `UPDATE usuarios SET
          nome_completo = COALESCE($1, nome_completo),
          cpf = COALESCE($2, cpf),
          nascimento = COALESCE($3, nascimento),
          atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
         WHERE id = $4`,
        [nome_completo || null, cpf || null, nascimento || null, req.user.id]
      );

      res.json({ sucesso: true, mensagem: 'Perfil atualizado com sucesso' });
    } catch (error) {
      console.error('Erro ao atualizar perfil:', error);
      jsonErro(res, 500, 'Erro ao atualizar perfil');
    }
  });

  // ── PUT /me/senha ──────────────────────────────────────────────────────────
  router.put('/me/senha', auth, writeRateLimiter, async (req, res) => {
    try {
      const { senha_atual, nova_senha, confirmar_senha } = req.body;

      if (!senha_atual || !nova_senha || !confirmar_senha) {
        return jsonErro(res, 400, 'Informe a senha atual e a nova senha');
      }

      if (nova_senha !== confirmar_senha) {
        return jsonErro(res, 400, 'A nova senha e a confirmação não conferem');
      }

      const forcaSenha = validarForcaSenha(nova_senha);
      if (!forcaSenha.valido) return jsonErro(res, 400, forcaSenha.mensagem);

      const result = await pool.query(`SELECT senha FROM usuarios WHERE id = $1`, [req.user.id]);
      if (result.rowCount === 0) return jsonErro(res, 404, 'Usuário não encontrado');

      const senhaOk = await validarSenhaUsuario(senha_atual, result.rows[0]);
      if (!senhaOk) return jsonErro(res, 401, 'Senha atual incorreta', 'SENHA_INCORRETA');

      const hash = await bcrypt.hash(nova_senha, 10);
      await pool.query(
        `UPDATE usuarios SET senha = $1, atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza' WHERE id = $2`,
        [hash, req.user.id]
      );

      registrarAuditoria({
        empresa: req.empresa_nome || null,
        empresa_id: req.empresa_id || null,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome_completo || req.user.usuario,
        modulo: 'acesso', acao: 'troca_senha', req
      });

      res.json({ sucesso: true, mensagem: 'Senha alterada com sucesso' });
    } catch (error) {
      console.error('Erro ao trocar senha:', error);
      jsonErro(res, 500, 'Erro ao alterar senha');
    }
  });

  // ── GET /me/historico-acesso ───────────────────────────────────────────────
  router.get('/me/historico-acesso', auth, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT acao, ip, user_agent, criado_em
         FROM logs_auditoria
         WHERE usuario_id = $1 AND modulo = 'acesso'
         ORDER BY criado_em DESC
         LIMIT 20`,
        [req.user.id]
      );
      res.json(result.rows);
    } catch (error) {
      console.error('Erro ao buscar histórico:', error);
      jsonErro(res, 500, 'Erro ao buscar histórico de acesso');
    }
  });

  // ── GET /me ────────────────────────────────────────────────────────────────
  router.get('/me', auth, async (req, res) => {
    try {
      const result = await pool.query(
        `
          SELECT
          u.id, u.usuario, u.tipo, u.empresa, u.empresa_id,
          u.nome_completo, u.cpf, u.nascimento, u.is_saas_owner,
          e.nome AS empresa_nome_real,
          e.assinatura_status, e.trial_fim, e.bloqueada,
          p.nome AS plano_nome, p.codigo AS plano_codigo
        FROM usuarios u
        LEFT JOIN empresas e ON e.id = u.empresa_id
        LEFT JOIN planos p ON p.id = e.plano_id
        WHERE u.id = $1
        `,
        [req.user.id]
      );

      if (result.rowCount === 0) {
        return jsonErro(res, 404, 'Usuário não encontrado');
      }

      const user = result.rows[0];
      const nomeCompleto = user.nome_completo || user.usuario;

      let dias_restantes_trial = null;
      if (!user.is_saas_owner && user.trial_fim && user.assinatura_status === 'trial') {
        dias_restantes_trial = Math.ceil(
          (new Date(`${user.trial_fim}T00:00:00`) - new Date(`${hoje()}T00:00:00`)) / 86400000
        );
      }

      res.json({
        id: user.id,
        usuario: user.usuario,
        nome: nomeCompleto,
        nome_completo: nomeCompleto,
        perfil: user.tipo,
        tipo: user.tipo,
        empresa: user.empresa_nome_real || user.empresa || null,
        empresa_id: user.empresa_id || null,
        cpf: user.cpf || '',
        nascimento: user.nascimento || '',
        assinatura_status: user.assinatura_status || null,
        trial_fim: user.trial_fim || null,
        dias_restantes_trial,
        plano_nome: user.plano_nome || null,
        plano_codigo: user.plano_codigo || null,
        bloqueada: Boolean(user.bloqueada),
        is_saas_owner: Boolean(user.is_saas_owner)
      });
    } catch (error) {
      console.error('Erro ao validar sessão:', error);
      jsonErro(res, 500, 'Erro ao validar sessão');
    }
  });

  // ── GET /empresa/status ────────────────────────────────────────────────────
  router.get('/empresa/status', auth, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(
        req,
        req.user.empresa_nome || req.user.empresa
      );

      if (!empresaResolvida) {
        return jsonErro(res, 403, 'Sem acesso');
      }

      const result = await pool.query(
        `
        SELECT
          e.id,
          e.nome,
          e.assinatura_status,
          e.trial_inicio,
          e.trial_fim,
          e.bloqueada,
          e.motivo_bloqueio,
          p.codigo AS plano_codigo,
          p.nome AS plano_nome,
          p.preco_mensal,
          p.limite_usuarios,
          p.limite_produtos,
          p.limite_clientes,
          p.limite_fornecedores,
          p.limite_vendas_mes,
          p.permite_relatorios_avancados,
          p.permite_suporte_prioritario
        FROM empresas e
        LEFT JOIN planos p ON p.id = e.plano_id
        WHERE e.id = $1
        LIMIT 1
        `,
        [empresaResolvida.id]
      );

      if (result.rowCount === 0) {
        return jsonErro(res, 404, 'Empresa não encontrada');
      }

      const empresa = result.rows[0];

      const [usuariosResult, produtosResult, clientesResult, fornecedoresResult, vendasMesResult] =
        await Promise.all([
          pool.query(`SELECT COUNT(*) AS total FROM usuarios WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`, [
            empresaResolvida.id, empresaResolvida.nome
          ]),
          pool.query(`SELECT COUNT(*) AS total FROM produtos WHERE deletado_em IS NULL AND (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`, [
            empresaResolvida.id, empresaResolvida.nome
          ]),
          pool.query(`SELECT COUNT(*) AS total FROM clientes WHERE deletado_em IS NULL AND (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`, [
            empresaResolvida.id, empresaResolvida.nome
          ]),
          pool.query(`SELECT COUNT(*) AS total FROM fornecedores WHERE deletado_em IS NULL AND (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`, [
            empresaResolvida.id, empresaResolvida.nome
          ]),
          pool.query(
            `
          SELECT COUNT(*) AS total
          FROM vendas
          WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
            AND data >= $3
            AND data <= $4
          `,
            [empresaResolvida.id, empresaResolvida.nome, hoje().slice(0, 8) + '01', hoje()]
          )
        ]);

      const trialFim = empresa.trial_fim || null;
      let dias_restantes_trial = null;

      if (trialFim) {
        const hojeData = new Date(`${hoje()}T00:00:00`);
        const fimData = new Date(`${trialFim}T00:00:00`);
        dias_restantes_trial = Math.ceil((fimData - hojeData) / (1000 * 60 * 60 * 24));
      }

      function montarUso(total, limite) {
        const usado = Number(total || 0);
        const maximo = Number(limite || 0);
        const percentual = maximo > 0 ? Math.round((usado / maximo) * 100) : 0;

        return {
          usado,
          limite: maximo,
          percentual,
          alerta: maximo > 0 && percentual >= 80,
          bloqueado: maximo > 0 && usado >= maximo
        };
      }

      res.json({
        empresa: {
          id: empresa.id,
          nome: empresa.nome,
          bloqueada: Boolean(empresa.bloqueada),
          motivo_bloqueio: empresa.motivo_bloqueio || ''
        },
        assinatura: {
          status: empresa.assinatura_status || 'trial',
          trial_inicio: empresa.trial_inicio || null,
          trial_fim: trialFim,
          dias_restantes_trial
        },
        plano: {
          codigo: empresa.plano_codigo || 'sem_plano',
          nome: empresa.plano_nome || 'Sem plano',
          preco_mensal: Number(empresa.preco_mensal || 0),
          permite_relatorios_avancados: Boolean(empresa.permite_relatorios_avancados),
          permite_suporte_prioritario: Boolean(empresa.permite_suporte_prioritario)
        },
        uso: {
          usuarios: montarUso(usuariosResult.rows[0].total, empresa.limite_usuarios),
          produtos: montarUso(produtosResult.rows[0].total, empresa.limite_produtos),
          clientes: montarUso(clientesResult.rows[0].total, empresa.limite_clientes),
          fornecedores: montarUso(fornecedoresResult.rows[0].total, empresa.limite_fornecedores),
          vendas_mes: montarUso(vendasMesResult.rows[0].total, empresa.limite_vendas_mes)
        }
      });
    } catch (error) {
      console.error('Erro ao carregar status da empresa:', error);
      jsonErro(res, 500, 'Erro ao carregar status da empresa');
    }
  });

  // ── POST /registro ─────────────────────────────────────────────────────────
  router.post('/registro', loginRateLimiter, async (req, res) => {
    let client;
    try {
      const { nome_empresa, nome_responsavel, email, telefone, usuario, senha } = req.body;

      if (!nome_empresa || !usuario || !senha) {
        return jsonErro(res, 400, 'nome_empresa, usuario e senha são obrigatórios');
      }
      const forcaSenha = validarForcaSenha(senha);
      if (!forcaSenha.valido) {
        return jsonErro(res, 400, forcaSenha.mensagem);
      }

      client = await pool.connect();
      await client.query('BEGIN');

      const [empresaExiste, usuarioExiste] = await Promise.all([
        client.query(`SELECT id FROM empresas WHERE LOWER(nome) = LOWER($1) LIMIT 1 FOR UPDATE`, [nome_empresa.trim()]),
        client.query(`SELECT id FROM usuarios WHERE LOWER(usuario) = LOWER($1) LIMIT 1 FOR UPDATE`, [usuario.trim()])
      ]);
      if (empresaExiste.rowCount > 0) { await client.query('ROLLBACK'); return jsonErro(res, 409, 'Já existe uma empresa com esse nome'); }
      if (usuarioExiste.rowCount > 0) { await client.query('ROLLBACK'); return jsonErro(res, 409, 'Esse nome de usuário já está em uso'); }

      const planoResult = await client.query(`SELECT id FROM planos WHERE codigo = 'starter' LIMIT 1`);
      const planoId  = planoResult.rows[0]?.id || null;
      const trialFim = addDias(hoje(), 14);

      const empresaResult = await client.query(
        `INSERT INTO empresas
           (nome, email, telefone, plano_id, assinatura_status, trial_inicio, trial_fim, bloqueada, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,'trial',$5,$6,false,NOW(),NOW())
         RETURNING *`,
        [nome_empresa.trim(), email || null, telefone || null, planoId, hoje(), trialFim]
      );
      const empresa = empresaResult.rows[0];

      await client.query(
        `INSERT INTO configuracoes (empresa, empresa_id, nome_empresa, criado_em, atualizado_em)
         VALUES ($1,$2,$3,NOW(),NOW()) ON CONFLICT DO NOTHING`,
        [empresa.nome, empresa.id, empresa.nome]
      );

      const hash = await bcrypt.hash(senha, 10);
      const userResult = await client.query(
        `INSERT INTO usuarios
           (usuario, senha, tipo, empresa, empresa_id, nome_completo, email, criado_em, atualizado_em)
         VALUES ($1,$2,'admin',$3,$4,$5,$6,NOW(),NOW())
         RETURNING id, usuario, tipo, empresa, empresa_id, nome_completo`,
        [usuario.trim(), hash, empresa.nome, empresa.id, nome_responsavel || usuario.trim(), email || null]
      );
      const user = userResult.rows[0];

      await client.query('COMMIT');

      const token = jwt.sign(
        {
          id:              user.id,
          usuario:         user.usuario,
          tipo:            user.tipo,
          is_saas_owner:   false,
          empresa:         empresa.nome,
          empresa_id:      empresa.id,
          nome:            user.nome_completo,
          primeiro_acesso: true
        },
        SECRET,
        { expiresIn: '12h' }
      );

      if (email) {
        enviarEmailBoasVindas(pool, {
          nomeEmpresa: empresa.nome,
          nomeUsuario: user.nome_completo || usuario,
          email,
          usuario,
          trialFim
        }).catch((e) => console.error('[registro] email:', e.message));
      }

      return res.status(201).json({
        sucesso:    true,
        token,
        empresa:    { id: empresa.id, nome: empresa.nome, trial_fim: trialFim },
        user:       { id: user.id, usuario: user.usuario, tipo: user.tipo, nome: user.nome_completo },
        mensagem:   'Bem-vindo ao LF ERP! Seu período de teste de 14 dias começou.'
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[registro]', err.message);
      jsonErro(res, 500, 'Erro ao criar conta');
    } finally {
      if (client) client.release();
    }
  });

  return router;
};
