-- Achado DB-05 da Auditoria 360 (2026-10-06): tabelas transacionais sem
-- foreign key, integridade dependendo inteiramente da aplicação nunca ter
-- um bug. Verificado antes desta migration, via consulta read-only em
-- produção, que não existe HOJE nenhuma linha órfã em nenhuma das 11
-- relações abaixo (0 violações em todas) -- as ADD CONSTRAINT abaixo só
-- formalizam uma invariante que já é verdadeira.
--
-- ON DELETE escolhido para espelhar exatamente o comportamento atual da
-- aplicação, nunca introduzir uma exclusão nova:
--   - venda_itens.venda_id -> vendas: CASCADE. A exclusão de venda já
--     apaga manualmente todos os venda_itens (removerDadosDependentesVenda,
--     vendas.routes.js) -- a constraint só formaliza o que já acontece.
--   - produtos, clientes e fornecedores nunca são hard-deletados pela
--     aplicação (soft-delete via deletado_em) e cada DELETE correspondente
--     já bloqueia manualmente quando existem compras/vendas/contas vinculadas
--     -- então todo FK que aponta para produtos/clientes/fornecedores usa
--     RESTRICT: na prática nunca é disparado (o app já impede antes de
--     chegar lá), e funciona como rede de segurança contra regressão futura
--     -- nunca apaga nada, só bloqueia e sinaliza erro.
--   - contas_receber.venda_id e contas_pagar.compra_id usam RESTRICT pelo
--     mesmo motivo: a aplicação já limpa (ou bloqueia) antes de excluir o
--     pai, então RESTRICT nunca deveria disparar -- se algum dia disparar,
--     é sinal de um bug a investigar, não de uma operação a mascarar
--     silenciosamente apagando o registro financeiro.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_venda_itens_venda') THEN
    ALTER TABLE venda_itens
      ADD CONSTRAINT fk_venda_itens_venda FOREIGN KEY (venda_id)
      REFERENCES vendas (id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_venda_itens_produto') THEN
    ALTER TABLE venda_itens
      ADD CONSTRAINT fk_venda_itens_produto FOREIGN KEY (produto_id)
      REFERENCES produtos (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_compra_itens_compra') THEN
    ALTER TABLE compra_itens
      ADD CONSTRAINT fk_compra_itens_compra FOREIGN KEY (compra_id)
      REFERENCES compras (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_compra_itens_produto') THEN
    ALTER TABLE compra_itens
      ADD CONSTRAINT fk_compra_itens_produto FOREIGN KEY (produto_id)
      REFERENCES produtos (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_compras_fornecedor') THEN
    ALTER TABLE compras
      ADD CONSTRAINT fk_compras_fornecedor FOREIGN KEY (fornecedor_id)
      REFERENCES fornecedores (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contas_receber_venda') THEN
    ALTER TABLE contas_receber
      ADD CONSTRAINT fk_contas_receber_venda FOREIGN KEY (venda_id)
      REFERENCES vendas (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contas_receber_cliente') THEN
    ALTER TABLE contas_receber
      ADD CONSTRAINT fk_contas_receber_cliente FOREIGN KEY (cliente_id)
      REFERENCES clientes (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contas_pagar_fornecedor') THEN
    ALTER TABLE contas_pagar
      ADD CONSTRAINT fk_contas_pagar_fornecedor FOREIGN KEY (fornecedor_id)
      REFERENCES fornecedores (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contas_pagar_compra') THEN
    ALTER TABLE contas_pagar
      ADD CONSTRAINT fk_contas_pagar_compra FOREIGN KEY (compra_id)
      REFERENCES compras (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_movimentacoes_estoque_produto') THEN
    ALTER TABLE movimentacoes_estoque
      ADD CONSTRAINT fk_movimentacoes_estoque_produto FOREIGN KEY (produto_id)
      REFERENCES produtos (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendas_cliente') THEN
    ALTER TABLE vendas
      ADD CONSTRAINT fk_vendas_cliente FOREIGN KEY (cliente_id)
      REFERENCES clientes (id) ON DELETE RESTRICT;
  END IF;
END $$;
