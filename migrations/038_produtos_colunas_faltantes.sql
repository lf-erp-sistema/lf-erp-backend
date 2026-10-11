-- Migration 038 — Colunas de produtos que existem em produção mas nunca foram
-- formalizadas em migration (adicionadas diretamente na época do initDb).
-- Idempotente: ADD COLUMN IF NOT EXISTS não afeta DBs que já têm as colunas.

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo_unitario    NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo_medio       NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS lucro_unitario    NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS margem_lucro      NUMERIC(8,4)  NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_promocional NUMERIC(12,2);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS promocao_ativa    BOOLEAN       NOT NULL DEFAULT false;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS deletado_em       TIMESTAMP;

ALTER TABLE clientes    ADD COLUMN IF NOT EXISTS deletado_em    TIMESTAMP;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS deletado_em   TIMESTAMP;

-- Índices parciais sobre deletado_em — movidos de 001_indexes.sql, que rodava
-- antes desta migration existir e quebrava o bootstrap em um banco novo
-- (deletado_em não existe até as linhas ADD COLUMN acima rodarem).
CREATE INDEX IF NOT EXISTS idx_produtos_deletado_em     ON produtos (empresa_id, deletado_em) WHERE deletado_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_deletado_em     ON clientes (empresa_id, deletado_em) WHERE deletado_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_fornecedores_deletado_em ON fornecedores (empresa_id, deletado_em) WHERE deletado_em IS NULL;

-- Movidos de 015_indexes_performance.sql, que rodava antes desta migration
-- existir e quebrava o bootstrap em um banco novo. Os nomes são distintos dos
-- índices legados sobre a coluna `empresa` (texto), para garantir a criação
-- dos índices corretos sobre `empresa_id`.
CREATE INDEX IF NOT EXISTS idx_produtos_empresa_id_ativos
  ON produtos(empresa_id, deletado_em NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa_id_ativos
  ON clientes(empresa_id, deletado_em NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa_id_ativos
  ON fornecedores(empresa_id, deletado_em NULLS FIRST);
