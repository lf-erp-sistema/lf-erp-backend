'use strict';
const { _tokenHash } = require('./auth');

// Uma consulta compartilhada entre instâncias: existência, perfil atual,
// versão de senha e revogação. Erro de infraestrutura nunca concede acesso.
function createValidatedAuth({ authJwt, pool, obterPlanoEmpresa, hoje }) {
  async function validar(req) {
    const result = await pool.query(
      `SELECT u.id, u.tipo, u.is_saas_owner, u.empresa_id, u.empresa, u.senha_alterada_em,
              EXISTS (SELECT 1 FROM jwt_blacklist b WHERE b.token_hash = $2 AND b.expires_at > NOW()) AS revogado
       FROM usuarios u WHERE u.id = $1`,
      [req.user.id, _tokenHash(req.authToken)]
    );
    const atual = result.rows[0];
    if (!atual || atual.revogado) return 'Sessão revogada. Faça login novamente.';
    if (atual.tipo !== req.user.tipo || Boolean(atual.is_saas_owner) !== Boolean(req.user.is_saas_owner)) {
      return 'Seu acesso foi alterado. Faça login novamente.';
    }
    if (!atual.is_saas_owner && (atual.empresa_id != null
      ? Number(atual.empresa_id) !== req.empresa_id
      : atual.empresa !== req.empresa_nome)) return 'Empresa da sessão alterada. Faça login novamente.';
    const versao = atual.senha_alterada_em ? new Date(atual.senha_alterada_em).getTime() : 0;
    if (versao > Number(req.user.senha_v || 0)) return 'A senha foi alterada. Faça login novamente.';
    if (atual.is_saas_owner) return null;
    const plano = await obterPlanoEmpresa(req.empresa_id, req.empresa_nome);
    if (!plano) throw new Error('Plano da empresa indisponível');
    if (plano.bloqueada) return 'Empresa bloqueada. Entre em contato com o suporte.';
    if (['inativo', 'cancelado'].includes(plano.assinatura_status)) return 'Assinatura inativa. Regularize o acesso.';
    if (plano.assinatura_status === 'trial' && plano.trial_fim && String(plano.trial_fim).slice(0, 10) < hoje()) {
      return 'Período de teste expirado. Escolha um plano para continuar.';
    }
    return null;
  }
  function auth(req, res, next) {
    return authJwt(req, res, async () => {
      try {
        const erro = await validar(req);
        if (erro) return res.status(403).json({ sucesso: false, erro, codigo: 'SESSAO_REVOGADA' });
        return next();
      } catch (error) {
        console.error('[auth] revalidação indisponível:', error.message);
        return res.status(503).json({ sucesso: false, erro: 'Não foi possível validar a sessão. Tente novamente.' });
      }
    });
  }
  // Usado por conexões duradouras, já autenticadas, sem reutilizar nonce SSE.
  auth.validarSessao = validar;
  return auth;
}
module.exports = { createValidatedAuth };
