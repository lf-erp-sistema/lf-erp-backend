'use strict';

const { resolverPreco } = require('../../utils/resolverPreco');
const { validarEstoqueKit, baixarComponentesKit, estornarComponentesKit, sincronizarEstoqueKit } = require('../../utils/kits');

// Helpers compartilhados por criar/editar/excluir (achado ARCH-01 da Auditoria 360,
// 2026-10-06) -- extraídos de vendas.routes.js sem nenhuma alteração de lógica.
function createVendasHelpers({ normalizarInt, normalizarDecimal, registrarMovimentacaoEstoque, validarItensVenda }) {
  async function validarVendaPertenceEmpresa({ client, venda, empresaResolvida }) {
    const vendaEmpresaId = venda.empresa_id ? Number(venda.empresa_id) : null;
    const vendaEmpresaNome = venda.empresa || null;

    const pertenceEmpresa =
      (vendaEmpresaId && vendaEmpresaId === Number(empresaResolvida.id)) ||
      (!vendaEmpresaId && vendaEmpresaNome === empresaResolvida.nome);

    if (!pertenceEmpresa) {
      return false;
    }

    if (!vendaEmpresaId) {
      await client.query(
        `
        UPDATE vendas
        SET empresa_id = $1,
            empresa = $2,
            atualizado_em = NOW()
        WHERE id = $3
        `,
        [empresaResolvida.id, empresaResolvida.nome, venda.id]
      );
    }

    return true;
  }

  async function vendaPossuiParcelaPaga({ client, vendaId, empresaResolvida }) {
    const result = await client.query(
      `
      SELECT 1
      FROM contas_receber
      WHERE venda_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        AND LOWER(COALESCE(status, 'pendente')) = 'pago'
      LIMIT 1
      `,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );

    return result.rowCount > 0;
  }

  async function estornarEstoqueVenda({ client, vendaId, empresaResolvida, usuarioId, motivo }) {
    const itensResult = await client.query(
      `
      SELECT *
      FROM venda_itens
      WHERE venda_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      ORDER BY id ASC
      `,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );

    // Pré-busca e_kit de todos os produtos da venda — evita N+1 (atributo estático)
    const prodIdsEstorno = [...new Set(
      itensResult.rows.map(r => Number(r.produto_id)).filter(id => id > 0)
    )];
    const eKitRows = await client.query(
      `SELECT id, e_kit FROM produtos WHERE id = ANY($1) AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL`,
      [prodIdsEstorno, empresaResolvida.id, empresaResolvida.nome]
    );
    const eKitMap = Object.fromEntries(eKitRows.rows.map(r => [r.id, Boolean(r.e_kit)]));

    for (const item of itensResult.rows) {
      const produtoId = Number(item.produto_id);
      const quantidade = normalizarInt(item.quantidade);
      const gradeId = item.grade_id ? Number(item.grade_id) : null;

      if (!produtoId || quantidade <= 0) continue;

      const eKit = eKitMap[produtoId] ?? false;

      if (gradeId) {
        // Restaura estoque na grade específica
        const gradeRestoreResult = await client.query(
          `UPDATE produto_grades SET estoque = estoque + $1, atualizado_em = NOW()
           WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
           RETURNING id`,
          [quantidade, gradeId, empresaResolvida.id, empresaResolvida.nome]
        );
        if (gradeRestoreResult.rowCount === 0) {
          throw new Error(`Grade ID ${gradeId} não encontrada ao estornar cancelamento.`);
        }
        await client.query(
          `UPDATE produtos SET estoque = (
             SELECT COALESCE(SUM(estoque), 0) FROM produto_grades
             WHERE produto_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND ativo = true
           ), atualizado_em = NOW()
           WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [produtoId, empresaResolvida.id, empresaResolvida.nome]
        );
      } else if (eKit) {
        // Restaura estoque de cada componente do kit
        await estornarComponentesKit({
          client, kitId: produtoId, empresaId: empresaResolvida.id,
          qtdKits: quantidade, vendaId, usuarioId,
          registrarMovimentacaoEstoque
        });
        await sincronizarEstoqueKit(client, produtoId, empresaResolvida.id);
      } else {
        const updProd = await client.query(
          `UPDATE produtos SET estoque = estoque + $1, atualizado_em = NOW()
           WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
           RETURNING id`,
          [quantidade, produtoId, empresaResolvida.id, empresaResolvida.nome]
        );
        if (updProd.rowCount === 0) continue;
      }

      if (!eKit) {
        await registrarMovimentacaoEstoque({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          produto_id: produtoId,
          grade_id: gradeId,
          tipo: 'estorno_venda',
          quantidade,
          observacao: motivo || `Estorno da venda #${vendaId}`,
          referencia_tipo: 'venda_estornada',
          referencia_id: vendaId,
          usuario_id: usuarioId,
          client
        });
      }
    }
  }

  async function removerDadosDependentesVenda({ client, vendaId, empresaResolvida }) {
    // VP-C1: preservar parcelas já pagas — só deleta as pendentes/atrasadas/parciais
    await client.query(
      `
      DELETE FROM contas_receber
      WHERE venda_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        AND LOWER(COALESCE(status, 'pendente')) NOT IN ('pago')
`,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM movimentacoes_estoque
      WHERE referencia_tipo = 'venda'
        AND referencia_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM venda_itens
      WHERE venda_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );
  }

  async function inserirItensVendaEBaixarEstoque({
    client,
    vendaId,
    empresaResolvida,
    itens,
    usuarioId,
    clienteId = null
  }) {
    if (!validarItensVenda(itens)) {
      throw new Error('Itens da venda inválidos');
    }

    // Pré-busca todos os produtos em uma query — evita N+1 no loop
    // Seguro porque nome/preco/custo/e_kit/tem_grade são atributos estáticos;
    // o débito de estoque é feito via UPDATE atômico (estoque - qty WHERE estoque >= qty)
    const produtoIds = [...new Set(itens.map(i => Number(i.produto_id)).filter(id => id > 0))];
    const produtosRows = await client.query(
      `SELECT * FROM produtos WHERE id = ANY($1) AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL`,
      [produtoIds, empresaResolvida.id, empresaResolvida.nome]
    );
    const produtosMap = Object.fromEntries(produtosRows.rows.map(p => [p.id, p]));

    let somaItens = 0;

    for (const item of itens) {
      const produtoId = Number(item.produto_id);
      const quantidade = normalizarInt(item.quantidade);
      const gradeId = item.grade_id ? Number(item.grade_id) : null;

      const produto = produtosMap[produtoId];
      if (!produto) {
        throw new Error(`Produto ${produtoId} não encontrado`);
      }

      // ── Produto com grade ──────────────────────────────────────────
      if (produto.tem_grade) {
        if (!gradeId) {
          throw new Error(`Produto "${produto.nome}" possui grade. Selecione a variação (tamanho/cor).`);
        }

        const gradeResult = await client.query(
          `SELECT pg.* FROM produto_grades pg
           JOIN produtos p ON p.id = pg.produto_id
           WHERE pg.id = $1 AND pg.produto_id = $2
             AND (p.empresa_id = $3 OR (p.empresa_id IS NULL AND p.empresa = $4))
             AND pg.ativo = true FOR UPDATE`,
          [gradeId, produtoId, empresaResolvida.id, empresaResolvida.nome]
        );

        if (gradeResult.rowCount === 0) {
          throw new Error(`Grade não encontrada para o produto "${produto.nome}"`);
        }

        const grade = gradeResult.rows[0];
        const estoqueGrade = normalizarInt(grade.estoque);

        if (estoqueGrade < quantidade) {
          throw new Error(
            `Estoque insuficiente para "${produto.nome}" (${grade.atributo1}${grade.atributo2 ? ' / ' + grade.atributo2 : ''}). Disponível: ${estoqueGrade}`
          );
        }

        // Valores do banco/computados (resolverPreco retorna número, grade/produto.preco são NUMERIC):
        // usar Number(), não normalizarDecimal (que corromperia string "10.00" do pg).
        const precoRef = Number(
          (await resolverPreco({ pool: client, produtoId, gradeId, clienteId, empresaId: empresaResolvida.id, quantidade }))
          || grade.preco || produto.preco || 0
        );
        const precoEnviado = item.preco_unitario != null ? normalizarDecimal(item.preco_unitario) : null;
        if (precoEnviado !== null && precoEnviado < 0) {
          throw new Error(`Preço inválido para "${produto.nome}"`);
        }
        // Usa precoEnviado apenas se for >= 10% do preço de referência (bloqueia data-preco DOM bypass)
        const precoValido = precoEnviado != null && precoEnviado > 0 &&
          (precoRef <= 0 || precoEnviado >= precoRef * 0.1);
        const precoUnitario = precoValido ? precoEnviado : precoRef;
        if (precoUnitario <= 0) {
          throw new Error(`Produto "${produto.nome}" não possui preço cadastrado.`);
        }
        // custo vem de dados do produto/grade (banco), não é campo digitado em formato BR
        const custoUnitario = Number(item.custo_unitario || grade.custo || produto.custo || 0);
        const totalItem = Number((quantidade * precoUnitario).toFixed(2));
        somaItens += totalItem;

        await client.query(
          `INSERT INTO venda_itens
           (venda_id, empresa, empresa_id, produto_id, produto_nome, grade_id, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [vendaId, empresaResolvida.nome, empresaResolvida.id, produto.id, produto.nome, gradeId, quantidade, precoUnitario, custoUnitario, totalItem]
        );

        // Baixa estoque da grade
        const gradeUpdateResult = await client.query(
          `UPDATE produto_grades SET estoque = $1, atualizado_em = NOW()
           WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
           RETURNING id`,
          [estoqueGrade - quantidade, gradeId, empresaResolvida.id, empresaResolvida.nome]
        );
        if (gradeUpdateResult.rowCount === 0) {
          throw new Error(`Grade ID ${gradeId} não encontrada ou sem acesso.`);
        }

        // Sincroniza estoque do produto-pai como soma das grades
        await client.query(
          `UPDATE produtos SET estoque = (
             SELECT COALESCE(SUM(estoque), 0) FROM produto_grades
             WHERE produto_id = $1 AND ativo = true
               AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
           ), atualizado_em = NOW()
           WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [produtoId, empresaResolvida.id, empresaResolvida.nome]
        );

      // ── Kit (composição) ──────────────────────────────────────────
      } else if (produto.e_kit) {
        await validarEstoqueKit(client, produtoId, empresaResolvida.id, quantidade);

        const precoRef = Number(
          (await resolverPreco({ pool: client, produtoId, gradeId: null, clienteId, empresaId: empresaResolvida.id, quantidade }))
          || produto.preco || 0
        );
        const precoEnviado = item.preco_unitario != null ? normalizarDecimal(item.preco_unitario) : null;
        if (precoEnviado !== null && precoEnviado < 0) {
          throw new Error(`Preço inválido para "${produto.nome}"`);
        }
        const precoValidoKit = precoEnviado != null && precoEnviado > 0 &&
          (precoRef <= 0 || precoEnviado >= precoRef * 0.1);
        const precoUnitario = precoValidoKit ? precoEnviado : precoRef;
        if (precoUnitario <= 0) {
          throw new Error(`Produto "${produto.nome}" não possui preço cadastrado.`);
        }
        const custoUnitario = Number(item.custo_unitario || produto.custo || 0);
        const totalItem = Number((quantidade * precoUnitario).toFixed(2));
        somaItens += totalItem;

        await client.query(
          `INSERT INTO venda_itens
           (venda_id, empresa, empresa_id, produto_id, produto_nome, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [vendaId, empresaResolvida.nome, empresaResolvida.id, produto.id, produto.nome, quantidade, precoUnitario, custoUnitario, totalItem]
        );

        await baixarComponentesKit({
          client, kitId: produtoId, empresaId: empresaResolvida.id,
          qtdKits: quantidade, vendaId, usuarioId,
          registrarMovimentacaoEstoque
        });

        // Sincroniza estoque do kit com base nos componentes restantes
        await sincronizarEstoqueKit(client, produtoId, empresaResolvida.id);

      // ── Produto simples (sem grade, sem kit) ───────────────────────
      } else {
        const precoRef = Number(
          (await resolverPreco({ pool: client, produtoId, gradeId: null, clienteId, empresaId: empresaResolvida.id, quantidade }))
          || produto.preco || 0
        );
        const precoEnviado = item.preco_unitario != null ? normalizarDecimal(item.preco_unitario) : null;
        if (precoEnviado !== null && precoEnviado < 0) {
          throw new Error(`Preço inválido para "${produto.nome}"`);
        }
        const precoValidoSimples = precoEnviado != null && precoEnviado > 0 &&
          (precoRef <= 0 || precoEnviado >= precoRef * 0.1);
        const precoUnitario = precoValidoSimples ? precoEnviado : precoRef;
        if (precoUnitario <= 0) {
          throw new Error(`Produto "${produto.nome}" não possui preço cadastrado.`);
        }
        const custoUnitario = Number(item.custo_unitario || produto.custo || 0);
        const totalItem = Number((quantidade * precoUnitario).toFixed(2));
        somaItens += totalItem;

        await client.query(
          `INSERT INTO venda_itens
           (venda_id, empresa, empresa_id, produto_id, produto_nome, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [vendaId, empresaResolvida.nome, empresaResolvida.id, produto.id, produto.nome, quantidade, precoUnitario, custoUnitario, totalItem]
        );

        // UPDATE atômico: debita apenas se estoque suficiente — previne oversell em concorrência
        const upd = await client.query(
          `UPDATE produtos SET estoque = estoque - $1, atualizado_em = NOW()
           WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4)) AND estoque >= $1`,
          [quantidade, produto.id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (upd.rowCount === 0) {
          throw new Error(`Estoque insuficiente para ${produto.nome}`);
        }
      }

      // Kits registram movimentações por componente em baixarComponentesKit
      if (!produto.e_kit) {
        await registrarMovimentacaoEstoque({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          produto_id: produto.id,
          grade_id: gradeId,
          tipo: 'saida_venda',
          quantidade,
          observacao: `Saída por venda #${vendaId}`,
          referencia_tipo: 'venda',
          referencia_id: vendaId,
          usuario_id: usuarioId,
          client
        });
      }
    }

    return somaItens;
  }

  return {
    validarVendaPertenceEmpresa,
    vendaPossuiParcelaPaga,
    estornarEstoqueVenda,
    removerDadosDependentesVenda,
    inserirItensVendaEBaixarEstoque
  };
}

module.exports = { createVendasHelpers };
