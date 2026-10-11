-- =============================================================================
-- LF ERP — Migration 001: Índices de performance
-- Gerado em: 2026-06-07
-- Aplicado em: startup automático via server.js (initDB)
-- Todos os comandos usam IF NOT EXISTS — seguro para re-executar.
-- =============================================================================

-- ── Empresas e Planos ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_empresas_plano_id       ON empresas (plano_id);
CREATE INDEX IF NOT EXISTS idx_empresas_status         ON empresas (assinatura_status);
CREATE INDEX IF NOT EXISTS idx_empresas_slug           ON empresas (slug);
CREATE INDEX IF NOT EXISTS idx_planos_codigo           ON planos (codigo);

-- ── Usuários ─────────────────────────────────────────────────────────────────
-- idx_usuarios_usuario_lower: login usa WHERE LOWER(usuario) = LOWER($1)
-- sem índice funcional → seq scan em todo login
CREATE INDEX IF NOT EXISTS idx_usuarios_usuario_lower  ON usuarios (LOWER(usuario));
CREATE INDEX IF NOT EXISTS idx_usuarios_empresa_id     ON usuarios (empresa_id);

-- ── Produtos ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_produtos_empresa        ON produtos (empresa);
CREATE INDEX IF NOT EXISTS idx_produtos_empresa_id     ON produtos (empresa_id);
CREATE INDEX IF NOT EXISTS idx_produtos_codigo_barras  ON produtos (codigo_barras) WHERE codigo_barras IS NOT NULL;
-- Índices parciais com deletado_em: ver migration 038_produtos_colunas_faltantes.sql
-- (é lá que a coluna deletado_em é garantida — criá-los aqui quebra bootstrap em banco novo).

-- ── Clientes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_clientes_empresa        ON clientes (empresa);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa_id     ON clientes (empresa_id);
CREATE INDEX IF NOT EXISTS idx_clientes_cpf            ON clientes (cpf) WHERE cpf IS NOT NULL AND cpf <> '';

-- ── Fornecedores ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa    ON fornecedores (empresa);
CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa_id ON fornecedores (empresa_id);

-- ── Vendas e Itens ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_vendas_empresa          ON vendas (empresa);
CREATE INDEX IF NOT EXISTS idx_vendas_empresa_id       ON vendas (empresa_id);
CREATE INDEX IF NOT EXISTS idx_vendas_empresa_data     ON vendas (empresa, data);
CREATE INDEX IF NOT EXISTS idx_vendas_empresa_id_data  ON vendas (empresa_id, data DESC);
CREATE INDEX IF NOT EXISTS idx_vendas_cliente          ON vendas (cliente_id);
CREATE INDEX IF NOT EXISTS idx_venda_itens_venda       ON venda_itens (venda_id);
CREATE INDEX IF NOT EXISTS idx_venda_itens_empresa     ON venda_itens (empresa);
-- idx_venda_itens_empresa_id: ver migration 032_backfill_empresa_id.sql
-- (é lá que a coluna empresa_id é adicionada em venda_itens — criar o índice
-- aqui quebra bootstrap em banco novo).
CREATE INDEX IF NOT EXISTS idx_venda_itens_produto     ON venda_itens (produto_id);

-- ── Compras e Itens ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_compras_empresa         ON compras (empresa);
CREATE INDEX IF NOT EXISTS idx_compras_empresa_id      ON compras (empresa_id);
CREATE INDEX IF NOT EXISTS idx_compras_empresa_id_data ON compras (empresa_id, data DESC);
CREATE INDEX IF NOT EXISTS idx_compra_itens_compra     ON compra_itens (compra_id);
-- idx_compra_itens_empresa_id: ver migration 032_backfill_empresa_id.sql (mesmo motivo acima)
CREATE INDEX IF NOT EXISTS idx_compra_itens_produto    ON compra_itens (produto_id);

-- ── Contas a Receber ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contas_receber_empresa     ON contas_receber (empresa);
CREATE INDEX IF NOT EXISTS idx_contas_receber_empresa_id  ON contas_receber (empresa_id);
CREATE INDEX IF NOT EXISTS idx_contas_receber_status      ON contas_receber (empresa, status);
CREATE INDEX IF NOT EXISTS idx_cr_empresa_id_status       ON contas_receber (empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_contas_receber_cliente     ON contas_receber (cliente_id);
-- Vencimento composto: SSE e inadimplência filtram (empresa_id, data_vencimento)
CREATE INDEX IF NOT EXISTS idx_contas_receber_vencimento  ON contas_receber (empresa, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_cr_empresa_id_vencimento   ON contas_receber (empresa_id, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_contas_receber_vencimento_id ON contas_receber (empresa_id, data_vencimento);

-- ── Contas a Pagar ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa       ON contas_pagar (empresa);
CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa_id    ON contas_pagar (empresa_id);
CREATE INDEX IF NOT EXISTS idx_contas_pagar_status        ON contas_pagar (empresa, status);
CREATE INDEX IF NOT EXISTS idx_cp_empresa_id_status       ON contas_pagar (empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_contas_pagar_fornecedor    ON contas_pagar (fornecedor_id);
-- Vencimento composto: SSE e dashboards filtram (empresa_id, data_vencimento)
CREATE INDEX IF NOT EXISTS idx_contas_pagar_vencimento    ON contas_pagar (empresa, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_cp_empresa_id_vencimento   ON contas_pagar (empresa_id, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_contas_pagar_vencimento_id ON contas_pagar (empresa_id, data_vencimento);

-- ── Movimentações de Estoque ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_mov_estoque_empresa        ON movimentacoes_estoque (empresa);
-- idx_mov_estoque_empresa_id: ver migration 032_backfill_empresa_id.sql (mesmo motivo acima)
CREATE INDEX IF NOT EXISTS idx_mov_estoque_produto        ON movimentacoes_estoque (produto_id);
CREATE INDEX IF NOT EXISTS idx_mov_estoque_data           ON movimentacoes_estoque (produto_id, data_movimentacao);

-- ── Lançamentos Financeiros ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa        ON lancamentos_financeiros (empresa);
CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_id     ON lancamentos_financeiros (empresa_id);
CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_status ON lancamentos_financeiros (empresa, status);
CREATE INDEX IF NOT EXISTS idx_lancamentos_conta_receber_id ON lancamentos_financeiros (conta_receber_id);

-- ── Investimentos ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_investimentos_empresa      ON investimentos (empresa);
CREATE INDEX IF NOT EXISTS idx_investimentos_empresa_id   ON investimentos (empresa_id);

-- ── Configurações ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_configuracoes_empresa      ON configuracoes (empresa);
CREATE INDEX IF NOT EXISTS idx_configuracoes_empresa_id   ON configuracoes (empresa_id);

-- ── Logs de Auditoria ─────────────────────────────────────────────────────────
-- Auditoria: consultas por empresa + período são as mais comuns no admin
CREATE INDEX IF NOT EXISTS idx_logs_auditoria_empresa_id  ON logs_auditoria (empresa_id);
CREATE INDEX IF NOT EXISTS idx_logs_auditoria_criado_em   ON logs_auditoria (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_logs_auditoria_modulo_acao ON logs_auditoria (modulo, acao);
