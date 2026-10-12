-- Índices para consultas operacionais mais frequentes.
-- Todos preservam o recorte por empresa já exigido nas rotas e são idempotentes.

-- Caixa: sessão aberta atual e histórico ordenado pela abertura.
CREATE INDEX IF NOT EXISTS idx_caixa_sessoes_empresa_status_aberto_em
  ON caixa_sessoes (empresa_id, status, aberto_em DESC);

CREATE INDEX IF NOT EXISTS idx_caixa_sessoes_empresa_aberto_em
  ON caixa_sessoes (empresa_id, aberto_em DESC);

CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_sessao_criado_em
  ON caixa_movimentos (sessao_id, criado_em ASC);

-- Comissões: filtros por empresa/status e ordenação cronológica da listagem.
CREATE INDEX IF NOT EXISTS idx_comissoes_empresa_status_criado_em
  ON comissoes (empresa_id, status, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_comissoes_empresa_criado_em
  ON comissoes (empresa_id, criado_em DESC);

-- NF-e: listagem da empresa, inclusive quando filtrada por status.
CREATE INDEX IF NOT EXISTS idx_nfe_emissoes_empresa_status_criado_em
  ON nfe_emissoes (empresa_id, status, criado_em DESC);
