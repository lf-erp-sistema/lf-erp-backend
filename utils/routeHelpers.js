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

module.exports = { erro, jsonErro, ok, erroFromException };
