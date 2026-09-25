const { requirePermissao } = require('../utils/permissoes');
const { erro, ok } = require('../utils/routeHelpers');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');

module.exports = ({
  auth,
  writeRateLimiter,
  apenasAdmin,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  validarLimitePlano,
  normalizarDecimal,
  normalizarInt,
  registrarMovimentacaoEstoque,
  registrarAuditoria
}) => {
  const router = require('express').Router();



  function normalizarProduto(row) {
    return {
      ...row,
      id: Number(row.id || 0),
      empresa_id: row.empresa_id ? Number(row.empresa_id) : null,
      preco: Number(row.preco || 0),
      custo: Number(row.custo || 0),
      custo_unitario: Number(row.custo_unitario || row.custo || 0),
      custo_medio: Number(row.custo_medio || row.custo || 0),
      lucro_unitario: Number(row.lucro_unitario || 0),
      margem_lucro: Number(row.margem_lucro || 0),
      preco_promocional: Number(row.preco_promocional || 0),
      promocao_ativa: Boolean(row.promocao_ativa),
      estoque: Number(row.estoque || 0),
      estoque_minimo: Number(row.estoque_minimo || 0),
      alerta_estoque: Boolean(row.alerta_estoque),
      // campos fiscais e grade (F2)
      unidade: row.unidade || 'UN',
      origem: Number(row.origem ?? 0),
      icms_aliquota: Number(row.icms_aliquota || 0),
      icms_base_calculo: Number(row.icms_base_calculo || 100),
      pis_aliquota: Number(row.pis_aliquota || 0),
      cofins_aliquota: Number(row.cofins_aliquota || 0),
      ipi_aliquota: Number(row.ipi_aliquota || 0),
      peso_bruto: row.peso_bruto ? Number(row.peso_bruto) : null,
      peso_liquido: row.peso_liquido ? Number(row.peso_liquido) : null,
      comprimento_cm: row.comprimento_cm ? Number(row.comprimento_cm) : null,
      largura_cm: row.largura_cm ? Number(row.largura_cm) : null,
      altura_cm: row.altura_cm ? Number(row.altura_cm) : null,
      tem_grade: Boolean(row.tem_grade),
      e_kit: Boolean(row.e_kit)
    };
  }

  // ================= PRODUTOS =================

  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'produtos', 'criar'), async (req, res) => {
    try {
      const {
        empresa,
        nome,
        preco,
        custo,
        custo_unitario,
        custo_medio,
        preco_promocional,
        promocao_ativa,
        estoque,
        estoque_minimo,
        codigo_barras,
        categoria,
        // novos campos F2
        codigo_interno,
        gtin,
        unidade,
        descricao_completa,
        peso_bruto,
        peso_liquido,
        comprimento_cm,
        largura_cm,
        altura_cm,
        ncm,
        cfop_padrao,
        origem,
        icms_cst,
        icms_aliquota,
        icms_base_calculo,
        pis_cst,
        pis_aliquota,
        cofins_cst,
        cofins_aliquota,
        ipi_cst,
        ipi_aliquota,
        tem_grade
      } = req.body;

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do produto');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const limitePlano = await validarLimitePlano({
        empresaResolvida,
        recurso: 'produtos'
      });

      if (!limitePlano.permitido) {
        return erro(res, 403, limitePlano.mensagem);
      }

      const precoFinal = normalizarDecimal(preco);
      const custoBase = normalizarDecimal(custo_unitario || custo);
      const custoMedioFinal = normalizarDecimal(custo_medio || custoBase);

      if (precoFinal < 0) return erro(res, 400, 'Preço não pode ser negativo');
      if (custoBase < 0) return erro(res, 400, 'Custo não pode ser negativo');
      if (preco_promocional != null && normalizarDecimal(preco_promocional) < 0) return erro(res, 400, 'Preço promocional não pode ser negativo');
      if (normalizarInt(estoque) < 0) return erro(res, 400, 'Estoque inicial não pode ser negativo');
      if (normalizarInt(estoque_minimo) < 0) return erro(res, 400, 'Estoque mínimo não pode ser negativo');

      const lucroUnitario = Number((precoFinal - custoMedioFinal).toFixed(2));
      const margemLucro =
        precoFinal > 0 ? Number(((lucroUnitario / precoFinal) * 100).toFixed(2)) : 0;

      const prodClient = await pool.connect();
      let produtoId;
      try {
        await prodClient.query('BEGIN');

        // Gerar código de barras automático se não informado
        let codigoBarrasFinal = (codigo_barras || '').trim();
        if (!codigoBarrasFinal) {
          // PRD-M2: lock transacional para evitar race condition na geração do código
          await prodClient.query(
            `SELECT pg_advisory_xact_lock(hashtext($1::text || '_codigos_barras'))`,
            [String(empresaResolvida.id)]
          );
          const cbRes = await prodClient.query(
            `SELECT n AS next_cb
             FROM generate_series(1, (
               SELECT COALESCE(MAX(CAST(codigo_barras AS BIGINT)), 0) + 1
               FROM produtos
               WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
                 AND codigo_barras ~ '^[0-9]+$'
             )) AS gs(n)
             WHERE NOT EXISTS (
               SELECT 1 FROM produtos
               WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
                 AND codigo_barras ~ '^[0-9]+$'
                 AND CAST(codigo_barras AS BIGINT) = gs.n
             )
             ORDER BY n LIMIT 1`,
            [empresaResolvida.id, empresaResolvida.nome]
          );
          codigoBarrasFinal = String(Number(cbRes.rows[0].next_cb)).padStart(6, '0');
        }

        const result = await prodClient.query(
        `INSERT INTO produtos
        (empresa, empresa_id, nome, preco, custo, custo_unitario, custo_medio, lucro_unitario, margem_lucro,
         preco_promocional, promocao_ativa, estoque, estoque_minimo, codigo_barras, categoria,
         codigo_interno, gtin, unidade, descricao_completa,
         peso_bruto, peso_liquido, comprimento_cm, largura_cm, altura_cm,
         ncm, cfop_padrao, origem,
         icms_cst, icms_aliquota, icms_base_calculo,
         pis_cst, pis_aliquota,
         cofins_cst, cofins_aliquota,
         ipi_cst, ipi_aliquota,
         tem_grade,
         criado_em, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
                $28,$29,$30,$31,$32,$33,$34,$35,$36,$37,
                NOW(), NOW())
        RETURNING id`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          nome,
          precoFinal,
          custoBase,
          custoBase,
          custoMedioFinal,
          lucroUnitario,
          margemLucro,
          normalizarDecimal(preco_promocional),
          Boolean(promocao_ativa),
          normalizarInt(estoque),
          normalizarInt(estoque_minimo),
          codigoBarrasFinal,
          categoria || '',
          // novos F2
          codigo_interno || null,
          gtin || null,
          unidade || 'UN',
          descricao_completa || null,
          peso_bruto ? normalizarDecimal(peso_bruto) : null,
          peso_liquido ? normalizarDecimal(peso_liquido) : null,
          comprimento_cm ? normalizarDecimal(comprimento_cm) : null,
          largura_cm ? normalizarDecimal(largura_cm) : null,
          altura_cm ? normalizarDecimal(altura_cm) : null,
          ncm || null,
          cfop_padrao || null,
          origem !== undefined ? normalizarInt(origem) : 0,
          icms_cst || null,
          icms_aliquota ? normalizarDecimal(icms_aliquota) : 0,
          icms_base_calculo ? normalizarDecimal(icms_base_calculo) : 100,
          pis_cst || null,
          pis_aliquota ? normalizarDecimal(pis_aliquota) : 0,
          cofins_cst || null,
          cofins_aliquota ? normalizarDecimal(cofins_aliquota) : 0,
          ipi_cst || null,
          ipi_aliquota ? normalizarDecimal(ipi_aliquota) : 0,
          Boolean(tem_grade)
        ]
      );

        produtoId = result.rows[0].id;

        if (normalizarInt(estoque) > 0) {
          await registrarMovimentacaoEstoque({
            empresa: empresaResolvida.nome,
            empresa_id: empresaResolvida.id,
            produto_id: produtoId,
            tipo: 'cadastro_inicial',
            quantidade: normalizarInt(estoque),
            observacao: 'Estoque inicial do cadastro',
            referencia_tipo: 'produto',
            referencia_id: produtoId,
            usuario_id: req.user.id,
            client: prodClient
          });
        }

        await prodClient.query('COMMIT');
      } catch (txErr) {
        await prodClient.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        prodClient.release();
      }

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'produtos',
        acao: 'cadastro',
        referencia_id: produtoId,
        dados_novos: {
          nome,
          preco,
          custo,
          estoque,
          estoque_minimo,
          codigo_barras,
          categoria
        },
        req
      });

      return ok(res, {
        id: produtoId,
        dados: {
          id: produtoId
        }
      });
    } catch (error) {
      console.error('Erro real ao cadastrar produto:', error);
      return erro(res, 500, 'Erro ao cadastrar produto');
    }
  });

  // Deve ficar ANTES de /:empresa para não ser engolido pelo parâmetro genérico
  router.get('/etiquetas-hoje/:empresa', auth, requirePermissao(pool, 'produtos', 'ver'), async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { rows } = await pool.query(`
        SELECT DISTINCT p.id, p.nome, p.preco, p.codigo_barras, p.categoria
        FROM produtos p
        WHERE p.deletado_em IS NULL
          AND (p.empresa_id = $1 OR (p.empresa_id IS NULL AND p.empresa = $2))
          AND (
            (p.criado_em AT TIME ZONE 'America/Fortaleza')::date
              = (NOW() AT TIME ZONE 'America/Fortaleza')::date
            OR EXISTS (
              SELECT 1 FROM compra_itens ci
              JOIN compras c ON c.id = ci.compra_id
              WHERE ci.produto_id = p.id
                AND (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))
                AND (c.criado_em AT TIME ZONE 'America/Fortaleza')::date
                  = (NOW() AT TIME ZONE 'America/Fortaleza')::date
            )
            OR EXISTS (
              SELECT 1 FROM movimentacoes_estoque me
              WHERE me.produto_id = p.id
                AND (me.empresa_id = $1 OR (me.empresa_id IS NULL AND me.empresa = $2))
                AND (me.data_movimentacao AT TIME ZONE 'America/Fortaleza')::date
                  = (NOW() AT TIME ZONE 'America/Fortaleza')::date
            )
          )
        ORDER BY p.nome
        LIMIT 1000
      `, [empresaResolvida.id, empresaResolvida.nome]);

      return ok(res, { dados: rows.map(normalizarProduto) });
    } catch (error) {
      console.error('Erro real ao buscar etiquetas de hoje:', error);
      return erro(res, 500, 'Erro ao buscar produtos de hoje');
    }
  });

  router.get('/:empresa', auth, requirePermissao(pool, 'produtos', 'ver'), async (req, res, next) => {
    if (req.params.empresa === 'admin') return next('route');
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const busca = (req.query.busca || '').trim().toLowerCase();

      const params = [];

      let sql = `
  SELECT *,
        CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN TRUE ELSE FALSE END AS alerta_estoque
  FROM produtos
  WHERE deletado_em IS NULL
${adicionarFiltroEmpresaSaaS({
  params,
  empresaResolvida
})}
`;

      let idx = params.length + 1;

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        sql += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(categoria, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(codigo_barras, '')) LIKE $${idx} ESCAPE '\\'
          )
        `;
        params.push(`%${buscaEsc}%`);
        idx++;
      }

      sql += ` ORDER BY nome ASC`;

      const limite = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 100), 500);
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const limIdx = idx;
      const offIdx = idx + 1;

      const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS contagem`;

      const [countResult, result] = await Promise.all([
        pool.query(countSql, params),
        pool.query(
          sql + ` LIMIT $${limIdx} OFFSET $${offIdx}`,
          [...params, limite, offset]
        )
      ]);

      return res.json({
        sucesso: true,
        dados: result.rows.map(normalizarProduto),
        total: Number(countResult.rows[0]?.total || 0),
        limite,
        offset
      });
    } catch (error) {
      console.error('Erro real ao buscar produtos:', error);
      return erro(res, 500, 'Erro ao buscar produtos');
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

        params.push(empresaResolvida.id, empresaResolvida.nome);
        where += ` AND (empresa_id = $${params.length - 1} OR (empresa_id IS NULL AND empresa = $${params.length}))`;
      }

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        params.push(`%${buscaEsc}%`);
        where += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${params.length}
            OR LOWER(COALESCE(categoria, '')) LIKE $${params.length}
            OR LOWER(COALESCE(codigo_barras, '')) LIKE $${params.length}
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
        pool.query(`SELECT COUNT(*) AS total FROM produtos ${where}`, params),
        pool.query(
          `SELECT *,
                  CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN TRUE ELSE FALSE END AS alerta_estoque
          FROM produtos ${where} ORDER BY empresa ASC, nome ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limite, offset]
        )
      ]);

      return res.json({
        sucesso: true,
        dados:  result.rows.map(normalizarProduto),
        total:  Number(countResult.rows[0]?.total || 0),
        pagina,
        limite
      });
    } catch (error) {
      console.error('Erro real ao buscar produtos admin:', error);
      return erro(res, 500, 'Erro ao buscar produtos');
    }
  });

  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'produtos', 'editar'), async (req, res) => {
    try {
      const id = Number(req.params.id);

      const {
        empresa,
        nome,
        preco,
        custo,
        custo_unitario,
        custo_medio,
        preco_promocional,
        promocao_ativa,
        estoque,
        estoque_minimo,
        codigo_barras,
        categoria,
        codigo_interno,
        gtin,
        unidade,
        descricao_completa,
        peso_bruto,
        peso_liquido,
        comprimento_cm,
        largura_cm,
        altura_cm,
        ncm,
        cfop_padrao,
        origem,
        icms_cst,
        icms_aliquota,
        icms_base_calculo,
        pis_cst,
        pis_aliquota,
        cofins_cst,
        cofins_aliquota,
        ipi_cst,
        ipi_aliquota
      } = req.body;

      if (!id) {
        return erro(res, 400, 'Produto inválido');
      }

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do produto');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      // PRD-M1: validar negativos antes de abrir transação
      const precoN   = normalizarDecimal(preco);
      const custoN   = normalizarDecimal(custo_unitario ?? custo);
      const estoqueN = normalizarInt(estoque);
      if (precoN < 0)   return erro(res, 400, 'Preço não pode ser negativo');
      if (custoN < 0)   return erro(res, 400, 'Custo não pode ser negativo');
      if (preco_promocional != null && normalizarDecimal(preco_promocional) < 0) return erro(res, 400, 'Preço promocional não pode ser negativo');
      if (estoqueN < 0) return erro(res, 400, 'Estoque não pode ser negativo');
      if (estoque_minimo !== undefined && normalizarInt(estoque_minimo) < 0) return erro(res, 400, 'estoque_minimo não pode ser negativo');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // SELECT ... FOR UPDATE trava a linha do produto até o COMMIT, evitando que
        // duas edições concorrentes calculem a diferença de estoque com base no
        // mesmo valor "atual" e uma delas sobrescreva o resultado da outra.
        const atualResult = await client.query(
          `SELECT * FROM produtos WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL FOR UPDATE`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (atualResult.rowCount === 0) {
          await client.query('ROLLBACK');
          return erro(res, 404, 'Produto não encontrado');
        }

        const atual = atualResult.rows[0];

        const precoFinal = normalizarDecimal(preco);
        const custoBase = normalizarDecimal(custo_unitario ?? custo ?? atual.custo ?? 0);
        // custo_medio: se enviado explicitamente, usa o valor enviado.
        // Se custo foi alterado, reseta custo_medio para custoBase (evita herdar valor corrompido).
        // Só preserva atual.custo_medio se custo NÃO foi enviado.
        const custoMedioFinal = (custo_medio != null && custo_medio !== '')
          ? normalizarDecimal(custo_medio)
          : (custo != null || custo_unitario != null)
            ? custoBase
            : normalizarDecimal(atual.custo_medio || custoBase);
        const lucroUnitario = Number((precoFinal - custoMedioFinal).toFixed(2));
        const margemLucro =
          precoFinal > 0 ? Number(((lucroUnitario / precoFinal) * 100).toFixed(2)) : 0;

        const estoqueAtual = normalizarInt(atual.estoque);
        const estoqueNovo = normalizarInt(estoque);
        const diferenca = estoqueNovo - estoqueAtual;

        await client.query(
          `UPDATE produtos
          SET nome = $1,
            preco = $2,
            custo = $3,
            custo_unitario = $4,
            custo_medio = $5,
            lucro_unitario = $6,
            margem_lucro = $7,
            preco_promocional = $8,
            promocao_ativa = $9,
            estoque = $10,
            estoque_minimo = $11,
            codigo_barras = $12,
            categoria = $13,
            codigo_interno = $14,
            gtin = $15,
            unidade = $16,
            descricao_completa = $17,
            peso_bruto = $18,
            peso_liquido = $19,
            comprimento_cm = $20,
            largura_cm = $21,
            altura_cm = $22,
            ncm = $23,
            cfop_padrao = $24,
            origem = $25,
            icms_cst = $26,
            icms_aliquota = $27,
            icms_base_calculo = $28,
            pis_cst = $29,
            pis_aliquota = $30,
            cofins_cst = $31,
            cofins_aliquota = $32,
            ipi_cst = $33,
            ipi_aliquota = $34,
            atualizado_em = NOW()
          WHERE id = $35 AND (empresa_id = $36 OR (empresa_id IS NULL AND empresa = $37))`,
          [
            nome,
            precoFinal,
            custoBase,
            custoBase,
            custoMedioFinal,
            lucroUnitario,
            margemLucro,
            preco_promocional !== undefined ? normalizarDecimal(preco_promocional) : normalizarDecimal(atual.preco_promocional),
            promocao_ativa !== undefined ? Boolean(promocao_ativa) : Boolean(atual.promocao_ativa),
            estoqueNovo,
            estoque_minimo !== undefined ? normalizarInt(estoque_minimo) : normalizarInt(atual.estoque_minimo),
            (codigo_barras || '').trim() || null,
            categoria || '',
            codigo_interno !== undefined ? (codigo_interno || null) : atual.codigo_interno,
            gtin !== undefined ? (gtin || null) : atual.gtin,
            unidade || atual.unidade || 'UN',
            descricao_completa !== undefined ? (descricao_completa || null) : atual.descricao_completa,
            peso_bruto !== undefined ? (peso_bruto ? normalizarDecimal(peso_bruto) : null) : atual.peso_bruto,
            peso_liquido !== undefined ? (peso_liquido ? normalizarDecimal(peso_liquido) : null) : atual.peso_liquido,
            comprimento_cm !== undefined ? (comprimento_cm ? normalizarDecimal(comprimento_cm) : null) : atual.comprimento_cm,
            largura_cm !== undefined ? (largura_cm ? normalizarDecimal(largura_cm) : null) : atual.largura_cm,
            altura_cm !== undefined ? (altura_cm ? normalizarDecimal(altura_cm) : null) : atual.altura_cm,
            ncm !== undefined ? (ncm || null) : atual.ncm,
            cfop_padrao !== undefined ? (cfop_padrao || null) : atual.cfop_padrao,
            origem !== undefined ? normalizarInt(origem) : atual.origem,
            icms_cst !== undefined ? (icms_cst || null) : atual.icms_cst,
            icms_aliquota !== undefined ? normalizarDecimal(icms_aliquota) : atual.icms_aliquota,
            icms_base_calculo !== undefined ? normalizarDecimal(icms_base_calculo) : atual.icms_base_calculo,
            pis_cst !== undefined ? (pis_cst || null) : atual.pis_cst,
            pis_aliquota !== undefined ? normalizarDecimal(pis_aliquota) : atual.pis_aliquota,
            cofins_cst !== undefined ? (cofins_cst || null) : atual.cofins_cst,
            cofins_aliquota !== undefined ? normalizarDecimal(cofins_aliquota) : atual.cofins_aliquota,
            ipi_cst !== undefined ? (ipi_cst || null) : atual.ipi_cst,
            ipi_aliquota !== undefined ? normalizarDecimal(ipi_aliquota) : atual.ipi_aliquota,
            id,
            empresaResolvida.id,
            empresaResolvida.nome
          ]
        );

        if (diferenca !== 0) {
          await registrarMovimentacaoEstoque({
            empresa: empresaResolvida.nome,
            empresa_id: empresaResolvida.id,
            produto_id: id,
            tipo: diferenca > 0 ? 'ajuste_entrada' : 'ajuste_saida',
            quantidade: Math.abs(diferenca),
            observacao: 'Ajuste manual na edição do produto',
            referencia_tipo: 'produto',
            referencia_id: id,
            usuario_id: req.user.id,
            client
          });
        }

        await registrarAuditoria({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          usuario_id: req.user.id,
          usuario_nome: req.user.nome || '',
          modulo: 'produtos',
          acao: 'edicao',
          referencia_id: id,
          dados_anteriores: atual,
          dados_novos: {
            nome,
            preco: precoFinal,
            custo: custoBase,
            custo_unitario: custoBase,
            custo_medio: custoMedioFinal,
            lucro_unitario: lucroUnitario,
            margem_lucro: margemLucro,
            preco_promocional: normalizarDecimal(preco_promocional),
            promocao_ativa: Boolean(promocao_ativa),
            estoque: estoqueNovo,
            estoque_minimo,
            codigo_barras,
            categoria
          },
          req,
          client
        });

        await client.query('COMMIT');

        return ok(res, {
          mensagem: 'Produto atualizado com sucesso'
        });
      } catch (errTx) {
        await client.query('ROLLBACK');
        throw errTx;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Erro real ao atualizar produto:', error);
      return erro(res, 500, 'Erro ao atualizar produto');
    }
  });

  router.delete('/:id', auth, writeRateLimiter, requirePermissao(pool, 'produtos', 'deletar'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresa = req.query.empresa || req.body.empresa || null;

      if (!id) {
        return erro(res, 400, 'Produto inválido');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      // Todas as verificações + soft-delete dentro de uma única transação
      // com FOR UPDATE para evitar TOCTOU
      const clienteDel = await pool.connect();
      let produtoParaAudit;
      try {
        await clienteDel.query('BEGIN');

        // Lock no produto impede corrida entre verificação e deleção
        const produtoResult = await clienteDel.query(
          `SELECT * FROM produtos WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL FOR UPDATE`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (produtoResult.rowCount === 0) {
          await clienteDel.query('ROLLBACK');
          return erro(res, 404, 'Produto não encontrado');
        }

        const produto = produtoResult.rows[0];
        produtoParaAudit = produto;

        if (normalizarInt(produto.estoque) > 0) {
          await clienteDel.query('ROLLBACK');
          return erro(res, 400, `Produto possui ${produto.estoque} unidade(s) em estoque. Zere o estoque antes de excluir.`);
        }

        const vendaItemResult = await clienteDel.query(
          `SELECT COUNT(*) AS total
     FROM venda_itens
     WHERE produto_id = $1
     AND (
       empresa_id = $2
       OR (
         empresa_id IS NULL
         AND empresa = $3
       )
     )`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        const compraItemResult = await clienteDel.query(
          `SELECT COUNT(*) AS total
     FROM compra_itens
     WHERE produto_id = $1
     AND (
       empresa_id = $2
       OR (
         empresa_id IS NULL
         AND empresa = $3
       )
     )`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (
          Number(vendaItemResult.rows[0].total || 0) > 0 ||
          Number(compraItemResult.rows[0].total || 0) > 0
        ) {
          await clienteDel.query('ROLLBACK');
          return erro(res, 400, 'Produto já possui movimentações e não pode ser excluído');
        }

        await clienteDel.query(
          `DELETE FROM movimentacoes_estoque
           WHERE produto_id = $1
             AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        await clienteDel.query(
          `UPDATE produtos
           SET deletado_em = NOW(), atualizado_em = NOW()
           WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        );

        await clienteDel.query('COMMIT');
      } catch (txErr) {
        await clienteDel.query('ROLLBACK');
        throw txErr;
      } finally {
        clienteDel.release();
      }

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'produtos',
        acao: 'soft_delete',
        referencia_id: id,
        dados_anteriores: produtoParaAudit,
        dados_novos: {
          deletado_em: new Date()
        },
        req
      });

      return ok(res, {
        mensagem: 'Produto excluído com sucesso'
      });
    } catch (error) {
      console.error('Erro real ao excluir produto:', error);
      return erro(res, 500, 'Erro ao excluir produto');
    }
  });

  return router;
};
