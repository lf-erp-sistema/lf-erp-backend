-- Login é case-insensitive (WHERE LOWER(usuario) = LOWER($1)), mas a constraint
-- UNIQUE existente em usuarios.usuario é case-sensitive — permitia cadastrar
-- "Joao" e "joao" como contas distintas (inclusive em empresas diferentes, já
-- que usuario é único globalmente), gerando risco de confusão de conta/tenant
-- no login (achado A-SEC-002, Auditoria 2026-10-15).
--
-- Verificado antes desta migration: nenhuma duplicata case-insensitive existe
-- em produção (SELECT LOWER(usuario), COUNT(*) FROM usuarios GROUP BY 1 HAVING COUNT(*)>1).
--
-- Substitui o índice não-único idx_usuarios_usuario_lower (001_indexes.sql /
-- db/initDb.js) por um índice único equivalente — serve às mesmas queries de
-- login e também passa a impedir duplicatas por caixa no banco.
DROP INDEX IF EXISTS idx_usuarios_usuario_lower;

CREATE UNIQUE INDEX IF NOT EXISTS usuarios_usuario_lower_uidx ON usuarios (LOWER(usuario));
