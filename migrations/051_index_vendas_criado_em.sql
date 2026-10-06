-- Achado PERF-01 da Auditoria 360 (2026-10-06): o dashboard do SaaS Owner
-- (GET /admin/dashboard, backend/routes/admin-saas.routes.js) agrega a tabela
-- vendas inteira (todas as empresas, por design -- é uma métrica cross-tenant)
-- filtrando só por `criado_em >= NOW() - 30 dias`. Os índices existentes em
-- vendas são todos compostos com empresa (empresa_id, data) e não ajudam essa
-- query. Índice dedicado e leve (sem CONCURRENTLY -- roda dentro da transação
-- do migration runner).
CREATE INDEX IF NOT EXISTS idx_vendas_criado_em ON vendas (criado_em);
