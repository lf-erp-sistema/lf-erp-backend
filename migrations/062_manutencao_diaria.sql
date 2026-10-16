CREATE TABLE IF NOT EXISTS manutencao_execucoes (
  tarefa TEXT PRIMARY KEY,
  ultima_data TEXT NOT NULL,
  concluido_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
