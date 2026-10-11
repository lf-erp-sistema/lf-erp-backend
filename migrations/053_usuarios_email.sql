-- Migration 053 — Coluna usuarios.email
--
-- POST /registro (backend/routes/auth.routes.js) insere em usuarios.email
-- desde sempre, mas a coluna nunca foi formalizada em nenhuma migration nem
-- no initDb.js — em qualquer banco onde ela não exista por fora (ex. criado
-- manualmente em produção), o autorregistro de empresa quebra com 500.
-- Idempotente: ADD COLUMN IF NOT EXISTS não afeta bancos que já têm a coluna.

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email TEXT;
