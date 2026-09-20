-- Migration 044 — Ordens de Serviço (OS)
-- Módulo de manutenção de celulares e computadores

CREATE TABLE IF NOT EXISTS ordens_servico (
  id                   SERIAL PRIMARY KEY,
  numero               TEXT NOT NULL,
  empresa              TEXT,
  empresa_id           INTEGER REFERENCES empresas(id),
  cliente_id           INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'aberta'
                         CHECK (status IN ('aberta','diagnostico','aguardando_peca','em_execucao','pronto','entregue','cancelada')),
  equipamento_tipo     TEXT,
  equipamento_marca    TEXT,
  equipamento_modelo   TEXT,
  equipamento_serie    TEXT,
  problema_relatado    TEXT,
  diagnostico          TEXT,
  servicos_realizados  TEXT,
  tecnico              TEXT,
  valor_mao_obra       NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_pecas          NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_total          NUMERIC(12,2) NOT NULL DEFAULT 0,
  data_entrada         TIMESTAMPTZ DEFAULT NOW(),
  data_prevista        DATE,
  data_conclusao       TIMESTAMPTZ,
  observacoes          TEXT,
  criado_em            TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (empresa_id, numero)
);

CREATE TABLE IF NOT EXISTS ordens_servico_itens (
  id             SERIAL PRIMARY KEY,
  os_id          INTEGER NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  produto_id     INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  descricao      TEXT NOT NULL,
  quantidade     NUMERIC(10,3) NOT NULL DEFAULT 1,
  valor_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_total    NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_os_empresa_id  ON ordens_servico(empresa_id);
CREATE INDEX IF NOT EXISTS idx_os_status      ON ordens_servico(status);
CREATE INDEX IF NOT EXISTS idx_os_cliente_id  ON ordens_servico(cliente_id);
CREATE INDEX IF NOT EXISTS idx_os_criado_em   ON ordens_servico(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_os_itens_os_id ON ordens_servico_itens(os_id);

-- Permissões padrão para o módulo
INSERT INTO permissoes_padrao (tipo_usuario, modulo, pode_ver, pode_criar, pode_editar, pode_deletar) VALUES
  ('admin',       'ordens_servico', true, true,  true,  true),
  ('gerente',     'ordens_servico', true, true,  true,  false),
  ('funcionario', 'ordens_servico', true, true,  true,  false)
ON CONFLICT (tipo_usuario, modulo) DO NOTHING;
