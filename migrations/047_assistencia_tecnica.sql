-- Migration 047 — Módulo de Assistência Técnica
-- Extensão do módulo OS existente com campos e tabelas específicos de AT

-- ── 1. Estende ordens_servico com campos de assistência técnica ───────────────
ALTER TABLE ordens_servico
  ADD COLUMN IF NOT EXISTS equipamento_imei1        TEXT,
  ADD COLUMN IF NOT EXISTS equipamento_imei2        TEXT,
  ADD COLUMN IF NOT EXISTS equipamento_cor          TEXT,
  ADD COLUMN IF NOT EXISTS equipamento_capacidade   TEXT,
  ADD COLUMN IF NOT EXISTS equipamento_so           TEXT,
  ADD COLUMN IF NOT EXISTS acessorios_entregues     TEXT,
  ADD COLUMN IF NOT EXISTS defeito_cliente          TEXT,
  ADD COLUMN IF NOT EXISTS causa_provavel           TEXT,
  ADD COLUMN IF NOT EXISTS procedimento_recomendado TEXT,
  ADD COLUMN IF NOT EXISTS orcamento_status         TEXT DEFAULT 'pendente',
  ADD COLUMN IF NOT EXISTS aparelho_id              INTEGER,
  ADD COLUMN IF NOT EXISTS entregue_por             TEXT,
  ADD COLUMN IF NOT EXISTS entregue_pagamento       TEXT,
  ADD COLUMN IF NOT EXISTS entregue_observacoes     TEXT,
  ADD COLUMN IF NOT EXISTS conta_receber_id         INTEGER;

-- Atualiza o CHECK constraint de status para incluir os novos status AT
ALTER TABLE ordens_servico DROP CONSTRAINT IF EXISTS ordens_servico_status_check;
ALTER TABLE ordens_servico ADD CONSTRAINT ordens_servico_status_check
  CHECK (status IN (
    'aberta', 'diagnostico', 'orcamento_enviado', 'aguardando_aprovacao',
    'aprovada', 'em_execucao', 'aguardando_peca', 'pronto',
    'entregue', 'cancelada', 'reprovada'
  ));

-- CHECK constraint para orcamento_status
ALTER TABLE ordens_servico DROP CONSTRAINT IF EXISTS ordens_servico_orcamento_status_check;
ALTER TABLE ordens_servico ADD CONSTRAINT ordens_servico_orcamento_status_check
  CHECK (orcamento_status IN ('pendente','enviado','aguardando','aprovado','reprovado') OR orcamento_status IS NULL);

-- ── 2. Aparelhos — cadastro de dispositivos com histórico por IMEI ─────────────
CREATE TABLE IF NOT EXISTS at_aparelhos (
  id            SERIAL PRIMARY KEY,
  empresa_id    INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id    INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  tipo          TEXT NOT NULL DEFAULT 'Smartphone',
  marca         TEXT,
  modelo        TEXT,
  imei1         TEXT,
  imei2         TEXT,
  serie         TEXT,
  cor           TEXT,
  capacidade    TEXT,
  so            TEXT,
  observacoes   TEXT,
  criado_em     TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. Checklist de entrada por OS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS at_checklist (
  id          SERIAL PRIMARY KEY,
  os_id       INTEGER NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
  item_key    TEXT NOT NULL,
  item_tipo   TEXT NOT NULL CHECK (item_tipo IN ('fisico','funcional')),
  item_label  TEXT NOT NULL,
  resultado   TEXT NOT NULL DEFAULT 'nao_testado'
              CHECK (resultado IN ('ok','problema','nao_testado','nao_aplica')),
  observacao  TEXT,
  criado_em   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (os_id, item_key)
);

-- ── 4. Timeline de eventos por OS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS at_eventos (
  id           SERIAL PRIMARY KEY,
  os_id        INTEGER NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id),
  tipo         TEXT NOT NULL,
  descricao    TEXT NOT NULL,
  usuario_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nome TEXT,
  criado_em    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 5. Garantias por OS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS at_garantias (
  id             SERIAL PRIMARY KEY,
  os_id          INTEGER NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  dias_garantia  INTEGER NOT NULL DEFAULT 90,
  data_inicio    DATE NOT NULL,
  data_fim       DATE NOT NULL,
  condicoes      TEXT,
  observacoes    TEXT,
  criado_em      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 6. Índices ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_at_aparelhos_empresa   ON at_aparelhos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_at_aparelhos_cliente   ON at_aparelhos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_at_aparelhos_imei1     ON at_aparelhos(imei1) WHERE imei1 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_at_checklist_os        ON at_checklist(os_id);
CREATE INDEX IF NOT EXISTS idx_at_eventos_os          ON at_eventos(os_id);
CREATE INDEX IF NOT EXISTS idx_at_eventos_empresa     ON at_eventos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_at_garantias_os        ON at_garantias(os_id);
CREATE INDEX IF NOT EXISTS idx_at_garantias_empresa   ON at_garantias(empresa_id, data_fim);
CREATE INDEX IF NOT EXISTS idx_os_imei1               ON ordens_servico(equipamento_imei1) WHERE equipamento_imei1 IS NOT NULL;

-- ── 7. Permissões padrão para o módulo AT ─────────────────────────────────────
INSERT INTO permissoes_padrao (tipo_usuario, modulo, pode_ver, pode_criar, pode_editar, pode_deletar)
VALUES
  ('admin',       'assistencia_tecnica', true, true,  true,  true),
  ('gerente',     'assistencia_tecnica', true, true,  true,  false),
  ('funcionario', 'assistencia_tecnica', true, true,  true,  false)
ON CONFLICT (tipo_usuario, modulo) DO NOTHING;

-- ── 8. Habilita AT para LF Tech Solutions (pelo empresa_id, não pelo nome) ────
-- A subquery localiza o empresa_id pelo nome apenas UMA VEZ durante a migration.
-- A segurança em runtime usa empresa_id, nunca o nome.
INSERT INTO empresa_features (empresa_id, feature, habilitado)
SELECT id, 'assistencia_tecnica', TRUE
FROM empresas
WHERE LOWER(nome) LIKE '%lf tech%'
ON CONFLICT (empresa_id, feature) DO UPDATE SET habilitado = TRUE;
