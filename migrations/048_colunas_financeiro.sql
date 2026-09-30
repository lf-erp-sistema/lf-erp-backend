-- Migration 048 — Colunas financeiras ausentes em produção
--
-- initDb.js tem fast-path que retorna imediatamente se 'empresas' já existe,
-- portanto os ALTER TABLE adicionados ao initDb.js após o baseline nunca rodaram
-- em produção. Esta migration adiciona as colunas ausentes.

-- contas_receber: valor_original + campos de encargo (multa/juros/atraso)
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS valor_original   NUMERIC(12,2);
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS valor_atualizado NUMERIC(12,2);
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS dias_atraso      INTEGER DEFAULT 0;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS multa            NUMERIC(12,2) DEFAULT 0;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS juros            NUMERIC(12,2) DEFAULT 0;

-- contas_pagar: valor_original para baixa e registro de parcelas
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS valor_original NUMERIC(12,2);

-- lancamentos_financeiros: empresa_id + FKs para contas (IF NOT EXISTS — podem já existir)
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS empresa_id       INTEGER;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS conta_receber_id INTEGER;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS conta_pagar_id   INTEGER;

-- configuracoes: taxas de encargo para cálculo de multa/juros por atraso
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS taxa_multa     NUMERIC(8,4) NOT NULL DEFAULT 0.02;
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS taxa_juros_dia NUMERIC(8,6) NOT NULL DEFAULT 0.00033;
