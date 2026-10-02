-- Migration 049 — Colunas de CSC (QR Code) ausentes em nfe_config
--
-- codigo_csc e id_token_csc foram adicionados ao initDb.js (fast-path, nao
-- roda em producao) mas nunca entraram numa migration. Sem elas, salvar a
-- configuracao de NF-e/NFC-e falha com "column does not exist" (mesmo padrao
-- do bug de contas_receber.valor_original corrigido na migration 048).

ALTER TABLE nfe_config ADD COLUMN IF NOT EXISTS codigo_csc   TEXT;
ALTER TABLE nfe_config ADD COLUMN IF NOT EXISTS id_token_csc TEXT;
