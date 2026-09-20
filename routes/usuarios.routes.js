'use strict';

const express = require('express');
const bcrypt  = require('bcrypt');
const { jsonErro } = require('../utils/routeHelpers');
const { obterPermissoes } = require('../utils/permissoes');

module.exports = function usuariosRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  validarLimitePlano,
  validarForcaSenha,
  requirePermissao,
  registrarAuditoria,
}) {
  const router = express.Router();

  // Verifica se o usuário autenticado pode gerenciar outros usuários
  function podeGerenciarUsuarios(req) {
    return req.user.tipo === 'admin' || req.user.tipo === 'gerente';
  }

  // ── GET /usuarios/:empresa ─────────────────────────────────────────────────
  router.get('/usuarios/:empresa', auth, requirePermissao(pool, 'usuarios', 'ver'), async (req, res) => {
    try {
      const empresa = req.params.empresa;

      if (!podeGerenciarUsuarios(req)) {
        return jsonErro(res, 403, 'Sem permissão para acessar usuários');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return jsonErro(res, 403, 'Sem acesso');
      }

      const result = await pool.query(
        `
          SELECT
            id,
            COALESCE(nome_completo, usuario) AS nome,
            usuario,
            tipo,
            empresa,
            criado_em,
            atualizado_em
          FROM usuarios
          WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
          ORDER BY id DESC
          `,
        [empresaResolvida.id, empresaResolvida.nome]
      );

      res.json(result.rows);
    } catch (error) {
      console.error('Erro ao listar usuários:', error);
      jsonErro(res, 500, 'Erro ao listar usuários');
    }
  });

  // ── POST /usuarios ─────────────────────────────────────────────────────────
  router.post('/usuarios', auth, writeRateLimiter, requirePermissao(pool, 'usuarios', 'criar'), async (req, res) => {
    try {
      const { empresa, nome, usuario, senha, tipo } = req.body;

      if (!podeGerenciarUsuarios(req)) {
        return jsonErro(res, 403, 'Sem permissão para cadastrar usuários');
      }

      if (!nome || !usuario || !senha || !tipo) {
        return jsonErro(res, 400, 'Dados obrigatórios');
      }

      const TIPOS_USUARIO_VALIDOS = ['admin', 'gerente', 'funcionario'];
      if (!TIPOS_USUARIO_VALIDOS.includes(tipo)) {
        return jsonErro(res, 400, 'Tipo de usuário inválido');
      }

      const forcaSenha = validarForcaSenha(senha.trim());
      if (!forcaSenha.valido) return jsonErro(res, 400, forcaSenha.mensagem);

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return jsonErro(res, 403, 'Sem acesso');
      }

      const limitePlano = await validarLimitePlano({
        empresaResolvida,
        recurso: 'usuarios'
      });

      if (!limitePlano.permitido) {
        return jsonErro(res, 403, limitePlano.mensagem);
      }

      const senhaHash = await bcrypt.hash(senha.trim(), 10);

      const clienteTx = await pool.connect();
      let novoUsuario;
      try {
        await clienteTx.query('BEGIN');

        const result = await clienteTx.query(
          `
          INSERT INTO usuarios
          (empresa, empresa_id, nome_completo, usuario, senha, tipo, criado_em, atualizado_em)
          VALUES ($1, $2, $3, $4, $5, $6, NOW() AT TIME ZONE 'America/Fortaleza', NOW() AT TIME ZONE 'America/Fortaleza')
          ON CONFLICT (usuario) DO NOTHING
          RETURNING id
          `,
          [empresaResolvida.nome, empresaResolvida.id, nome.trim(), usuario.trim(), senhaHash, tipo]
        );

        if (result.rowCount === 0) {
          await clienteTx.query('ROLLBACK');
          return jsonErro(res, 400, 'Usuário já existe');
        }

        novoUsuario = result.rows[0];

        await clienteTx.query('COMMIT');
      } catch (txErr) {
        await clienteTx.query('ROLLBACK');
        throw txErr;
      } finally {
        clienteTx.release();
      }

      res.json(novoUsuario);
    } catch (error) {
      console.error('Erro ao criar usuário:', error);
      jsonErro(res, 500, 'Erro ao criar usuário');
    }
  });

  // ── PUT /usuarios/:id ──────────────────────────────────────────────────────
  router.put('/usuarios/:id', auth, writeRateLimiter, requirePermissao(pool, 'usuarios', 'editar'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { empresa, nome, usuario, senha, tipo } = req.body;

      if (!podeGerenciarUsuarios(req)) {
        return jsonErro(res, 403, 'Sem permissão para editar usuários');
      }

      if (!nome || !usuario || !tipo) {
        return jsonErro(res, 400, 'Dados obrigatórios');
      }

      const TIPOS_USUARIO_VALIDOS = ['admin', 'gerente', 'funcionario'];
      if (!TIPOS_USUARIO_VALIDOS.includes(tipo)) {
        return jsonErro(res, 400, 'Tipo de usuário inválido');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return jsonErro(res, 403, 'Sem acesso');
      }

      const atualResult = await pool.query(
        `SELECT * FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      if (atualResult.rowCount === 0) {
        return jsonErro(res, 404, 'Usuário não encontrado');
      }

      const usuarioDuplicado = await pool.query(
        `SELECT id FROM usuarios WHERE usuario = $1 AND id <> $2`,
        [usuario.trim(), id]
      );

      if (usuarioDuplicado.rowCount > 0) {
        return jsonErro(res, 400, 'Já existe outro usuário com esse login');
      }

      if (senha && senha.trim()) {
        const forcaSenha = validarForcaSenha(senha.trim());
        if (!forcaSenha.valido) return jsonErro(res, 400, forcaSenha.mensagem);

        const senhaHash = await bcrypt.hash(senha.trim(), 10);

        await pool.query(
          `
            UPDATE usuarios
            SET nome_completo = $1,
                usuario = $2,
                senha = $3,
                tipo = $4,
                atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
            WHERE id = $5 AND (empresa_id = $6 OR (empresa_id IS NULL AND empresa = $7))
            `,
          [nome.trim(), usuario.trim(), senhaHash, tipo, id, empresaResolvida.id, empresaResolvida.nome]
        );
      } else {
        await pool.query(
          `
            UPDATE usuarios
            SET nome_completo = $1,
                usuario = $2,
                tipo = $3,
                atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
            WHERE id = $4 AND (empresa_id = $5 OR (empresa_id IS NULL AND empresa = $6))
            `,
          [nome.trim(), usuario.trim(), tipo, id, empresaResolvida.id, empresaResolvida.nome]
        );
      }

      res.json({ sucesso: true });
    } catch (error) {
      console.error('Erro ao atualizar usuário:', error);
      jsonErro(res, 500, 'Erro ao atualizar usuário');
    }
  });

  // ── DELETE /usuarios/:id ───────────────────────────────────────────────────
  router.delete('/usuarios/:id', auth, writeRateLimiter, requirePermissao(pool, 'usuarios', 'deletar'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresa = req.query.empresa || null;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!podeGerenciarUsuarios(req)) {
        return jsonErro(res, 403, 'Sem permissão para excluir usuários');
      }

      if (!empresaResolvida) {
        return jsonErro(res, 403, 'Sem acesso');
      }

      if (req.user.id === id) {
        return jsonErro(res, 400, 'Você não pode excluir o próprio usuário');
      }

      const existe = await pool.query(
        `SELECT id FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      if (existe.rowCount === 0) {
        return jsonErro(res, 404, 'Usuário não encontrado');
      }

      await pool.query(
        `DELETE FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      res.json({ sucesso: true });
    } catch (error) {
      console.error('Erro ao excluir usuário:', error);
      jsonErro(res, 500, 'Erro ao excluir usuário');
    }
  });

  // ── GET /usuarios/:id/permissoes ───────────────────────────────────────────
  router.get('/usuarios/:id/permissoes', auth, requirePermissao(pool, 'usuarios', 'ver'), async (req, res) => {
    try {
      if (!podeGerenciarUsuarios(req)) return jsonErro(res, 403, 'Sem permissão');

      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, null);
      if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

      const usuarioResult = await pool.query(
        `SELECT tipo FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (usuarioResult.rowCount === 0) return jsonErro(res, 404, 'Usuário não encontrado');

      const tipo = usuarioResult.rows[0].tipo;

      const [individuaisResult, padraoResult] = await Promise.all([
        pool.query(
          `SELECT modulo, pode_ver, pode_criar, pode_editar, pode_deletar
           FROM permissoes_usuario WHERE usuario_id = $1 AND empresa_id = $2`,
          [id, empresaResolvida.id]
        ),
        pool.query(
          `SELECT modulo, pode_ver, pode_criar, pode_editar, pode_deletar
           FROM permissoes_padrao WHERE tipo_usuario = $1`,
          [tipo]
        )
      ]);

      const mapPadrao     = Object.fromEntries(padraoResult.rows.map((r) => [r.modulo, r]));
      const mapIndividual = Object.fromEntries(individuaisResult.rows.map((r) => [r.modulo, r]));

      const MODULOS = ['produtos','clientes','fornecedores','compras','vendas','estoque',
                       'financeiro','relatorios','dre','lucratividade','usuarios','configuracoes'];
      const permissoes = {};
      for (const m of MODULOS) {
        const ind = mapIndividual[m];
        const pad = mapPadrao[m] || { pode_ver: false, pode_criar: false, pode_editar: false, pode_deletar: false };
        permissoes[m] = {
          pode_ver:     ind?.pode_ver     ?? pad.pode_ver,
          pode_criar:   ind?.pode_criar   ?? pad.pode_criar,
          pode_editar:  ind?.pode_editar  ?? pad.pode_editar,
          pode_deletar: ind?.pode_deletar ?? pad.pode_deletar,
          override: !!ind
        };
      }

      res.json({ sucesso: true, permissoes, tipo });
    } catch (err) {
      console.error('[permissoes GET]', err.message);
      jsonErro(res, 500, 'Erro ao carregar permissões');
    }
  });

  // ── PUT /usuarios/:id/permissoes ───────────────────────────────────────────
  router.put('/usuarios/:id/permissoes', auth, writeRateLimiter, requirePermissao(pool, 'usuarios', 'editar'), async (req, res) => {
    try {
      if (!podeGerenciarUsuarios(req)) return jsonErro(res, 403, 'Sem permissão');

      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, null);
      if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

      const usuarioResult = await pool.query(
        `SELECT id FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (usuarioResult.rowCount === 0) return jsonErro(res, 404, 'Usuário não encontrado');

      const { permissoes } = req.body;
      if (!permissoes || typeof permissoes !== 'object') return jsonErro(res, 400, 'Dados inválidos');

      const MODULOS = ['produtos','clientes','fornecedores','compras','vendas','estoque',
                       'financeiro','relatorios','dre','lucratividade','usuarios','configuracoes'];

      for (const modulo of MODULOS) {
        if (!permissoes[modulo]) continue;
        const p = permissoes[modulo];
        if (p.usar_padrao) {
          await pool.query(
            `DELETE FROM permissoes_usuario WHERE usuario_id = $1 AND empresa_id = $2 AND modulo = $3`,
            [id, empresaResolvida.id, modulo]
          );
        } else {
          await pool.query(
            `INSERT INTO permissoes_usuario (usuario_id, empresa_id, modulo, pode_ver, pode_criar, pode_editar, pode_deletar)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (usuario_id, empresa_id, modulo)
             DO UPDATE SET pode_ver=$4, pode_criar=$5, pode_editar=$6, pode_deletar=$7`,
            [id, empresaResolvida.id, modulo,
             !!p.pode_ver, !!p.pode_criar, !!p.pode_editar, !!p.pode_deletar]
          );
        }
      }

      res.json({ sucesso: true });
    } catch (err) {
      console.error('[permissoes PUT]', err.message);
      jsonErro(res, 500, 'Erro ao salvar permissões');
    }
  });

  // ── Lixeira (soft delete recovery) ────────────────────────────────────────

  const TABELAS_LIXEIRA = new Set(['produtos', 'clientes', 'fornecedores']);

  // GET /lixeira
  router.get('/lixeira', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
    try {
      if (!podeGerenciarUsuarios(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');

      const empresaResolvida = await validarAcessoEmpresa(req, null, null);
      if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

      const eId   = empresaResolvida.id;
      const eNome = empresaResolvida.nome;

      const [produtosR, clientesR, fornecedoresR] = await Promise.all([
        pool.query(
          `SELECT id, nome, categoria, deletado_em FROM produtos
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND deletado_em IS NOT NULL
           ORDER BY deletado_em DESC LIMIT 200`,
          [eId, eNome]
        ),
        pool.query(
          `SELECT id, nome, telefone, email, deletado_em FROM clientes
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND deletado_em IS NOT NULL
           ORDER BY deletado_em DESC LIMIT 200`,
          [eId, eNome]
        ),
        pool.query(
          `SELECT id, nome, telefone, email, deletado_em FROM fornecedores
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND deletado_em IS NOT NULL
           ORDER BY deletado_em DESC LIMIT 200`,
          [eId, eNome]
        )
      ]);

      res.json({
        sucesso: true,
        produtos:     produtosR.rows,
        clientes:     clientesR.rows,
        fornecedores: fornecedoresR.rows,
        total: produtosR.rowCount + clientesR.rowCount + fornecedoresR.rowCount
      });
    } catch (err) {
      console.error('[lixeira GET]', err.message);
      jsonErro(res, 500, 'Erro ao carregar lixeira');
    }
  });

  // PUT /lixeira/recuperar/:tabela/:id
  router.put('/lixeira/recuperar/:tabela/:id', auth, writeRateLimiter, requirePermissao(pool, 'configuracoes', 'editar'), async (req, res) => {
    try {
      if (!podeGerenciarUsuarios(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');

      const { tabela, id } = req.params;
      if (!TABELAS_LIXEIRA.has(tabela)) return jsonErro(res, 400, 'Tabela inválida');

      const empresaResolvida = await validarAcessoEmpresa(req, null, null);
      if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

      const eId   = empresaResolvida.id;
      const eNome = empresaResolvida.nome;

      const result = await pool.query(
        `UPDATE ${tabela}
         SET deletado_em = NULL, atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
         WHERE id = $1
           AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
           AND deletado_em IS NOT NULL
         RETURNING id, nome`,
        [Number(id), eId, eNome]
      );

      if (result.rowCount === 0) return jsonErro(res, 404, 'Registro não encontrado na lixeira');

      registrarAuditoria({
        empresa: eNome, empresa_id: eId,
        usuario_id: req.user.id, usuario_nome: req.user.nome || '',
        modulo: tabela, acao: 'recuperar',
        referencia_id: Number(id), req
      });

      res.json({ sucesso: true, registro: result.rows[0] });
    } catch (err) {
      console.error('[lixeira recuperar]', err.message);
      jsonErro(res, 500, 'Erro ao recuperar registro');
    }
  });

  // DELETE /lixeira/excluir/:tabela/:id
  router.delete('/lixeira/excluir/:tabela/:id', auth, writeRateLimiter, requirePermissao(pool, 'configuracoes', 'deletar'), async (req, res) => {
    try {
      if (req.user.tipo !== 'admin' && !req.user.is_saas_owner) {
        return jsonErro(res, 403, 'Exclusão permanente restrita a administradores');
      }

      const { tabela, id } = req.params;
      if (!TABELAS_LIXEIRA.has(tabela)) return jsonErro(res, 400, 'Tabela inválida');

      const empresaResolvida = await validarAcessoEmpresa(req, null, null);
      if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

      const eId   = empresaResolvida.id;
      const eNome = empresaResolvida.nome;

      const result = await pool.query(
        `DELETE FROM ${tabela}
         WHERE id = $1
           AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
           AND deletado_em IS NOT NULL
         RETURNING id`,
        [Number(id), eId, eNome]
      );

      if (result.rowCount === 0) return jsonErro(res, 404, 'Registro não encontrado na lixeira');

      registrarAuditoria({
        empresa: eNome, empresa_id: eId,
        usuario_id: req.user.id, usuario_nome: req.user.nome || '',
        modulo: tabela, acao: 'exclusao_permanente',
        referencia_id: Number(id), req
      });

      res.json({ sucesso: true });
    } catch (err) {
      console.error('[lixeira excluir]', err.message);
      jsonErro(res, 500, 'Erro ao excluir registro permanentemente');
    }
  });

  // ── GET /permissoes/minhas ─────────────────────────────────────────────────
  router.get('/permissoes/minhas', auth, async (req, res) => {
    try {
      const tipo = req.user?.tipo;
      if (tipo === 'admin' || req.user?.is_saas_owner) {
        return res.json({ sucesso: true, isAdmin: true, permissoes: null, tipo });
      }
      const permissoes = await obterPermissoes(pool, req.user.id, req.user.empresa_id, tipo);
      res.json({ sucesso: true, isAdmin: false, permissoes, tipo });
    } catch (err) {
      console.error('[permissoes/minhas]', err.message);
      jsonErro(res, 500, 'Erro ao carregar permissões');
    }
  });

  return router;
};
