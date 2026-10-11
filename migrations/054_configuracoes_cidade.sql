-- Migration 054 — Coluna configuracoes.cidade
--
-- checkout.routes.js#getCfgEmpresa seleciona cfg.cidade (usada na geração do
-- PIX Copia e Cola, com fallback 'SAO PAULO') mas a coluna nunca foi criada
-- em nenhuma migration nem no initDb.js — quebra POST /checkout sempre que
-- a empresa não tem o fallback de outra fonte.
-- Idempotente: ADD COLUMN IF NOT EXISTS não afeta bancos que já têm a coluna.

ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS cidade TEXT;
