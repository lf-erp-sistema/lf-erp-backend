const { requirePermissao } = require('../utils/permissoes');
const { erro, ok } = require('../utils/routeHelpers');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');
const { validarCpf } = require('../utils/documentos');

module.exports = ({
  auth,
  writeRateLimiter,
  apenasAdmin,
  pool,
  validarAcessoEmpresa,
  validarLimitePlano,
  registrarAuditoria
}) => {
  const router = require('express').Router();



  function normalizarCliente(row) {
    return {
      ...row,
      id: Number(row.id || 0),
      empresa_id: row.empresa_id ? Number(row.empresa_id) : null
    };
  }

  // ================= CLIENTES =================

  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'clientes', 'criar'), async (req, res) => {
    try {
      const { empresa, nome, endereco, telefone, nascimento, cpf } = req.body;

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do cliente');
      }

      if (cpf && !validarCpf(cpf)) {
        return erro(res, 400, 'CPF inválido. Verifique os dígitos informados.');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const limitePlano = await validarLimitePlano({
        empresaResolvida,
        recurso: 'clientes'
      });

      if (!limitePlano.permitido) {
        return erro(res, 403, limitePlano.mensagem);
      }

      const result = await pool.query(
        `INSERT INTO clientes
        (empresa, empresa_id, nome, endereco, telefone, nascimento, cpf, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING id`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          nome,
          (endereco || '').trim() || null,
          (telefone || '').trim() || null,
          (nascimento || '').trim() || null,
          cpf || null
        ]
      );

      const clienteId = result.rows[0].id;

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'clientes',
        acao: 'cadastro',
        referencia_id: clienteId,
        dados_novos: {
          nome,
          endereco,
          telefone,
          nascimento,
          cpf
        },
        req
      });

      return ok(res, {
        id: clienteId,
        dados: {
          id: clienteId
        }
      });
    } catch (error) {
      console.error('Erro ao cadastrar cliente:', error.message);
      return erro(res, 500, 'Erro ao cadastrar cliente');
    }
  });

  // ── GET /clientes/segmentacao-abc ─────────────────────────────────────────
  // ── Extrato financeiro do cliente ────────────────────────────────────────────
  router.get('/:id/extrato', auth, requirePermissao(pool, 'clientes', 'ver'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return erro(res, 400, 'Cliente inválido');

      const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const clienteResult = await pool.query(
        `SELECT id, nome, telefone, cpf, cpf_cnpj, email, endereco
         FROM clientes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (clienteResult.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');

      const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

      const [parcelasResult, resumoResult] = await Promise.all([
        pool.query(
          `SELECT
             cr.id, cr.venda_id, cr.parcela, cr.total_parcelas,
             cr.valor, cr.valor_atualizado, cr.multa, cr.juros, cr.dias_atraso,
             cr.data_vencimento, cr.data_pagamento, cr.forma_pagamento, cr.observacao,
             CASE
               WHEN LOWER(COALESCE(cr.status,'pendente')) = 'pago' THEN 'pago'
               WHEN LOWER(COALESCE(cr.status,'pendente')) IN ('parcial','parcial_atrasado')
                    AND cr.data_vencimento < $3 THEN 'parcial_atrasado'
               WHEN LOWER(COALESCE(cr.status,'pendente')) = 'parcial' THEN 'parcial'
               WHEN cr.data_vencimento IS NOT NULL AND cr.data_vencimento < $3 THEN 'atrasado'
               ELSE 'pendente'
             END AS status_calc
           FROM contas_receber cr
           WHERE cr.cliente_id = $1
             AND (cr.empresa_id = $2 OR (cr.empresa_id IS NULL AND cr.empresa = $4))
           ORDER BY
             CASE WHEN LOWER(COALESCE(cr.status,'pendente')) = 'pago' THEN 1 ELSE 0 END,
             cr.data_vencimento ASC`,
          [id, empresaResolvida.id, hoje, empresaResolvida.nome]
        ),
        pool.query(
          `SELECT
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(status,'pendente')) NOT IN ('pago') THEN COALESCE(valor_atualizado, valor) ELSE 0 END), 0) AS total_aberto,
             COALESCE(SUM(CASE WHEN data_vencimento < $3 AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago') THEN COALESCE(valor_atualizado, valor) ELSE 0 END), 0) AS total_atrasado,
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(status,'pendente')) = 'pago' THEN valor ELSE 0 END), 0) AS total_pago,
             COALESCE(SUM(CASE WHEN LOWER(COALESCE(status,'pendente')) IN ('parcial','parcial_atrasado') THEN COALESCE(valor_atualizado, valor) ELSE 0 END), 0) AS total_parcial,
             COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'pendente')) NOT IN ('pago')) AS qtd_pendente,
             COUNT(*) AS qtd_total
           FROM contas_receber
           WHERE cliente_id = $1
             AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $4))`,
          [id, empresaResolvida.id, hoje, empresaResolvida.nome]
        )
      ]);

      const resumo = resumoResult.rows[0];

      return ok(res, {
        cliente: clienteResult.rows[0],
        resumo: {
          total_aberto:   Number(resumo.total_aberto   || 0),
          total_atrasado: Number(resumo.total_atrasado || 0),
          total_pago:     Number(resumo.total_pago     || 0),
          total_parcial:  Number(resumo.total_parcial  || 0),
          qtd_pendente:   Number(resumo.qtd_pendente   || 0),
          qtd_total:      Number(resumo.qtd_total      || 0)
        },
        parcelas: parcelasResult.rows.map((p) => ({
          ...p,
          valor:            Number(p.valor            || 0),
          valor_atualizado: Number(p.valor_atualizado || p.valor || 0),
          multa:            Number(p.multa            || 0),
          juros:            Number(p.juros            || 0),
          dias_atraso:      Number(p.dias_atraso      || 0),
          status:           p.status_calc
        }))
      });
    } catch (err) {
      console.error('[clientes] GET extrato:', err.message);
      return erro(res, 500, 'Erro ao carregar extrato do cliente');
    }
  });

  // Classifica clientes em A, B ou C pela Curva de Pareto:
  //   A = responsáveis pelos primeiros 80% da receita acumulada
  //   B = entre 80% e 95%
  //   C = abaixo de 95%

  router.get('/segmentacao-abc', auth, requirePermissao(pool, 'clientes', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      // Período configurável via query string; padrão últimos 12 meses
      const { dataInicial, dataFinal } = obterPeriodo(req);
      const periodoParams = [empresaResolvida.id, empresaResolvida.nome];
      let periodoWhere = '';
      if (dataInicial) { periodoParams.push(dataInicial); periodoWhere += ` AND v.data >= $${periodoParams.length}`; }
      if (dataFinal)   { periodoParams.push(dataFinal);   periodoWhere += ` AND v.data <= $${periodoParams.length}`; }
      if (!dataInicial && !dataFinal) {
        periodoWhere = ` AND v.data >= (NOW() AT TIME ZONE 'America/Fortaleza' - INTERVAL '12 months')::date`;
      }

      const result = await pool.query(
        `WITH receita AS (
           SELECT
             v.cliente_id,
             COALESCE(c.nome, v.cliente_nome, 'Sem nome') AS nome,
             COUNT(*)            AS num_vendas,
             SUM(v.total)        AS receita_total
           FROM vendas v
           LEFT JOIN clientes c ON c.id = v.cliente_id AND (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2)) AND c.deletado_em IS NULL
           WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))
             AND v.cliente_id IS NOT NULL
             ${periodoWhere}
           GROUP BY v.cliente_id, c.nome, v.cliente_nome
         ),
         geral AS (
           SELECT SUM(receita_total) AS receita_geral FROM receita
         ),
         ranqueado AS (
           SELECT r.*,
             g.receita_geral,
             SUM(r.receita_total) OVER (
               ORDER BY r.receita_total DESC
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS acumulado
           FROM receita r, geral g
         )
         SELECT
           cliente_id,
           nome,
           num_vendas::int,
           ROUND(receita_total::numeric, 2)   AS receita_total,
           ROUND(receita_geral::numeric, 2)    AS receita_geral,
           ROUND(acumulado::numeric, 2)        AS acumulado,
           ROUND((receita_total / NULLIF(receita_geral,0) * 100)::numeric, 2) AS percentual,
           ROUND((acumulado     / NULLIF(receita_geral,0) * 100)::numeric, 2) AS percentual_acumulado,
           CASE
             WHEN acumulado / NULLIF(receita_geral,0) <= 0.80 THEN 'A'
             WHEN acumulado / NULLIF(receita_geral,0) <= 0.95 THEN 'B'
             ELSE 'C'
           END AS classe
         FROM ranqueado
         ORDER BY receita_total DESC
         LIMIT 2000`,
        periodoParams
      );

      const rows = result.rows;

      // Resumo por classe
      const resumo = { A: { clientes: 0, receita: 0 }, B: { clientes: 0, receita: 0 }, C: { clientes: 0, receita: 0 } };
      for (const r of rows) {
        resumo[r.classe].clientes++;
        resumo[r.classe].receita += Number(r.receita_total);
      }

      const receitaGeral = rows[0]?.receita_geral || 0;

      return res.json({
        sucesso: true,
        clientes: rows,
        resumo,
        receita_geral: Number(receitaGeral),
        total_clientes: rows.length
      });
    } catch (err) {
      console.error('[clientes] segmentacao-abc:', err.message);
      return erro(res, 500, 'Erro ao calcular segmentação ABC');
    }
  });

  router.get('/:empresa', auth, requirePermissao(pool, 'clientes', 'ver'), async (req, res, next) => {
    if (req.params.empresa === 'admin') return next('route');
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const busca = (req.query.busca || '').trim().toLowerCase();
      const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

      let sql = `
        SELECT c.id, c.empresa_id, c.nome, c.telefone, c.email, c.cpf, c.cpf_cnpj,
               c.endereco, c.nascimento, c.tabela_preco_id, c.criado_em, c.atualizado_em,
               COALESCE(cr_saldo.total_em_aberto, 0) AS total_em_aberto,
               COALESCE(cr_saldo.total_em_atraso, 0) AS total_em_atraso
        FROM clientes c
        LEFT JOIN (
          SELECT cliente_id,
                 SUM(COALESCE(valor_atualizado, valor)) AS total_em_aberto,
                 SUM(CASE WHEN data_vencimento < $3 THEN COALESCE(valor_atualizado, valor) ELSE 0 END) AS total_em_atraso
          FROM contas_receber
          WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
            AND LOWER(COALESCE(status, 'pendente')) NOT IN ('pago')
          GROUP BY cliente_id
        ) cr_saldo ON cr_saldo.cliente_id = c.id
        WHERE (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))
        AND c.deletado_em IS NULL
      `;

      const params = [empresaResolvida.id, empresaResolvida.nome, hoje];
      let idx = 4;

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        sql += `
          AND (
            LOWER(COALESCE(c.nome, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(c.cpf, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(c.telefone, '')) LIKE $${idx} ESCAPE '\\'
          )
        `;
        params.push(`%${buscaEsc}%`);
        idx++;
      }

      const limite = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 100), 500);
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const filterParams = [...params];
      const limIdx = filterParams.length + 1;
      const offIdx = filterParams.length + 2;

      const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS contagem`;

      const [countResult, result] = await Promise.all([
        pool.query(countSql, filterParams),
        pool.query(
          sql + ` ORDER BY c.nome ASC LIMIT $${limIdx} OFFSET $${offIdx}`,
          [...filterParams, limite, offset]
        )
      ]);

      return res.json({
        sucesso: true,
        dados:  result.rows.map(normalizarCliente),
        total:  Number(countResult.rows[0]?.total || 0),
        limite,
        offset
      });
    } catch (error) {
      console.error('Erro real ao buscar clientes:', error);
      return erro(res, 500, 'Erro ao buscar clientes');
    }
  });

  router.get('/admin/lista', auth, apenasAdmin, async (req, res) => {
    try {
      const params = [];
      let where = `WHERE deletado_em IS NULL`;

      const empresa = req.query.empresa || '';
      const busca = (req.query.busca || '').trim().toLowerCase();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      if (empresa) {
        const empresaResolvida = await validarAcessoEmpresa(req, empresa);

        if (!empresaResolvida) {
          return erro(res, 403, 'Sem acesso');
        }

        params.push(empresaResolvida.id);
        params.push(empresaResolvida.nome);
        where += ` AND (empresa_id = $${params.length - 1} OR (empresa_id IS NULL AND empresa = $${params.length}))`;
      }

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        params.push(`%${buscaEsc}%`);
        where += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${params.length}
            OR LOWER(COALESCE(cpf, '')) LIKE $${params.length}
            OR LOWER(COALESCE(telefone, '')) LIKE $${params.length}
          )
        `;
      }

      where += adicionarFiltroPeriodo({
        campo: 'criado_em',
        params,
        dataInicial,
        dataFinal
      });

      const pagina = Math.max(1, parseInt(req.query.page || '1', 10));
      const limite = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);
      const offset = (pagina - 1) * limite;

      const [countResult, result] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS total FROM clientes ${where}`, params),
        pool.query(
          `SELECT * FROM clientes ${where} ORDER BY empresa ASC, nome ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limite, offset]
        )
      ]);

      return res.json({
        dados: result.rows.map(normalizarCliente),
        total: Number(countResult.rows[0]?.total || 0),
        pagina,
        limite
      });
    } catch (error) {
      console.error('Erro real ao buscar clientes admin:', error);
      return erro(res, 500, 'Erro ao buscar clientes');
    }
  });

  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'clientes', 'editar'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { empresa, nome, endereco, telefone, nascimento, cpf } = req.body;

      if (!id) {
        return erro(res, 400, 'Cliente inválido');
      }

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do cliente');
      }

      if (cpf && !validarCpf(cpf)) {
        return erro(res, 400, 'CPF inválido. Verifique os dígitos informados.');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const client = await pool.connect();
      let dadosAnteriores;
      try {
        await client.query('BEGIN');

        const atualResult = await client.query(
          `SELECT * FROM clientes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL FOR UPDATE`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (atualResult.rowCount === 0) {
          await client.query('ROLLBACK');
          return erro(res, 404, 'Cliente não encontrado');
        }

        dadosAnteriores = atualResult.rows[0];

        await client.query(
          `UPDATE clientes
          SET nome = $1,
              endereco = $2,
              telefone = $3,
              nascimento = $4,
              cpf = $5,
              atualizado_em = NOW()
          WHERE id = $6 AND (empresa_id = $7 OR (empresa_id IS NULL AND empresa = $8)) AND deletado_em IS NULL`,
          [nome, (endereco || '').trim() || null, (telefone || '').trim() || null, (nascimento || '').trim() || null, cpf || null, id, empresaResolvida.id, empresaResolvida.nome]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'clientes',
        acao: 'edicao',
        referencia_id: id,
        dados_anteriores: dadosAnteriores,
        dados_novos: {
          nome,
          endereco,
          telefone,
          nascimento,
          cpf
        },
        req
      });

      return ok(res, {
        mensagem: 'Cliente atualizado com sucesso'
      });
    } catch (error) {
      console.error('Erro real ao atualizar cliente:', error);
      return erro(res, 500, 'Erro ao atualizar cliente');
    }
  });

  router.delete('/:id', auth, writeRateLimiter, requirePermissao(pool, 'clientes', 'deletar'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresa = req.query.empresa || req.body.empresa || null;

      if (!id) {
        return erro(res, 400, 'Cliente inválido');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      // Todas as verificações + soft-delete dentro de uma única transação
      // com FOR UPDATE para evitar TOCTOU
      const dbClient = await pool.connect();
      let clienteParaAudit;
      try {
        await dbClient.query('BEGIN');

        // Lock no cliente impede corrida entre verificação e deleção
        const clienteResult = await dbClient.query(
          `SELECT * FROM clientes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL FOR UPDATE`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (clienteResult.rowCount === 0) {
          await dbClient.query('ROLLBACK');
          return erro(res, 404, 'Cliente não encontrado');
        }

        clienteParaAudit = clienteResult.rows[0];

        const vendaResult = await dbClient.query(
          `SELECT COUNT(*) AS total FROM vendas
           WHERE cliente_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (Number(vendaResult.rows[0].total || 0) > 0) {
          await dbClient.query('ROLLBACK');
          return erro(res, 400, 'Cliente já possui vendas vinculadas e não pode ser excluído');
        }

        const crAbertoResult = await dbClient.query(
          `SELECT COUNT(*) AS total FROM contas_receber
           WHERE cliente_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
             AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago','cancelado')`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (Number(crAbertoResult.rows[0].total || 0) > 0) {
          await dbClient.query('ROLLBACK');
          return erro(res, 400, 'Cliente possui contas a receber em aberto e não pode ser excluído');
        }

        await dbClient.query(
          `UPDATE clientes
          SET deletado_em = NOW(),
              atualizado_em = NOW()
          WHERE id = $1
          AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        await dbClient.query('COMMIT');
      } catch (txErr) {
        await dbClient.query('ROLLBACK');
        throw txErr;
      } finally {
        dbClient.release();
      }

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'clientes',
        acao: 'soft_delete',
        referencia_id: id,
        dados_anteriores: clienteParaAudit,
        dados_novos: {
          deletado_em: new Date()
        },
        req
      });

      return ok(res, {
        mensagem: 'Cliente excluído com sucesso'
      });
    } catch (error) {
      console.error('Erro real ao excluir cliente:', error);
      return erro(res, 500, 'Erro ao excluir cliente');
    }
  });

  return router;
};
