-- Migration 032 — Backfill empresa_id em todas as tabelas legadas
--
-- Estratégia: UPDATE ... FROM empresas WHERE empresa_id IS NULL AND empresa = nome
-- Seguro: puramente aditivo, sem remoção de dados ou colunas.
-- Após o backfill, adiciona NOT NULL onde todos os registros estiverem preenchidos.

-- ── 1. Garantir que empresa_id exista em todas as tabelas ───────────────────
ALTER TABLE movimentacoes_estoque ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
ALTER TABLE venda_itens            ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
ALTER TABLE compra_itens           ADD COLUMN IF NOT EXISTS empresa_id INTEGER;

-- ── 2. Backfill — associa empresa_id pelo nome da empresa ──────────────────

UPDATE usuarios u
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(u.empresa) = LOWER(e.nome)
   AND u.empresa_id IS NULL
   AND u.empresa IS NOT NULL;

UPDATE produtos p
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(p.empresa) = LOWER(e.nome)
   AND p.empresa_id IS NULL
   AND p.empresa IS NOT NULL;

UPDATE clientes c
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(c.empresa) = LOWER(e.nome)
   AND c.empresa_id IS NULL
   AND c.empresa IS NOT NULL;

UPDATE fornecedores f
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(f.empresa) = LOWER(e.nome)
   AND f.empresa_id IS NULL
   AND f.empresa IS NOT NULL;

UPDATE compras c
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(c.empresa) = LOWER(e.nome)
   AND c.empresa_id IS NULL
   AND c.empresa IS NOT NULL;

UPDATE vendas v
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(v.empresa) = LOWER(e.nome)
   AND v.empresa_id IS NULL
   AND v.empresa IS NOT NULL;

UPDATE venda_itens vi
   SET empresa_id = v.empresa_id
  FROM vendas v
 WHERE vi.venda_id = v.id
   AND vi.empresa_id IS NULL
   AND v.empresa_id IS NOT NULL;

UPDATE compra_itens ci
   SET empresa_id = c.empresa_id
  FROM compras c
 WHERE ci.compra_id = c.id
   AND ci.empresa_id IS NULL
   AND c.empresa_id IS NOT NULL;

UPDATE movimentacoes_estoque m
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(m.empresa) = LOWER(e.nome)
   AND m.empresa_id IS NULL
   AND m.empresa IS NOT NULL;

UPDATE contas_receber cr
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(cr.empresa) = LOWER(e.nome)
   AND cr.empresa_id IS NULL
   AND cr.empresa IS NOT NULL;

UPDATE contas_pagar cp
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(cp.empresa) = LOWER(e.nome)
   AND cp.empresa_id IS NULL
   AND cp.empresa IS NOT NULL;

UPDATE lancamentos_financeiros lf
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(lf.empresa) = LOWER(e.nome)
   AND lf.empresa_id IS NULL
   AND lf.empresa IS NOT NULL;

UPDATE investimentos i
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(i.empresa) = LOWER(e.nome)
   AND i.empresa_id IS NULL
   AND i.empresa IS NOT NULL;

UPDATE configuracoes cfg
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(cfg.empresa) = LOWER(e.nome)
   AND cfg.empresa_id IS NULL
   AND cfg.empresa IS NOT NULL;

UPDATE conciliacoes c
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(c.empresa) = LOWER(e.nome)
   AND c.empresa_id IS NULL
   AND c.empresa IS NOT NULL;

UPDATE cobrancas_pix cp
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(cp.empresa) = LOWER(e.nome)
   AND cp.empresa_id IS NULL
   AND cp.empresa IS NOT NULL;

UPDATE conciliacao_itens ci
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(ci.empresa) = LOWER(e.nome)
   AND ci.empresa_id IS NULL
   AND ci.empresa IS NOT NULL;

UPDATE logs_auditoria la
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(la.empresa) = LOWER(e.nome)
   AND la.empresa_id IS NULL
   AND la.empresa IS NOT NULL;

UPDATE financeiro_logs fl
   SET empresa_id = e.id
  FROM empresas e
 WHERE LOWER(fl.empresa) = LOWER(e.nome)
   AND fl.empresa_id IS NULL
   AND fl.empresa IS NOT NULL;

-- ── 3. Índices para tabelas que ainda não tinham ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_venda_itens_empresa_id
  ON venda_itens (empresa_id)
  WHERE empresa_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_compra_itens_empresa_id
  ON compra_itens (empresa_id)
  WHERE empresa_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_movimentacoes_empresa_id
  ON movimentacoes_estoque (empresa_id)
  WHERE empresa_id IS NOT NULL;

-- Movido de 015_indexes_performance.sql, que rodava antes desta migration
-- existir e quebrava o bootstrap em um banco novo (empresa_id não existe em
-- movimentacoes_estoque até as linhas ADD COLUMN acima rodarem).
CREATE INDEX IF NOT EXISTS idx_movim_empresa_produto
  ON movimentacoes_estoque(empresa_id, produto_id);
