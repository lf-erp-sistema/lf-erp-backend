-- Migration de regularização: 4 elementos de schema que existiam só em
-- backend/db/initDb.js (aplicados manualmente em produção, fora de rastreamento)
-- nunca tiveram uma migration numerada correspondente. Achado DB-01..04 da
-- Auditoria 360 (2026-10-06). Todo DDL abaixo é aditivo e idempotente (IF NOT
-- EXISTS) -- em produção, onde essas tabelas/colunas já existem, roda como
-- no-op e só passa a ficar registrado em _migrations.

-- DB-01: jwt_blacklist -- revogação de token no logout não sobrevivia a um
-- restart do processo sem esta tabela existir de forma rastreada.
CREATE TABLE IF NOT EXISTS jwt_blacklist (
  token_hash TEXT PRIMARY KEY,
  revoked_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jwt_blacklist_expires ON jwt_blacklist (expires_at);

-- DB-02: usuarios.is_saas_owner -- base de toda a autorização do SaaS Owner
-- (middleware/auth.js, utils/empresa.js, utils/permissoes.js e dezenas de rotas).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS is_saas_owner BOOLEAN NOT NULL DEFAULT FALSE;

-- DB-03: nfce_emissoes -- feature de NFC-e inteira depende desta tabela.
CREATE TABLE IF NOT EXISTS nfce_emissoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER,
  venda_id INTEGER,
  ref TEXT UNIQUE NOT NULL,
  ambiente INTEGER DEFAULT 2,
  status TEXT DEFAULT 'processando',
  chave_nfe TEXT,
  numero INTEGER,
  serie TEXT,
  mensagem TEXT,
  cancelado_em TIMESTAMPTZ,
  motivo_cancelamento TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- DB-04: compras.idempotency_key -- protege contra compra duplicada em retry.
ALTER TABLE compras ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS compras_idempotency_idx
  ON compras (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
