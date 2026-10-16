-- ================================================================
-- Reset dados: Lucileide Variedades → Premium ativo sem expiração
-- Executar via: Neon Console → SQL Editor
-- Data: 2026-06-21 | AÇÃO IRREVERSÍVEL — faça backup antes
--
-- Este script NÃO está na pasta migrations/ propositalmente.
-- Deve ser executado MANUALMENTE quando quiser zerar todos os dados
-- da empresa piloto para reiniciar do zero.
-- ================================================================

DO $$
DECLARE
  emp_id INTEGER;
  emp_nome CONSTANT TEXT := 'Lucileide Variedades';
BEGIN
  -- 1. Localizar empresa
  SELECT id INTO emp_id FROM empresas WHERE LOWER(nome) = LOWER(emp_nome);
  IF emp_id IS NULL THEN
    RAISE EXCEPTION 'Empresa "%" não encontrada.', emp_nome;
  END IF;
  RAISE NOTICE 'empresa_id encontrado: %', emp_id;

  -- ============================================================
  -- 2. Deletar dados em ordem correta (filhos antes de pais)
  -- ============================================================

  -- Itens (FK → tabelas pai)
  DELETE FROM venda_itens       WHERE empresa_id = emp_id;
  DELETE FROM compra_itens      WHERE empresa_id = emp_id;
  DELETE FROM conciliacao_itens WHERE empresa_id = emp_id;
  DELETE FROM nfce_emissoes     WHERE empresa_id = emp_id;
  DELETE FROM cobrancas_pix     WHERE empresa_id = emp_id;

  -- Tabelas que podem ou não existir dependendo de módulos ativados
  BEGIN DELETE FROM pedido_itens               WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM orcamento_itens            WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM devolucao_itens            WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM nfe_emissoes               WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM nfse_emissoes              WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM rastreabilidade_movimentos WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM lotes                      WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM numeros_serie              WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM crm_atividades             WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM comissoes_config_produtos  WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM kit_componentes            WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM tabela_preco_itens         WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM marketplace_pedidos        WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- Transações principais
  BEGIN DELETE FROM comissoes WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  DELETE FROM vendas        WHERE empresa_id = emp_id;
  DELETE FROM compras       WHERE empresa_id = emp_id;
  DELETE FROM conciliacoes  WHERE empresa_id = emp_id;

  BEGIN DELETE FROM pedidos          WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM orcamentos       WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM devolucoes       WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM checkout_links   WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM caixa_movimentos WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM caixa_sessoes    WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM crm_oportunidades WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  -- ordens_servico CASCADEia ordens_servico_itens, at_checklist, at_eventos e
  -- at_garantias (FKs ON DELETE CASCADE, migrations 044/047) — basta deletar a
  -- tabela pai. at_aparelhos é entidade independente (sem FK formal pra OS).
  BEGIN DELETE FROM ordens_servico WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM at_aparelhos   WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- Financeiro (tabelas certamente existentes)
  DELETE FROM contas_receber          WHERE empresa_id = emp_id;
  DELETE FROM contas_pagar            WHERE empresa_id = emp_id;
  DELETE FROM lancamentos_financeiros WHERE empresa_id = emp_id;
  DELETE FROM movimentacoes_estoque   WHERE empresa_id = emp_id;
  DELETE FROM investimentos           WHERE empresa_id = emp_id;
  DELETE FROM financeiro_logs         WHERE empresa_id = emp_id;
  DELETE FROM logs_auditoria          WHERE empresa_id = emp_id;

  -- Comunicação / Alertas / Comissões / Fidelidade
  BEGIN DELETE FROM whatsapp_envios       WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM whatsapp_templates    WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM alertas_historico     WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM alertas_config        WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM comissoes_config      WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM fidelidade_movimentos WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM fidelidade_config     WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- API / Webhooks
  BEGIN DELETE FROM empresa_api_keys  WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM webhook_endpoints WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- Catálogo auxiliar
  BEGIN DELETE FROM produto_grades      WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM produto_imagens     WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM produto_atributos   WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM tabelas_preco       WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM marketplace_produtos WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM marketplace_config  WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM nfe_config          WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM nfse_config         WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM kits                WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM filiais             WHERE empresa_id = emp_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- Catálogo principal (por último, sem dependentes)
  DELETE FROM produtos     WHERE empresa_id = emp_id;
  DELETE FROM clientes     WHERE empresa_id = emp_id;
  DELETE FROM fornecedores WHERE empresa_id = emp_id;

  -- ============================================================
  -- 3. Upgrade para premium permanente (sem expiração)
  -- ============================================================
  UPDATE empresas
  SET assinatura_status = 'ativo',
      trial_fim         = NULL,
      bloqueada         = FALSE,
      motivo_bloqueio   = NULL,
      atualizado_em     = NOW()
  WHERE id = emp_id;

  RAISE NOTICE 'Concluído: empresa_id=% zerada e atualizada para premium ativo permanente.', emp_id;
END $$;
