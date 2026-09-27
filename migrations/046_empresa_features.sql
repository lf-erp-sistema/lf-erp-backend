-- Migration 046 — Feature flags por empresa
-- Permite habilitar/desabilitar módulos específicos por empresa_id

CREATE TABLE IF NOT EXISTS empresa_features (
  id         SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  feature    TEXT    NOT NULL,
  habilitado BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (empresa_id, feature)
);

CREATE INDEX IF NOT EXISTS idx_empresa_features ON empresa_features(empresa_id, feature);
