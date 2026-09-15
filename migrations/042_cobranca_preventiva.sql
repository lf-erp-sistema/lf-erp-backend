-- Migration 042 — Cobrança preventiva de promissórias
-- Adiciona campos de configuração de disparo automático às 8h.

ALTER TABLE alertas_config
  ADD COLUMN IF NOT EXISTS cobranca_preventiva_ativa BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS cobranca_preventiva_hora  INTEGER DEFAULT 8;
