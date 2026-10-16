function erro(res, status = 500, mensagem = 'Erro interno do servidor') {
  const statusValido = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
  return res.status(statusValido).json({ sucesso: false, erro: mensagem });
}

function jsonErro(res, status, mensagem, codigo = null) {
  const body = { sucesso: false, erro: mensagem };
  if (codigo) body.codigo = codigo;
  return res.status(status).json(body);
}

function ok(res, dados = {}, status = 200) {
  return res.status(status).json({ ...dados, sucesso: true });
}

// Extrai status do erro (respeita err.statusCode de obterPeriodo e similares)
function erroFromException(res, err, msgFallback = 'Erro interno do servidor') {
  const status = err?.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  const msg = status < 500 ? err.message : msgFallback;
  return erro(res, status, msg);
}

// Middleware que exige a feature 'assistencia_tecnica' habilitada em
// empresa_features para a empresa do token — fail-closed (sem linha = bloqueado).
// SaaS Owner sempre passa. Compartilhado entre o módulo novo (/assistencia) e
// o legado (/ordens-servico), que opera sobre a mesma tabela ordens_servico.
function createRequireFeatureHabilitada(pool) {
  return async function requireFeatureHabilitada(req, res, next) {
    try {
      if (req.user?.is_saas_owner) return next();
      const empresaId = req.user?.empresa_id;
      if (!empresaId) return erro(res, 403, 'Empresa não identificada');

      const r = await pool.query(
        `SELECT habilitado FROM empresa_features WHERE empresa_id = $1 AND feature = $2`,
        [empresaId, 'assistencia_tecnica']
      );
      if (!r.rows[0]?.habilitado) {
        return erro(res, 403, 'Módulo de Assistência Técnica não habilitado para esta empresa');
      }
      next();
    } catch (e) {
      console.error('[requireFeatureHabilitada]', e);
      return erro(res, 500, 'Erro ao verificar acesso ao módulo');
    }
  };
}

module.exports = { erro, jsonErro, ok, erroFromException, createRequireFeatureHabilitada };
