require('dotenv').config();

// Sentry â€” monitoramento de erros em produÃ§Ã£o (C5.3)
const Sentry = require('@sentry/node');
const _sentryDsn = process.env.SENTRY_DSN;
if (_sentryDsn) {
  Sentry.init({
    dsn: _sentryDsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.05,
  });
}

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const { runMigrations } = require('./migrations/runner');
const { requirePermissao } = require('./utils/permissoes');
const {
  hoje,
  normalizarDecimal,
  normalizarInt,
  addDias,
  normalizarDataISO,
  validarItensVenda
} = require('./utils/normalizadores');

const { loginRateLimiter, writeRateLimiter } = require('./middleware/rateLimiter');
const {
  SECRET,
  JWT_EXPIRY_MS,
  tokenBlacklist,
  _tokenHash,
  _sseNonces,
  loadBlacklistFromDb,
  auth,
  apenasAdmin,
  createAuthHelpers,
  validarForcaSenha
} = require('./middleware/auth');
const { createEmpresaUtils }          = require('./utils/empresa');
const { createPlanoUtils, _planoCache } = require('./utils/plano');
const { createFinanceiroOps, _configCache } = require('./utils/financeiroOps');
const { createInitDb }                = require('./db/initDb');


const financeiroRoutes = require('./routes/financeiro.routes');
const relatoriosRoutes = require('./routes/relatorios.routes');
const relatoriosAnaliseRoutes = require('./routes/relatorios-analise.routes');
const comprasRoutes = require('./routes/compras.routes');
const vendasRoutes = require('./routes/vendas.routes');
const produtosRoutes = require('./routes/produtos.routes');
const estoqueRoutes = require('./routes/estoque.routes');
const clientesRoutes = require('./routes/clientes.routes');
const fornecedoresRoutes = require('./routes/fornecedores.routes');
const gradesRoutes = require('./routes/grades.routes');
const nfeRoutes  = require('./routes/nfe.routes');
const nfceRoutes = require('./routes/nfce.routes');
const nfseRoutes = require('./routes/nfse.routes');
const tabelasPrecoRoutes = require('./routes/tabelasPreco.routes');
const kitsRoutes = require('./routes/kits.routes');
const imagensRoutes = require('./routes/imagens.routes');
const orcamentosRoutes = require('./routes/orcamentos.routes');
const pedidosRoutes = require('./routes/pedidos.routes');
const comissoesRoutes = require('./routes/comissoes.routes');
const ordensServicoRoutes = require('./routes/ordensServico.routes');
const portalRoutes    = require('./routes/portal.routes');
const caixaRoutes     = require('./routes/caixa.routes');
const devolucoesRoutes = require('./routes/devolucoes.routes');
const alertasRoutes      = require('./routes/alertas.routes');
const marketplaceRoutes  = require('./routes/marketplace.routes');
const crmRoutes          = require('./routes/crm.routes');
const exportacaoRoutes   = require('./routes/exportacao.routes');
const apiPublicaRoutes   = require('./routes/api-publica.routes');
const webhooksRoutes         = require('./routes/webhooks.routes');
const rastreabilidadeRoutes  = require('./routes/rastreabilidade.routes');
const whatsappRoutes         = require('./routes/whatsapp.routes');
const fidelidadeRoutes       = require('./routes/fidelidade.routes');
const checkoutRoutes         = require('./routes/checkout.routes');
const filiaisRoutes          = require('./routes/filiais.routes');
const biRoutes               = require('./routes/bi.routes');
const authRoutes             = require('./routes/auth.routes');
const usuariosRoutes         = require('./routes/usuarios.routes');
const contasReceberRoutes    = require('./routes/contas-receber.routes');
const contasPagarRoutes      = require('./routes/contas-pagar.routes');
const lancamentosRoutes      = require('./routes/lancamentos.routes');
const fluxoCaixaRoutes       = require('./routes/fluxo-caixa.routes');
const dashboardRoutes        = require('./routes/dashboard.routes');
const pagamentosRoutes        = require('./routes/pagamentos.routes');
const conciliacaoRoutes        = require('./routes/conciliacao.routes');
const adminRoutes              = require('./routes/admin.routes');
const miscRoutes               = require('./routes/misc.routes');
const metasRoutes              = require('./routes/metas.routes');
const depositosRoutes          = require('./routes/depositos.routes');
const notificacoesRoutes       = require('./routes/notificacoes.routes');
const adminSaasRoutes          = require('./routes/admin-saas.routes');

const app = express();
app.set('trust proxy', 1); // S-0: Render usa proxy reverso Ã¢â‚¬â€ necessÃƒÂ¡rio para req.ip correto no rate limiter

// S-1: CORS Ã¢â‚¬â€ default seguro; sem ALLOWED_ORIGINS usa o domÃƒÂ­nio Vercel conhecido
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['https://lf-erp-frontend.vercel.app'];
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));
const jsonUpload = express.json({ limit: '50mb' }); // usado sÃƒÂ³ em rotas de importaÃƒÂ§ÃƒÂ£o

app.disable('x-powered-by');

// S-2: Headers de seguranÃƒÂ§a HTTP + redirect HTTPS em produÃƒÂ§ÃƒÂ£o
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.header('x-forwarded-proto') === 'http') {
      return res.redirect(301, `https://${req.header('host')}${req.url}`);
    }
  }
  next();
});

app.use((req, res, next) => {
  const inicio = Date.now();

  res.on('finish', () => {
    const duracao = Date.now() - inicio;

    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duracao}ms`
    );
  });

  next();
});

const PORT = process.env.PORT || 3001;

if (!SECRET) {
  console.error('JWT_SECRET nÃƒÂ£o definida.');
  process.exit(1);
}
if (SECRET.length < 32) {
  console.error('JWT_SECRET muito curta (mÃƒÂ­nimo 32 caracteres). Configure uma chave segura em produÃƒÂ§ÃƒÂ£o.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL nÃƒÂ£o definida.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: true } : false,
  max: 10,
  min: 0,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000, // FIX 4: mata queries lentas antes de exaurir o pool
  query_timeout: 35_000      // FIX 4: timeout do driver (superior ao statement_timeout)
});

// Neon derruba conexÃµes idle â€” sem este handler o processo encerra com uncaughtException
pool.on('error', (err) => {
  console.error('[pool] erro em conexÃ£o idle (Neon dropped connection):', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason, promise);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

const { validarSenhaUsuario } = createAuthHelpers(pool);

const {
  obterEmpresaPorId, obterEmpresaPorNome, resolverEmpresaRequest,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  podeGerenciarUsuarios, podeGerenciarFinanceiro, podeGerenciarCompras, podeGerenciarVendas
} = createEmpresaUtils(pool);

const { obterPlanoEmpresa, validarLimitePlano, validarLimiteVendasMes } =
  createPlanoUtils(pool, { hoje });

const {
  obterConfigEmpresa,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasReceberGlobal,
  atualizarStatusContasPagarPorEmpresa,
  atualizarStatusContasPagarGlobal,
  agendarAtualizacaoNoturna,
  criarParcelasContasReceber,
  registrarMovimentacaoEstoque,
  registrarAuditoria,
  registrarLogFinanceiro
} = createFinanceiroOps(pool, { hoje, normalizarDecimal, normalizarInt, addDias });

const initDb = createInitDb(pool, {
  hoje,
  addDias,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa
});

// Disponibiliza pool para middlewares via app.locals
app.locals.pool = pool;

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', sistema: 'LF ERP', database: 'online' });
  } catch (error) {
    console.error('Erro no health check:', error);
    res.status(500).json({ status: 'erro', sistema: 'LF ERP', database: 'offline' });
  }
});

app.use(
  '/financeiro',
  financeiroRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    atualizarStatusContasReceberPorEmpresa,
    atualizarStatusContasPagarPorEmpresa
  })
);

app.use(
  '/relatorios',
  relatoriosRoutes({
    auth,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    atualizarStatusContasReceberPorEmpresa,
    atualizarStatusContasPagarPorEmpresa,
    podeGerenciarFinanceiro
  })
);

app.use(
  '/relatorios',
  relatoriosAnaliseRoutes({
    auth,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    atualizarStatusContasReceberPorEmpresa,
    atualizarStatusContasPagarPorEmpresa,
    podeGerenciarFinanceiro
  })
);

app.use(
  '/compras',
  comprasRoutes({
    auth,
    pool,
    writeRateLimiter,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    podeGerenciarCompras,
    registrarAuditoria,
    registrarMovimentacaoEstoque,
    atualizarStatusContasPagarPorEmpresa
  })
);

app.use(
  '/vendas',
  vendasRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    podeGerenciarVendas,
    validarLimiteVendasMes,
    normalizarDecimal,
    normalizarInt,
    normalizarDataISO,
    hoje,
    registrarMovimentacaoEstoque,
    criarParcelasContasReceber,
    atualizarStatusContasReceberPorEmpresa,
    adicionarFiltroEmpresaSaaS,
    registrarAuditoria,
    validarItensVenda
  })
);

app.use(
  '/produtos',
  produtosRoutes({
    auth,
    writeRateLimiter,
    apenasAdmin,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    validarLimitePlano,
    normalizarDecimal,
    registrarAuditoria,
    normalizarInt,
    registrarMovimentacaoEstoque
  })
);

app.use(
  '/estoque',
  estoqueRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    normalizarInt,
    registrarMovimentacaoEstoque
  })
);

app.use(
  '/clientes',
  clientesRoutes({
    auth,
    writeRateLimiter,
    apenasAdmin,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    registrarAuditoria,
    validarLimitePlano
  })
);

app.use(
  '/fornecedores',
  fornecedoresRoutes({
    auth,
    writeRateLimiter,
    apenasAdmin,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    registrarAuditoria,
    validarLimitePlano
  })
);

app.use(
  '/grades',
  gradesRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt,
    registrarMovimentacaoEstoque,
    requirePermissao
  })
);

app.use('/portal', portalRoutes({ auth, writeRateLimiter, pool }));
app.use('/caixa',      caixaRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal }));
app.use('/alertas',    alertasRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa }));
app.use('/marketplace', marketplaceRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, normalizarDataISO, hoje, registrarMovimentacaoEstoque, criarParcelasContasReceber }));
app.use('/crm', crmRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, normalizarDataISO, hoje }));
app.use('/exportacao', exportacaoRoutes({ auth, pool, validarAcessoEmpresa, normalizarDecimal, hoje }));
app.use('/api/v1',    apiPublicaRoutes({ pool, writeRateLimiter, normalizarDecimal, normalizarInt, hoje, registrarMovimentacaoEstoque }));
app.use('/webhooks',         webhooksRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa }));
app.use('/rastreabilidade', rastreabilidadeRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarInt, normalizarDataISO, hoje, requirePermissao }));
app.use('/whatsapp',       whatsappRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, hoje, requirePermissao }));
app.use('/fidelidade',    fidelidadeRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, hoje, requirePermissao }));
app.use('/checkout',     checkoutRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, hoje }));
app.use('/filiais',     filiaisRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, hoje }));
app.use('/bi',         biRoutes({ auth, pool, validarAcessoEmpresa, hoje, requirePermissao }));
app.use('/devolucoes', devolucoesRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, registrarMovimentacaoEstoque }));

app.use('/nfce', nfceRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, requirePermissao }));
app.use('/nfse', nfseRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, requirePermissao }));

app.use(
  '/nfe',
  nfeRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    requirePermissao
  })
);

app.use(
  '/imagens',
  imagensRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarInt
  })
);

app.use(
  '/kits',
  kitsRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt
  })
);

app.use(
  '/orcamentos',
  orcamentosRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt,
    normalizarDataISO,
    requirePermissao
  })
);

app.use(
  '/pedidos',
  pedidosRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt,
    normalizarDataISO,
    registrarMovimentacaoEstoque,
    criarParcelasContasReceber,
    atualizarStatusContasReceberPorEmpresa,
    atualizarStatusContasPagarPorEmpresa,
    registrarAuditoria,
    requirePermissao
  })
);

app.use(
  '/comissoes',
  comissoesRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarDataISO
  })
);

app.use(
  '/ordens-servico',
  ordensServicoRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt,
    normalizarDataISO
  })
);

app.use(
  '/tabelas-preco',
  tabelasPrecoRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt
  })
);




app.get('/', (req, res) => {
  res.send('LF ERP backend online Ã°Å¸Å¡â‚¬');
});


// Ã¢â€â‚¬Ã¢â€â‚¬ Auth (login/logout/me/registro) Ã¢â€ â€™ routes/auth.routes.js
app.use('/', authRoutes({
  auth,
  writeRateLimiter,
  loginRateLimiter,
  pool,
  validarAcessoEmpresa,
  tokenBlacklist,
  _sseNonces,
  _tokenHash,
  JWT_EXPIRY_MS,
  validarSenhaUsuario,
  validarForcaSenha,
  registrarAuditoria,
  SECRET,
}));

// Ã¢â€â‚¬Ã¢â€â‚¬ UsuÃƒÂ¡rios, permissÃƒÂµes e lixeira Ã¢â€ â€™ routes/usuarios.routes.js
app.use('/', usuariosRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  validarLimitePlano,
  validarForcaSenha,
  requirePermissao,
  registrarAuditoria,
}));

// Ã¢â€â‚¬Ã¢â€â‚¬ Contas a Receber Ã¢â€ â€™ routes/contas-receber.routes.js
app.use('/', contasReceberRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  atualizarStatusContasReceberPorEmpresa,
  podeGerenciarFinanceiro,
  registrarLogFinanceiro,
}));

// Ã¢â€â‚¬Ã¢â€â‚¬ Contas a Pagar Ã¢â€ â€™ routes/contas-pagar.routes.js
app.use('/', contasPagarRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  atualizarStatusContasPagarPorEmpresa,
  registrarLogFinanceiro,
}));

// Ã¢â€â‚¬Ã¢â€â‚¬ LanÃƒÂ§amentos Financeiros Ã¢â€ â€™ routes/lancamentos.routes.js
app.use('/', lancamentosRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  podeGerenciarFinanceiro,
  atualizarStatusContasReceberPorEmpresa,
  registrarLogFinanceiro,
}));

// Ã¢â€â‚¬Ã¢â€â‚¬ Fluxo de Caixa + Investimentos Ã¢â€ â€™ routes/fluxo-caixa.routes.js
app.use('/', fluxoCaixaRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  podeGerenciarFinanceiro,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa,
}));

// Ã¢â€â‚¬Ã¢â€â‚¬ Dashboard Ã¢â€ â€™ routes/dashboard.routes.js
app.use('/', dashboardRoutes({
  auth,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa,
}));

// -- Pagamentos (PIX + Boleto) -> routes/pagamentos.routes.js
app.use('/', pagamentosRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
}));

// -- ConciliaÃƒÂ§ÃƒÂ£o BancÃƒÂ¡ria -> routes/conciliacao.routes.js
app.use('/', conciliacaoRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
  jsonUpload
}));

// -- Admin (ConfiguraÃƒÂ§ÃƒÂµes + Alertas + Billing + Admin) -> routes/admin.routes.js
app.use('/', adminRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
  apenasAdmin, _configCache, _planoCache,
}));

// -- Misc (Compras inline) -> routes/misc.routes.js
app.use('/', miscRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  podeGerenciarFinanceiro, podeGerenciarCompras,
  atualizarStatusContasPagarPorEmpresa,
}));

// -- Metas de Vendas -> routes/metas.routes.js
app.use('/', metasRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
}));

// -- Depositos + LGPD -> routes/depositos.routes.js
app.use('/', depositosRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
}));

// -- Notificações + SSE -> routes/notificacoes.routes.js
app.use('/', notificacoesRoutes({
  auth, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
}));

// -- Admin SaaS Owner (SMTP + Dashboard + Empresas) -> routes/admin-saas.routes.js
app.use('/', adminSaasRoutes({
  auth, writeRateLimiter, pool,
  apenasAdmin, _planoCache, _configCache,
}));



// ================= START =================
async function start() {
  try {
    await initDb();
    await runMigrations(pool);
    await loadBlacklistFromDb(pool);
    if (_sentryDsn) Sentry.setupExpressErrorHandler(app);
    app.listen(PORT, () => {
      console.log(`LF ERP Backend Online Ã°Å¸Å¡â‚¬ porta ${PORT}`);
      agendarAtualizacaoNoturna();
    });
  } catch (error) {
    console.error('Erro ao iniciar backend:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
} else {
  // Permite que testes importem o app sem iniciar o servidor
  module.exports = { app };
}




