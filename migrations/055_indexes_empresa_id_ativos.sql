-- Migration 055 — índices por empresa_id que podem ter sido omitidos em bancos
-- já atualizados. As migrations 015/038 existiam antes de esta correção e
-- usavam nomes que colidiam com índices legados sobre `empresa` (texto).
-- CREATE INDEX IF NOT EXISTS então não criava os equivalentes por empresa_id.
-- Esta migration é idempotente e também cobre bancos que já registraram 015/038.

CREATE INDEX IF NOT EXISTS idx_produtos_empresa_id_ativos
  ON produtos(empresa_id, deletado_em NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa_id_ativos
  ON clientes(empresa_id, deletado_em NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa_id_ativos
  ON fornecedores(empresa_id, deletado_em NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_vendas_empresa_id_data_desc
  ON vendas(empresa_id, data DESC);
