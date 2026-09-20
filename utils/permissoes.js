/**
 * Middleware de permissões granulares — LF ERP
 *
 * Uso: router.get('/rota', auth, requirePermissao('financeiro', 'ver'), handler)
 *
 * Fluxo de resolução:
 * 1. admin → acesso total, passa direto
 * 2. Verifica permissoes_usuario (override individual)
 * 3. Fallback para permissoes_padrao (por tipo: gerente, funcionario)
 * 4. Se não encontrar nada → nega acesso
 */

const ACOES_VALIDAS = new Set([
  'ver', 'criar', 'editar', 'deletar', 'excluir',
  // ações de domínio específico
  'configurar', 'emitir', 'cancelar',
  'acumular', 'resgatar', 'ajustar'
]);

const MODULOS_VALIDOS = new Set([
  'produtos', 'clientes', 'fornecedores', 'compras',
  'vendas', 'estoque', 'financeiro', 'relatorios',
  'dre', 'lucratividade',
  'usuarios', 'configuracoes',
  'caixa', 'comissoes',
  'fidelidade', 'marketplace', 'nfe', 'nfse', 'filiais',
  'dashboard',
  'rastreabilidade', 'whatsapp', 'orcamentos', 'pedidos',
  'bi', 'alertas', 'crm', 'checkout', 'portal',
  'nfce', 'devolucoes', 'exportacao', 'imagens',
  'grades', 'kits', 'tabelasPreco', 'comissoes',
  'ordens_servico'
]);

// requirePermissao recebe pool explicitamente — o pool não é acessível via req.app.locals neste projeto
function requirePermissao(pool, modulo, acao) {
  if (!MODULOS_VALIDOS.has(modulo)) throw new Error(`Módulo inválido: ${modulo}`);
  if (!ACOES_VALIDAS.has(acao))   throw new Error(`Ação inválida: ${acao}`);

  const coluna = `pode_${acao}`;

  return async (req, res, next) => {
    if (req.user?.tipo === 'admin' || req.user?.is_saas_owner) return next();

    const usuarioId = req.user?.id;
    const empresaId = req.user?.empresa_id || null;

    try {
      // 1. Override individual
      const individual = await pool.query(
        `SELECT ${coluna}
         FROM permissoes_usuario
         WHERE usuario_id = $1
           AND empresa_id IS NOT DISTINCT FROM $2
           AND modulo = $3
         LIMIT 1`,
        [usuarioId, empresaId, modulo]
      );

      if (individual.rowCount > 0) {
        if (individual.rows[0][coluna]) return next();
        return res.status(403).json({ sucesso: false, erro: 'Sem permissão' });
      }

      // 2. Fallback: permissão padrão do tipo
      const padrao = await pool.query(
        `SELECT ${coluna}
         FROM permissoes_padrao
         WHERE tipo_usuario = $1 AND modulo = $2`,
        [req.user.tipo, modulo]
      );

      if (padrao.rowCount > 0 && padrao.rows[0][coluna]) return next();

      return res.status(403).json({ sucesso: false, erro: 'Sem permissão' });
    } catch (err) {
      console.error('[permissoes]', err.message);
      return res.status(500).json({ sucesso: false, erro: 'Erro ao verificar permissão' });
    }
  };
}

/**
 * Retorna o objeto de permissões do usuário para um módulo.
 * Útil para retornar ao frontend o que o usuário pode fazer.
 */
async function obterPermissoes(pool, usuarioId, empresaId, tipo) {
  if (tipo === 'admin') {
    return { pode_ver: true, pode_criar: true, pode_editar: true, pode_deletar: true };
  }

  const modulos = [...MODULOS_VALIDOS];
  const resultado = {};

  try {
    const [individuais, padroes] = await Promise.all([
      pool.query(
        `SELECT modulo, pode_ver, pode_criar, pode_editar, pode_deletar
         FROM permissoes_usuario
         WHERE usuario_id = $1 AND (empresa_id = $2 OR empresa_id IS NULL)`,
        [usuarioId, empresaId]
      ),
      pool.query(
        `SELECT modulo, pode_ver, pode_criar, pode_editar, pode_deletar
         FROM permissoes_padrao
         WHERE tipo_usuario = $1`,
        [tipo]
      )
    ]);

    const mapPadrao = Object.fromEntries(padroes.rows.map((r) => [r.modulo, r]));
    const mapIndividual = Object.fromEntries(individuais.rows.map((r) => [r.modulo, r]));

    for (const modulo of modulos) {
      resultado[modulo] = mapIndividual[modulo] || mapPadrao[modulo] || {
        pode_ver: false, pode_criar: false, pode_editar: false, pode_deletar: false
      };
    }

    return resultado;
  } catch (err) {
    console.error('[permissoes] Erro ao buscar permissões:', err.message);
    return {}; // fallback seguro — negar acesso implicitamente via objeto vazio
  }
}

module.exports = { requirePermissao, obterPermissoes, MODULOS_VALIDOS, ACOES_VALIDAS };
