-- O seed de servicos_catalogo (045_servicos_catalogo.sql) insere ~140 linhas
-- sem ON CONFLICT e sem nenhuma constraint UNIQUE que pudesse servir de alvo
-- para isso (achado D-DATA-002, Auditoria 2026-10-15). O runner nunca reaplica
-- uma migration já registrada, então não há risco via o fluxo normal — mas o
-- arquivo fica vulnerável a duplicação se alguém rodar seu conteúdo manualmente
-- mais de uma vez (ex. copiar/colar no console do Neon).
--
-- Verificado antes desta migration: nenhuma duplicata de (empresa_id, categoria,
-- nome) existe em produção hoje.
--
-- COALESCE(empresa_id, 0) trata o catálogo global (empresa_id NULL) como um
-- grupo único de unicidade, mesmo padrão já usado em tabela_preco_itens
-- (007_tabelas_preco.sql).
CREATE UNIQUE INDEX IF NOT EXISTS idx_servicos_catalogo_unique
  ON servicos_catalogo (COALESCE(empresa_id, 0), categoria, nome);
