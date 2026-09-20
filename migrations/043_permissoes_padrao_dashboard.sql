-- Migration 043 — Completa permissoes_padrao com módulos ausentes
-- dashboard, caixa e devolucoes não constavam no seed original de 003_permissoes.sql

INSERT INTO permissoes_padrao (tipo_usuario, modulo, pode_ver, pode_criar, pode_editar, pode_deletar) VALUES
  ('gerente',     'dashboard',  true,  false, false, false),
  ('gerente',     'caixa',      true,  true,  true,  false),
  ('gerente',     'devolucoes', true,  true,  false, false),
  ('gerente',     'comissoes',  true,  false, false, false),
  ('gerente',     'orcamentos', true,  true,  true,  false),
  ('gerente',     'pedidos',    true,  true,  true,  false),
  ('gerente',     'alertas',    true,  false, false, false),
  ('funcionario', 'dashboard',  true,  false, false, false),
  ('funcionario', 'caixa',      true,  true,  false, false),
  ('funcionario', 'devolucoes', true,  true,  false, false),
  ('funcionario', 'orcamentos', true,  true,  false, false),
  ('funcionario', 'pedidos',    true,  false, false, false)
ON CONFLICT (tipo_usuario, modulo) DO NOTHING;
