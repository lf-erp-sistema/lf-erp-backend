'use strict';

const bcrypt = require('bcrypt');

function createInitDb(pool, { hoje, addDias, atualizarStatusContasReceberPorEmpresa, atualizarStatusContasPagarPorEmpresa }) {
  return async function initDb() {
    // Fast-path: banco já inicializado → pula as ~168 queries DDL (cold start 8–15s → <1s)
    //
    // ⚠️ ATENÇÃO: todo o DDL abaixo (CREATE/ALTER TABLE) só roda em banco VAZIO.
    // Em produção, com a tabela `empresas` já existente, este bloco NUNCA executa.
    // Portanto NUNCA adicione colunas/tabelas novas aqui — elas não chegarão em
    // produção. Toda mudança de schema deve ir em backend/migrations/ (numerada),
    // que é o único caminho que roda sobre o banco existente.
    // (Ex. de bug causado por ignorar isto: `valor_original` foi adicionado aqui e
    //  nunca existiu em produção, quebrando a baixa de contas a receber.)
    const { rows: _chk } = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='empresas' LIMIT 1"
    );
    if (_chk.length > 0) return;

    // ================= EMPRESAS / PLANOS / CONFIGURAÇÕES =================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS empresas (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        cnpj TEXT,
        telefone TEXT,
        email TEXT,
        plano TEXT DEFAULT 'free',
        status TEXT DEFAULT 'ativo',
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE empresas ADD COLUMN IF NOT EXISTS plano_id INTEGER;
      ALTER TABLE empresas ADD COLUMN IF NOT EXISTS slug TEXT;
      ALTER TABLE empresas ADD COLUMN IF NOT EXISTS responsavel_nome TEXT;
      ALTER TABLE empresas ADD COLUMN IF NOT EXISTS responsavel_email TEXT;
      ALTER TABLE empresas ADD COLUMN IF NOT EXISTS assinatura_status TEXT DEFAULT 'trial';
      ALTER TABLE empresas ADD COLUMN IF NOT EXISTS trial_inicio TEXT;
      ALTER TABLE empresas ADD COLUMN IF NOT EXISTS trial_fim TEXT;
      ALTER TABLE empresas ADD COLUMN IF NOT EXISTS bloqueada BOOLEAN DEFAULT FALSE;
      ALTER TABLE empresas ADD COLUMN IF NOT EXISTS motivo_bloqueio TEXT;
      ALTER TABLE empresas ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP DEFAULT NOW();
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS planos (
        id SERIAL PRIMARY KEY,
        codigo TEXT UNIQUE NOT NULL,
        nome TEXT NOT NULL,
        descricao TEXT,
        preco_mensal NUMERIC(12,2) NOT NULL DEFAULT 0,
        limite_usuarios INTEGER NOT NULL DEFAULT 1,
        limite_produtos INTEGER NOT NULL DEFAULT 100,
        limite_clientes INTEGER NOT NULL DEFAULT 300,
        limite_fornecedores INTEGER NOT NULL DEFAULT 100,
        limite_vendas_mes INTEGER NOT NULL DEFAULT 300,
        limite_empresas INTEGER NOT NULL DEFAULT 1,
        permite_multiusuarios BOOLEAN NOT NULL DEFAULT TRUE,
        permite_relatorios_avancados BOOLEAN NOT NULL DEFAULT FALSE,
        permite_suporte_prioritario BOOLEAN NOT NULL DEFAULT FALSE,
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      INSERT INTO planos
      (
        codigo,
        nome,
        descricao,
        preco_mensal,
        limite_usuarios,
        limite_produtos,
        limite_clientes,
        limite_fornecedores,
        limite_vendas_mes,
        limite_empresas,
        permite_multiusuarios,
        permite_relatorios_avancados,
        permite_suporte_prioritario
      )
      VALUES
      ('starter', 'Starter', 'Plano inicial para pequenos negócios', 49.90, 2, 300, 500, 100, 500, 1, TRUE, FALSE, FALSE),
      ('pro', 'Pro', 'Plano profissional para empresas em crescimento', 99.90, 5, 2000, 3000, 500, 3000, 1, TRUE, TRUE, FALSE),
      ('premium', 'Premium', 'Plano completo para operação avançada', 199.90, 15, 10000, 20000, 2000, 15000, 3, TRUE, TRUE, TRUE)
      ON CONFLICT (codigo) DO NOTHING;
    `);

    // ================= TABELAS PRINCIPAIS =================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        usuario TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL,
        tipo TEXT NOT NULL,
        empresa TEXT,
        nome_completo TEXT,
        cpf TEXT,
        nascimento TEXT,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS produtos (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        nome TEXT NOT NULL,
        preco NUMERIC(12,2) NOT NULL DEFAULT 0,
        custo NUMERIC(12,2) NOT NULL DEFAULT 0,
        estoque INTEGER NOT NULL DEFAULT 0,
        estoque_minimo INTEGER NOT NULL DEFAULT 0,
        codigo_barras TEXT,
        categoria TEXT,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        nome TEXT NOT NULL,
        endereco TEXT,
        telefone TEXT,
        nascimento TEXT,
        cpf TEXT,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fornecedores (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        nome TEXT NOT NULL,
        contato TEXT,
        telefone TEXT,
        email TEXT,
        endereco TEXT,
        observacao TEXT,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS compras (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        fornecedor_id INTEGER NOT NULL,
        data TEXT NOT NULL,
        total NUMERIC(12,2) NOT NULL DEFAULT 0,
        observacao TEXT,
        gerar_conta_pagar BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'finalizada',
        criado_por INTEGER,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS compra_itens (
        id SERIAL PRIMARY KEY,
        compra_id INTEGER NOT NULL,
        produto_id INTEGER NOT NULL,
        produto_nome TEXT NOT NULL,
        quantidade INTEGER NOT NULL DEFAULT 0,
        custo_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
        subtotal NUMERIC(12,2) NOT NULL DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendas (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        cliente_id INTEGER,
        cliente_nome TEXT,
        subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
        desconto NUMERIC(12,2) NOT NULL DEFAULT 0,
        acrescimo NUMERIC(12,2) NOT NULL DEFAULT 0,
        total NUMERIC(12,2) NOT NULL DEFAULT 0,
        pagamento TEXT,
        parcelas INTEGER NOT NULL DEFAULT 1,
        status_pagamento TEXT NOT NULL DEFAULT 'pago',
        data TEXT,
        observacao TEXT,
        criado_por INTEGER,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS venda_itens (
        id SERIAL PRIMARY KEY,
        venda_id INTEGER NOT NULL,
        empresa TEXT NOT NULL,
        produto_id INTEGER NOT NULL,
        produto_nome TEXT NOT NULL,
        quantidade INTEGER NOT NULL DEFAULT 0,
        preco_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
        custo_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
        total NUMERIC(12,2) NOT NULL DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        produto_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        quantidade INTEGER NOT NULL DEFAULT 0,
        observacao TEXT,
        referencia_tipo TEXT,
        referencia_id INTEGER,
        usuario_id INTEGER,
        data_movimentacao TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lancamentos_financeiros (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        tipo TEXT NOT NULL,
        categoria TEXT NOT NULL,
        descricao TEXT NOT NULL,
        valor NUMERIC(12,2) NOT NULL DEFAULT 0,
        vencimento TEXT,
        pagamento_data TEXT,
        status TEXT NOT NULL DEFAULT 'pendente',
        forma_pagamento TEXT,
        recorrente BOOLEAN NOT NULL DEFAULT FALSE,
        frequencia TEXT,
        observacao TEXT,
        criado_por INTEGER,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS investimentos (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        tipo_investimento TEXT NOT NULL,
        descricao TEXT NOT NULL,
        valor NUMERIC(12,2) NOT NULL DEFAULT 0,
        data TEXT NOT NULL,
        forma_pagamento TEXT,
        observacao TEXT,
        criado_por INTEGER,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS contas_receber (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        venda_id INTEGER,
        cliente_id INTEGER,
        cliente_nome TEXT,
        parcela INTEGER NOT NULL DEFAULT 1,
        total_parcelas INTEGER NOT NULL DEFAULT 1,
        valor NUMERIC(12,2) NOT NULL DEFAULT 0,
        data_vencimento TEXT,
        data_pagamento TEXT,
        status TEXT NOT NULL DEFAULT 'pendente',
        forma_pagamento TEXT,
        observacao TEXT,
        criado_por INTEGER,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS contas_pagar (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        fornecedor_id INTEGER,
        fornecedor_nome TEXT,
        compra_id INTEGER,
        descricao TEXT NOT NULL,
        parcela INTEGER NOT NULL DEFAULT 1,
        total_parcelas INTEGER NOT NULL DEFAULT 1,
        valor NUMERIC(12,2) NOT NULL DEFAULT 0,
        data_vencimento TEXT,
        data_pagamento TEXT,
        status TEXT NOT NULL DEFAULT 'pendente',
        forma_pagamento TEXT,
        observacao TEXT,
        criado_por INTEGER,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuracoes (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL UNIQUE,
        empresa_id INTEGER,
        nome_empresa TEXT,
        cnpj TEXT,
        telefone TEXT,
        email TEXT,
        endereco TEXT,
        logo_url TEXT,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS logs_auditoria (
        id SERIAL PRIMARY KEY,
        empresa TEXT,
        empresa_id INTEGER,
        usuario_id INTEGER,
        usuario_nome TEXT,
        modulo TEXT NOT NULL,
        acao TEXT NOT NULL,
        referencia_id INTEGER,
        dados_anteriores JSONB,
        dados_novos JSONB,
        ip TEXT,
        user_agent TEXT,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS financeiro_logs (
        id SERIAL PRIMARY KEY,
        empresa TEXT,
        empresa_id INTEGER,
        tipo TEXT NOT NULL,
        entidade TEXT,
        entidade_id INTEGER,
        descricao TEXT,
        valor NUMERIC(12,2),
        usuario_id INTEGER,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS conciliacoes (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        empresa_id INTEGER,
        nome TEXT NOT NULL,
        tipo TEXT NOT NULL,
        conta TEXT,
        data_inicio DATE,
        data_fim DATE,
        total_itens INTEGER DEFAULT 0,
        itens_conciliados INTEGER DEFAULT 0,
        itens_ignorados INTEGER DEFAULT 0,
        status TEXT DEFAULT 'em_andamento',
        criado_em TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS nfce_emissoes (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER,
        venda_id INTEGER,
        ref TEXT UNIQUE NOT NULL,
        ambiente INTEGER DEFAULT 2,
        status TEXT DEFAULT 'processando',
        chave_nfe TEXT,
        numero INTEGER,
        serie TEXT,
        mensagem TEXT,
        cancelado_em TIMESTAMPTZ,
        motivo_cancelamento TEXT,
        criado_em TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS cobrancas_pix (
        id SERIAL PRIMARY KEY,
        empresa TEXT,
        empresa_id INTEGER,
        conta_receber_id INTEGER,
        txid TEXT UNIQUE,
        valor NUMERIC(12,2),
        cliente_nome TEXT,
        status TEXT DEFAULT 'ATIVA',
        pix_copia_e_cola TEXT,
        qr_image TEXT,
        expiracao TIMESTAMPTZ,
        pago_em TIMESTAMPTZ,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS conciliacao_itens (
        id SERIAL PRIMARY KEY,
        conciliacao_id INTEGER NOT NULL,
        empresa TEXT,
        empresa_id INTEGER,
        fitid TEXT,
        data DATE,
        descricao TEXT,
        valor NUMERIC(12,2),
        tipo TEXT,
        status TEXT DEFAULT 'pendente',
        lancamento_id INTEGER,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ================= ALTERAÇÕES / COLUNAS =================
    await pool.query(`
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
      ALTER TABLE clientes ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
      ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
      ALTER TABLE compras ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
      ALTER TABLE compras ADD COLUMN IF NOT EXISTS pagamento TEXT;
      ALTER TABLE vendas ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
      ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
      ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
      ALTER TABLE investimentos ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    `);

    await pool.query(`
      ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS cnpj TEXT;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque_minimo INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS codigo_barras TEXT;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS categoria TEXT;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();

      ALTER TABLE vendas ADD COLUMN IF NOT EXISTS cliente_id INTEGER;
      ALTER TABLE vendas ADD COLUMN IF NOT EXISTS total_itens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vendas ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE vendas ADD COLUMN IF NOT EXISTS desconto NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE vendas ADD COLUMN IF NOT EXISTS acrescimo NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE vendas ADD COLUMN IF NOT EXISTS parcelas INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE vendas ADD COLUMN IF NOT EXISTS status_pagamento TEXT NOT NULL DEFAULT 'pago';
      ALTER TABLE vendas ADD COLUMN IF NOT EXISTS observacao TEXT;
      ALTER TABLE vendas ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();

      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nome_completo TEXT;
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cpf TEXT;
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nascimento TEXT;
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS is_saas_owner BOOLEAN NOT NULL DEFAULT FALSE;

      ALTER TABLE clientes ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
      ALTER TABLE clientes ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();

      ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
      ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();

      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS nome_empresa TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS cnpj TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS telefone TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS endereco TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS logo_url TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS cor_primaria TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS taxa_multa NUMERIC(8,4) NOT NULL DEFAULT 0.02;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS taxa_juros_dia NUMERIC(8,6) NOT NULL DEFAULT 0.00033;
    `);

    await pool.query(`
      ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
      ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS conta_receber_id INTEGER;
      ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS conta_pagar_id INTEGER;
    `);

    await pool.query(`
      ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS valor_original    NUMERIC(12,2);
      ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS valor_atualizado  NUMERIC(12,2);
      ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS dias_atraso       INTEGER DEFAULT 0;
      ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS multa             NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS juros             NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE contas_pagar   ADD COLUMN IF NOT EXISTS valor_original    NUMERIC(12,2);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS nfe_config (
        id         SERIAL PRIMARY KEY,
        empresa_id INTEGER UNIQUE,
        token_focusnfe TEXT,
        ambiente   INTEGER DEFAULT 2,
        serie      TEXT DEFAULT '1',
        codigo_csc TEXT,
        id_token_csc TEXT,
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      ALTER TABLE nfe_config ADD COLUMN IF NOT EXISTS codigo_csc   TEXT;
      ALTER TABLE nfe_config ADD COLUMN IF NOT EXISTS id_token_csc TEXT;
    `);

    await pool.query(`
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_gateway TEXT DEFAULT 'efi';
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_client_id TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_client_secret TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_certificado TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_chave TEXT;
      ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_sandbox BOOLEAN DEFAULT TRUE;
    `);

    // ================= EMPRESA PADRÃO =================
    const empresaSaaSResult = await pool.query(
      `SELECT id FROM empresas WHERE nome = $1 LIMIT 1`,
      ['LF ERP']
    );

    let empresaSaaSId;

    if (empresaSaaSResult.rowCount === 0) {
      const novaEmpresa = await pool.query(
        `INSERT INTO empresas
        (nome, plano, status, plano_id, assinatura_status, trial_inicio, trial_fim, bloqueada, criado_em, atualizado_em)
        VALUES (
          $1,
          'pro',
          'ativo',
          (SELECT id FROM planos WHERE codigo = 'pro' LIMIT 1),
          'trial',
          $2,
          $3,
          FALSE,
          NOW(),
          NOW()
        )
        RETURNING id`,
        ['LF ERP', hoje(), addDias(hoje(), 14)]
      );

      empresaSaaSId = novaEmpresa.rows[0].id;
    } else {
      empresaSaaSId = empresaSaaSResult.rows[0].id;
    }

    await pool.query(
      `
      UPDATE empresas
      SET plano_id = COALESCE(plano_id, (SELECT id FROM planos WHERE codigo = 'pro' LIMIT 1)),
          assinatura_status = 'ativo',
          trial_fim = NULL,
          bloqueada = FALSE,
          atualizado_em = NOW()
      WHERE id = $1
      `,
      [empresaSaaSId]
    );

    await pool.query(
      `
      INSERT INTO configuracoes (empresa, empresa_id, nome_empresa, criado_em, atualizado_em)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (empresa) DO UPDATE
      SET empresa_id = EXCLUDED.empresa_id,
          nome_empresa = COALESCE(configuracoes.nome_empresa, EXCLUDED.nome_empresa),
          atualizado_em = NOW()
      `,
      ['LF ERP', empresaSaaSId, 'LF ERP']
    );

    // ================= MIGRAÇÃO EMPRESA_ID =================
    await pool.query(`UPDATE usuarios SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
    await pool.query(`UPDATE clientes SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
    await pool.query(`UPDATE fornecedores SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
    await pool.query(`UPDATE produtos SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
    await pool.query(`UPDATE compras SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
    await pool.query(`UPDATE vendas SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
    await pool.query(`UPDATE contas_receber SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
    await pool.query(`UPDATE contas_pagar SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
    await pool.query(`UPDATE configuracoes SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);

    // ================= ÍNDICES =================
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_empresas_plano_id ON empresas (plano_id);
      CREATE INDEX IF NOT EXISTS idx_empresas_status ON empresas (assinatura_status);
      CREATE INDEX IF NOT EXISTS idx_empresas_slug ON empresas (slug);
      CREATE INDEX IF NOT EXISTS idx_planos_codigo ON planos (codigo);

      CREATE INDEX IF NOT EXISTS idx_produtos_empresa ON produtos (empresa);
      CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes (empresa);
      CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa ON fornecedores (empresa);
      CREATE INDEX IF NOT EXISTS idx_compras_empresa ON compras (empresa);
      CREATE INDEX IF NOT EXISTS idx_compra_itens_compra ON compra_itens (compra_id);
      CREATE INDEX IF NOT EXISTS idx_vendas_empresa ON vendas (empresa);
      CREATE INDEX IF NOT EXISTS idx_vendas_empresa_data ON vendas (empresa, data);
      CREATE INDEX IF NOT EXISTS idx_venda_itens_venda ON venda_itens (venda_id);
      CREATE INDEX IF NOT EXISTS idx_venda_itens_empresa ON venda_itens (empresa);
      CREATE INDEX IF NOT EXISTS idx_mov_estoque_empresa ON movimentacoes_estoque (empresa);
      CREATE INDEX IF NOT EXISTS idx_mov_estoque_produto ON movimentacoes_estoque (produto_id);
      CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa ON lancamentos_financeiros (empresa);
      CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_status ON lancamentos_financeiros (empresa, status);
      CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_id ON lancamentos_financeiros (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_lancamentos_conta_receber_id ON lancamentos_financeiros (conta_receber_id);
      CREATE INDEX IF NOT EXISTS idx_investimentos_empresa ON investimentos (empresa);
      CREATE INDEX IF NOT EXISTS idx_investimentos_empresa_id ON investimentos (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_contas_receber_empresa ON contas_receber (empresa);
      CREATE INDEX IF NOT EXISTS idx_contas_receber_status ON contas_receber (empresa, status);
      CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa ON contas_pagar (empresa);
      CREATE INDEX IF NOT EXISTS idx_contas_pagar_status ON contas_pagar (empresa, status);
      CREATE INDEX IF NOT EXISTS idx_configuracoes_empresa ON configuracoes (empresa);
      CREATE INDEX IF NOT EXISTS idx_configuracoes_empresa_id ON configuracoes (empresa_id);

      CREATE INDEX IF NOT EXISTS idx_contas_receber_cliente ON contas_receber (cliente_id);
      CREATE INDEX IF NOT EXISTS idx_contas_receber_vencimento ON contas_receber (empresa, data_vencimento);
      CREATE INDEX IF NOT EXISTS idx_contas_receber_empresa_id ON contas_receber (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_cr_empresa_id_status ON contas_receber (empresa_id, status);
      CREATE INDEX IF NOT EXISTS idx_cr_empresa_id_vencimento ON contas_receber (empresa_id, data_vencimento);
      CREATE INDEX IF NOT EXISTS idx_contas_pagar_fornecedor ON contas_pagar (fornecedor_id);
      CREATE INDEX IF NOT EXISTS idx_contas_pagar_vencimento ON contas_pagar (empresa, data_vencimento);
      CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa_id ON contas_pagar (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_cp_empresa_id_status ON contas_pagar (empresa_id, status);
      CREATE INDEX IF NOT EXISTS idx_cp_empresa_id_vencimento ON contas_pagar (empresa_id, data_vencimento);
      CREATE INDEX IF NOT EXISTS idx_compra_itens_produto ON compra_itens (produto_id);
      CREATE INDEX IF NOT EXISTS idx_venda_itens_produto ON venda_itens (produto_id);
      CREATE INDEX IF NOT EXISTS idx_mov_estoque_data ON movimentacoes_estoque (produto_id, data_movimentacao);
      CREATE INDEX IF NOT EXISTS idx_produtos_empresa_id ON produtos (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_vendas_empresa_id ON vendas (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_vendas_cliente ON vendas (cliente_id);
      CREATE INDEX IF NOT EXISTS idx_compras_empresa_id ON compras (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_venda_itens_empresa_id ON venda_itens (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_compra_itens_empresa_id ON compra_itens (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_logs_auditoria_empresa_id ON logs_auditoria (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_logs_auditoria_criado_em ON logs_auditoria (criado_em DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_auditoria_modulo_acao ON logs_auditoria (modulo, acao);

      -- Índices faltantes adicionados em 2026-06-06
      CREATE INDEX IF NOT EXISTS idx_clientes_empresa_id ON clientes (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa_id ON fornecedores (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_produtos_codigo_barras ON produtos (codigo_barras) WHERE codigo_barras IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_clientes_cpf ON clientes (cpf) WHERE cpf IS NOT NULL AND cpf <> '';
      CREATE INDEX IF NOT EXISTS idx_vendas_empresa_id_data ON vendas (empresa_id, data DESC);
      CREATE INDEX IF NOT EXISTS idx_compras_empresa_id_data ON compras (empresa_id, data DESC);
      CREATE INDEX IF NOT EXISTS idx_produtos_deletado_em ON produtos (empresa_id, deletado_em) WHERE deletado_em IS NULL;
      CREATE INDEX IF NOT EXISTS idx_clientes_deletado_em ON clientes (empresa_id, deletado_em) WHERE deletado_em IS NULL;
      CREATE INDEX IF NOT EXISTS idx_fornecedores_deletado_em ON fornecedores (empresa_id, deletado_em) WHERE deletado_em IS NULL;
      CREATE INDEX IF NOT EXISTS idx_usuarios_usuario_lower ON usuarios (LOWER(usuario));
      CREATE INDEX IF NOT EXISTS idx_usuarios_empresa_id ON usuarios (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_mov_estoque_empresa_id ON movimentacoes_estoque (empresa_id);
      CREATE INDEX IF NOT EXISTS idx_contas_receber_vencimento_id ON contas_receber (empresa_id, data_vencimento);
      CREATE INDEX IF NOT EXISTS idx_contas_pagar_vencimento_id ON contas_pagar (empresa_id, data_vencimento);
      CREATE INDEX IF NOT EXISTS idx_financeiro_logs_empresa_id ON financeiro_logs (empresa_id, criado_em DESC);
      CREATE INDEX IF NOT EXISTS idx_financeiro_logs_tipo ON financeiro_logs (tipo);
    `);

    // ── Permissões granulares ────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permissoes_padrao (
        id          SERIAL PRIMARY KEY,
        tipo_usuario TEXT NOT NULL,
        modulo       TEXT NOT NULL,
        pode_ver     BOOLEAN NOT NULL DEFAULT false,
        pode_criar   BOOLEAN NOT NULL DEFAULT false,
        pode_editar  BOOLEAN NOT NULL DEFAULT false,
        pode_deletar BOOLEAN NOT NULL DEFAULT false,
        UNIQUE(tipo_usuario, modulo)
      );

      CREATE TABLE IF NOT EXISTS permissoes_usuario (
        id          SERIAL PRIMARY KEY,
        usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        empresa_id  INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
        modulo      TEXT NOT NULL,
        pode_ver    BOOLEAN,
        pode_criar  BOOLEAN,
        pode_editar BOOLEAN,
        pode_deletar BOOLEAN,
        UNIQUE(usuario_id, empresa_id, modulo)
      );

      CREATE INDEX IF NOT EXISTS idx_perm_usuario_uid ON permissoes_usuario (usuario_id);
      CREATE INDEX IF NOT EXISTS idx_perm_padrao_tipo ON permissoes_padrao (tipo_usuario);
    `);

    // Defaults por tipo — INSERT OR IGNORE (ON CONFLICT DO NOTHING)
    const defaultsGerente = [
      ['gerente', 'produtos',      true,  true,  true,  false],
      ['gerente', 'clientes',      true,  true,  true,  false],
      ['gerente', 'fornecedores',  true,  true,  true,  false],
      ['gerente', 'compras',       true,  true,  true,  false],
      ['gerente', 'vendas',        true,  true,  true,  false],
      ['gerente', 'estoque',       true,  false, false, false],
      ['gerente', 'financeiro',    true,  true,  true,  false],
      ['gerente', 'relatorios',    true,  false, false, false],
      ['gerente', 'dre',           false, false, false, false],
      ['gerente', 'lucratividade', true,  false, false, false],
      ['gerente', 'usuarios',      false, false, false, false],
      ['gerente', 'configuracoes', false, false, false, false],
    ];
    const defaultsFuncionario = [
      ['funcionario', 'produtos',      true,  false, false, false],
      ['funcionario', 'clientes',      true,  true,  true,  false],
      ['funcionario', 'fornecedores',  true,  false, false, false],
      ['funcionario', 'compras',       true,  false, false, false],
      ['funcionario', 'vendas',        true,  true,  false, false],
      ['funcionario', 'estoque',       true,  false, false, false],
      ['funcionario', 'financeiro',    false, false, false, false],
      ['funcionario', 'relatorios',    false, false, false, false],
      ['funcionario', 'dre',           false, false, false, false],
      ['funcionario', 'lucratividade', false, false, false, false],
      ['funcionario', 'usuarios',      false, false, false, false],
      ['funcionario', 'configuracoes', false, false, false, false],
    ];
    for (const [tipo, modulo, ver, criar, editar, deletar] of [...defaultsGerente, ...defaultsFuncionario]) {
      await pool.query(
        `INSERT INTO permissoes_padrao (tipo_usuario, modulo, pode_ver, pode_criar, pode_editar, pode_deletar)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tipo_usuario, modulo) DO NOTHING`,
        [tipo, modulo, ver, criar, editar, deletar]
      );
    }

    // ================= USUÁRIO SAAS OWNER =================
    const ownerSenhaEnv = process.env.SAAS_OWNER_SENHA;
    if (!ownerSenhaEnv) {
      console.warn('[init] SAAS_OWNER_SENHA não definida — senha do owner não será alterada');
      return;
    }
    const ownerHash = await bcrypt.hash(ownerSenhaEnv, 10);

    // Migra nome antigo 'Lfelipeg' → 'lfelipeg' se existir
    await pool.query(
      `UPDATE usuarios SET usuario = 'lfelipeg', atualizado_em = NOW()
       WHERE LOWER(usuario) = 'lfelipeg' AND usuario != 'lfelipeg'`
    );

    const existing = await pool.query(`SELECT id FROM usuarios WHERE LOWER(usuario) = 'lfelipeg'`);

    if (existing.rowCount === 0) {
      await pool.query(
        `INSERT INTO usuarios
         (usuario, senha, tipo, empresa, empresa_id, nome_completo, cpf, nascimento, is_saas_owner)
         VALUES ($1, $2, 'admin', 'LF ERP', $3, 'Felipe Gomes', '', '', TRUE)`,
        ['lfelipeg', ownerHash, empresaSaaSId]
      );
    } else {
      await pool.query(
        `UPDATE usuarios
         SET senha = $1, tipo = 'admin', empresa = 'LF ERP',
             empresa_id = $2, is_saas_owner = TRUE, atualizado_em = NOW()
         WHERE LOWER(usuario) = 'lfelipeg'`,
        [ownerHash, empresaSaaSId]
      );
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS jwt_blacklist (
        token_hash TEXT PRIMARY KEY,
        revoked_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jwt_blacklist_expires ON jwt_blacklist (expires_at);
    `);

    await pool.query(`
      ALTER TABLE compras ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS compras_idempotency_idx
        ON compras (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);

    try {
      const { rows: _empresasInit } = await pool.query(`SELECT id, nome FROM empresas ORDER BY id`);
      for (const _emp of _empresasInit) {
        await atualizarStatusContasReceberPorEmpresa(_emp.nome, _emp.id)
          .catch(e => console.error('[initDb] status-cr:', e.message));
        await atualizarStatusContasPagarPorEmpresa(_emp.nome, _emp.id)
          .catch(e => console.error('[initDb] status-cp:', e.message));
      }
    } catch (e) { console.error('[initDb] status-global:', e.message); }
  };
}

module.exports = { createInitDb };
