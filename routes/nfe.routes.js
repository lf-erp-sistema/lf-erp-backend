/**
 * NF-e — LF ERP
 * Integração com Focus NFe (focusnfe.com.br).
 *
 * Rotas (montadas em /nfe):
 *   GET    /nfe/config                  — busca configuração NF-e da empresa
 *   PUT    /nfe/config                  — salva configuração NF-e
 *   POST   /nfe/emitir/:vendaId         — emite NF-e para uma venda
 *   GET    /nfe/consultar/:ref          — consulta status no Focus NFe
 *   POST   /nfe/cancelar/:nfeId         — cancela NF-e autorizada
 *   GET    /nfe/lista                   — lista NF-es da empresa
 *   GET    /nfe/pdf/:ref                — proxy do DANFE (PDF)
 *   GET    /nfe/xml/:ref                — proxy do XML
 */

const { emitirNfe, consultarNfe, cancelarNfe, downloadDanfe, downloadXml } = require('../utils/focusnfe');
const { montarPayloadNfe } = require('../utils/nfe_builder');
const { randomUUID } = require('crypto');
const { erro, ok } = require('../utils/routeHelpers');
const { encryptField, decryptField } = require('../utils/pixCrypto');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  requirePermissao
}) => {
  const router = require('express').Router();



  // ── Helper: obtém config NF-e validada da empresa ────────────────────────
  async function obterConfigNfe(empresaId) {
    const r = await pool.query(
      `SELECT * FROM nfe_config WHERE empresa_id = $1`,
      [empresaId]
    );
    const config = r.rows[0] || null;
    if (config?.token_focusnfe) config.token_focusnfe = decryptField(config.token_focusnfe);
    return config;
  }

  // ── Helper: obtém dados completos da empresa ─────────────────────────────
  async function obterEmpresa(empresaId) {
    const r = await pool.query(`SELECT * FROM empresas WHERE id = $1`, [empresaId]);
    return r.rows[0] || null;
  }

  // ── Helper: registra/atualiza emissão no banco ───────────────────────────
  async function salvarEmissao(dados) {
    const { empresa_id, venda_id, ref, ambiente, status, chave_nfe, numero, serie, mensagem } = dados;
    await pool.query(
      `INSERT INTO nfe_emissoes (empresa_id, venda_id, ref, ambiente, status, chave_nfe, numero, serie, mensagem, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (ref) DO UPDATE SET
         status = $5, chave_nfe = COALESCE($6, nfe_emissoes.chave_nfe),
         numero = COALESCE($7, nfe_emissoes.numero),
         serie  = COALESCE($8, nfe_emissoes.serie),
         mensagem = $9, atualizado_em = NOW()`,
      [empresa_id, venda_id || null, ref, ambiente, status, chave_nfe || null,
       numero || null, serie || null, mensagem || null]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /nfe/config
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/config', auth, requirePermissao(pool, 'nfe', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const [config, empresa] = await Promise.all([
        obterConfigNfe(empresaResolvida.id),
        obterEmpresa(empresaResolvida.id)
      ]);

      // Nunca retorna o token completo ao frontend — apenas indica se está configurado
      const configSanitizada = config
        ? { ...config, token_focusnfe: config.token_focusnfe ? '***configurado***' : null }
        : null;

      return ok(res, { config: configSanitizada, empresa });
    } catch (err) {
      console.error('[nfe] GET config:', err.message);
      return erro(res, 500, 'Erro ao buscar configuração NF-e');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /nfe/config
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/config', auth, writeRateLimiter, requirePermissao(pool, 'nfe', 'configurar'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const {
        token_focusnfe,
        ambiente,
        serie,
        codigo_csc,
        id_token_csc,
        // dados fiscais da empresa
        ie, im, crt,
        logradouro, numero, complemento, bairro, municipio, uf, cep, codigo_municipio
      } = req.body;

      // Salva/atualiza nfe_config
      if (token_focusnfe || ambiente !== undefined || serie || codigo_csc || id_token_csc) {
        await pool.query(
          `INSERT INTO nfe_config (empresa_id, token_focusnfe, ambiente, serie, codigo_csc, id_token_csc, atualizado_em)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (empresa_id) DO UPDATE SET
             token_focusnfe = COALESCE($2, nfe_config.token_focusnfe),
             ambiente       = COALESCE($3, nfe_config.ambiente),
             serie          = COALESCE($4, nfe_config.serie),
             codigo_csc     = COALESCE($5, nfe_config.codigo_csc),
             id_token_csc   = COALESCE($6, nfe_config.id_token_csc),
             atualizado_em  = NOW()`,
          [
            empresaResolvida.id,
            token_focusnfe ? encryptField(token_focusnfe) : null,
            ambiente != null ? Number(ambiente) : null,
            serie || null,
            codigo_csc || null,
            id_token_csc || null
          ]
        );
      }

      // Atualiza dados fiscais da empresa
      await pool.query(
        `UPDATE empresas SET
           ie               = COALESCE($1, ie),
           im               = COALESCE($2, im),
           crt              = COALESCE($3, crt),
           logradouro       = COALESCE($4, logradouro),
           numero           = COALESCE($5, numero),
           complemento      = COALESCE($6, complemento),
           bairro           = COALESCE($7, bairro),
           municipio        = COALESCE($8, municipio),
           uf               = COALESCE($9, uf),
           cep              = COALESCE($10, cep),
           codigo_municipio = COALESCE($11, codigo_municipio),
           atualizado_em    = NOW()
         WHERE id = $12`,
        [ie || null, im || null, crt != null ? Number(crt) : null,
         logradouro || null, numero || null, complemento || null,
         bairro || null, municipio || null, uf || null,
         cep || null, codigo_municipio || null,
         empresaResolvida.id]
      );

      return ok(res, { mensagem: 'Configuração NF-e salva com sucesso' });
    } catch (err) {
      console.error('[nfe] PUT config:', err.message);
      return erro(res, 500, 'Erro ao salvar configuração NF-e');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /nfe/emitir/:vendaId
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/emitir/:vendaId', auth, writeRateLimiter, requirePermissao(pool, 'nfe', 'emitir'), async (req, res) => {
    try {
      const vendaId = Number(req.params.vendaId);
      if (!vendaId) return erro(res, 400, 'ID de venda inválido');

      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      // Valida configuração
      const config = await obterConfigNfe(empresaResolvida.id);
      if (!config?.token_focusnfe) {
        return erro(res, 400, 'Configure o token Focus NFe antes de emitir NF-e. Acesse Configurações → NF-e.');
      }

      // Gera referência única antes do lock — necessário para registrar 'processando'
      // dentro da mesma transação e evitar race condition entre chamadas simultâneas
      const ref = `lferp-${empresaResolvida.id}-${vendaId}-${randomUUID().slice(0, 8)}`;

      // Advisory lock previne emissão duplicada simultânea para a mesma (empresa, venda).
      // O registro 'processando' é inserido dentro da transação para garantir que a próxima
      // chamada concorrente o encontre ANTES de o lock ser liberado.
      const clientNfe = await pool.connect();
      try {
        await clientNfe.query('BEGIN');
        await clientNfe.query('SELECT pg_advisory_xact_lock($1, $2)', [empresaResolvida.id, vendaId]);

        const jaEmitida = await clientNfe.query(
          `SELECT id, chave_nfe FROM nfe_emissoes
           WHERE venda_id = $1 AND empresa_id = $2 AND status NOT IN ('cancelado','erro')
           LIMIT 1`,
          [vendaId, empresaResolvida.id]
        );
        if (jaEmitida.rowCount > 0) {
          await clientNfe.query('ROLLBACK');
          return erro(res, 400, `Esta venda já possui NF-e em processamento ou autorizada. Chave: ${jaEmitida.rows[0].chave_nfe || 'pendente'}`);
        }

        // Registra como processando DENTRO da transação — garante visibilidade atômica
        await clientNfe.query(
          `INSERT INTO nfe_emissoes (empresa_id, venda_id, ref, ambiente, status, mensagem, atualizado_em)
           VALUES ($1,$2,$3,$4,'processando','Aguardando resposta do Focus NFe',NOW())
           ON CONFLICT (ref) DO NOTHING`,
          [empresaResolvida.id, vendaId, ref, config.ambiente]
        );

        await clientNfe.query('COMMIT');
      } catch (lockErr) {
        await clientNfe.query('ROLLBACK');
        throw lockErr;
      } finally {
        clientNfe.release();
      }

      // Busca venda + itens com dados do produto
      const [vendaResult, itensResult] = await Promise.all([
        pool.query(
          `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [vendaId, empresaResolvida.id, empresaResolvida.nome]
        ),
        pool.query(
          `SELECT vi.*, p.ncm, p.cfop_padrao, p.origem, p.unidade,
                  p.icms_cst, p.icms_aliquota, p.icms_base_calculo,
                  p.pis_cst, p.pis_aliquota, p.cofins_cst, p.cofins_aliquota,
                  p.ipi_cst, p.ipi_aliquota, p.gtin
           FROM venda_itens vi
           LEFT JOIN produtos p ON p.id = vi.produto_id AND (p.empresa_id = $2 OR (p.empresa_id IS NULL AND p.empresa = $3))
           WHERE vi.venda_id = $1
             AND (vi.empresa_id = $2 OR (vi.empresa_id IS NULL AND vi.empresa = $3))`,
          [vendaId, empresaResolvida.id, empresaResolvida.nome]
        )
      ]);

      if (vendaResult.rowCount === 0) return erro(res, 404, 'Venda não encontrada');

      const venda  = vendaResult.rows[0];
      const itens  = itensResult.rows;
      const empresa = await obterEmpresa(empresaResolvida.id);

      // Validações mínimas
      if (!empresa.cnpj) return erro(res, 400, 'Cadastre o CNPJ da empresa em Configurações → NF-e');
      if (!empresa.logradouro || !empresa.municipio || !empresa.uf) {
        return erro(res, 400, 'Preencha o endereço completo da empresa em Configurações → NF-e');
      }

      const ncmFaltando = itens.filter((i) => !i.ncm || i.ncm.trim() === '');
      if (ncmFaltando.length > 0) {
        const nomes = ncmFaltando.map((i) => i.produto_nome).join(', ');
        return erro(res, 400, `NCM não informado para: ${nomes}. Edite os produtos e preencha o NCM.`);
      }

      // Busca cliente se houver
      let cliente = null;
      if (venda.cliente_id) {
        const cliResult = await pool.query(
          `SELECT * FROM clientes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [venda.cliente_id, empresaResolvida.id, empresaResolvida.nome]
        );
        if (cliResult.rowCount > 0) cliente = cliResult.rows[0];
      }

      // Monta payload (ref já gerado e 'processando' registrado no advisory lock acima)
      const payload = montarPayloadNfe({ venda, itens, empresa, cliente, nfeConfig: config });

      // Envia ao Focus NFe
      const resposta = await emitirNfe(config.token_focusnfe, config.ambiente, ref, payload);

      let statusFinal = 'processando';
      let chave = null;
      let numero = null;
      let serie = null;
      let mensagem = null;

      if (resposta.ok || resposta.status === 201 || resposta.status === 200) {
        const d = resposta.data;
        statusFinal = d.status === 'autorizado' ? 'autorizado'
                    : d.status === 'processando_autorizacao' ? 'processando'
                    : d.status || 'processando';
        chave   = d.chave_nfe || null;
        numero  = d.numero_nfe || null;
        serie   = d.serie || null;
        mensagem = d.mensagem_sefaz || d.status_sefaz || null;
      } else {
        statusFinal = 'erro';
        mensagem = resposta.data?.erros?.[0]?.mensagem
          || resposta.data?.mensagem
          || `HTTP ${resposta.status}`;
      }

      await salvarEmissao({
        empresa_id: empresaResolvida.id,
        venda_id: vendaId,
        ref,
        ambiente: config.ambiente,
        status: statusFinal,
        chave_nfe: chave,
        numero,
        serie,
        mensagem
      });

      return ok(res, {
        ref,
        status: statusFinal,
        chave_nfe: chave,
        numero,
        serie,
        mensagem,
        ambiente: config.ambiente === 1 ? 'producao' : 'homologacao'
      });
    } catch (err) {
      if (err.code === 'FISCAL_PROD_BLOCKED') return erro(res, 403, err.message);
      console.error('[nfe] POST emitir:', err.message);
      return erro(res, 500, 'Erro ao emitir NF-e');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /nfe/consultar/:ref — sincroniza status do Focus NFe
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/consultar/:ref', auth, requirePermissao(pool, 'nfe', 'ver'), async (req, res) => {
    try {
      const ref = req.params.ref;
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const emissaoResult = await pool.query(
        `SELECT * FROM nfe_emissoes WHERE ref = $1 AND empresa_id = $2`,
        [ref, empresaResolvida.id]
      );
      if (emissaoResult.rowCount === 0) return erro(res, 404, 'NF-e não encontrada');

      const emissao = emissaoResult.rows[0];
      const config  = await obterConfigNfe(empresaResolvida.id);
      if (!config?.token_focusnfe) return erro(res, 400, 'Token Focus NFe não configurado');

      const resposta = await consultarNfe(config.token_focusnfe, emissao.ambiente, ref);
      const d = resposta.data;

      const statusFinal = d.status === 'autorizado'   ? 'autorizado'
                        : d.status === 'cancelado'    ? 'cancelado'
                        : d.status === 'denegado'     ? 'rejeitado'
                        : d.status || emissao.status;

      await pool.query(
        `UPDATE nfe_emissoes SET status=$1, chave_nfe=COALESCE($2,chave_nfe),
         numero=COALESCE($3,numero), serie=COALESCE($4,serie),
         mensagem=$5, atualizado_em=NOW() WHERE ref=$6 AND empresa_id=$7`,
        [statusFinal, d.chave_nfe || null, d.numero_nfe || null, d.serie || null,
         d.mensagem_sefaz || null, ref, empresaResolvida.id]
      );

      return ok(res, { ref, status: statusFinal, chave_nfe: d.chave_nfe, mensagem: d.mensagem_sefaz });
    } catch (err) {
      console.error('[nfe] GET consultar:', err.message);
      return erro(res, 500, 'Erro ao consultar NF-e');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /nfe/cancelar/:nfeId
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/cancelar/:nfeId', auth, writeRateLimiter, requirePermissao(pool, 'nfe', 'cancelar'), async (req, res) => {
    try {
      const nfeId = Number(req.params.nfeId);
      const { justificativa } = req.body;

      if (!justificativa || justificativa.trim().length < 15) {
        return erro(res, 400, 'Informe uma justificativa com ao menos 15 caracteres');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const emissaoResult = await pool.query(
        `SELECT * FROM nfe_emissoes WHERE id = $1 AND empresa_id = $2`,
        [nfeId, empresaResolvida.id]
      );
      if (emissaoResult.rowCount === 0) return erro(res, 404, 'NF-e não encontrada');

      const emissao = emissaoResult.rows[0];
      if (emissao.status !== 'autorizado') {
        return erro(res, 400, `NF-e não pode ser cancelada no status "${emissao.status}"`);
      }

      const config = await obterConfigNfe(empresaResolvida.id);
      if (!config?.token_focusnfe) return erro(res, 400, 'Token Focus NFe não configurado');

      const resposta = await cancelarNfe(config.token_focusnfe, emissao.ambiente, emissao.ref, justificativa.trim());
      const d = resposta.data;

      const cancelado = d.status === 'cancelado';

      await pool.query(
        `UPDATE nfe_emissoes SET
           status = $1, mensagem = $2,
           cancelado_em = $3,
           motivo_cancelamento = $4,
           atualizado_em = NOW()
         WHERE id = $5 AND empresa_id = $6`,
        [
          cancelado ? 'cancelado' : emissao.status,
          d.mensagem_sefaz || null,
          cancelado ? new Date() : null,
          cancelado ? justificativa.trim() : null,
          nfeId,
          empresaResolvida.id
        ]
      );

      if (!cancelado) {
        return erro(res, 400, `Focus NFe: ${d.mensagem_sefaz || 'Cancelamento não aprovado pela SEFAZ'}`);
      }

      return ok(res, { mensagem: 'NF-e cancelada com sucesso', chave_nfe: emissao.chave_nfe });
    } catch (err) {
      console.error('[nfe] POST cancelar:', err.message);
      return erro(res, 500, 'Erro ao cancelar NF-e');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /nfe/lista
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/lista', auth, requirePermissao(pool, 'nfe', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { status } = req.query;
      const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);
      const pagina = Math.max(Number(req.query.pagina) || 1, 1);
      const offset = (pagina - 1) * limite;

      const params = [empresaResolvida.id, limite, offset];
      let filtroStatus = '';
      if (status) {
        filtroStatus = ' AND n.status = $4';
        params.push(status);
      }

      const result = await pool.query(
        `SELECT n.*, v.total AS venda_total, v.cliente_nome
         FROM nfe_emissoes n
         LEFT JOIN vendas v ON v.id = n.venda_id
         WHERE n.empresa_id = $1 ${filtroStatus}
         ORDER BY n.criado_em DESC
         LIMIT $2 OFFSET $3`,
        params
      );

      const total = await pool.query(
        `SELECT COUNT(*) AS total FROM nfe_emissoes WHERE empresa_id = $1 ${filtroStatus ? 'AND status = $2' : ''}`,
        status ? [empresaResolvida.id, status] : [empresaResolvida.id]
      );

      return ok(res, {
        nfes: result.rows,
        total: Number(total.rows[0].total),
        pagina: Number(pagina),
        limite: Number(limite)
      });
    } catch (err) {
      console.error('[nfe] GET lista:', err.message);
      return erro(res, 500, 'Erro ao listar NF-es');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /nfe/pdf/:ref — proxy DANFE
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/pdf/:ref', auth, requirePermissao(pool, 'nfe', 'ver'), async (req, res) => {
    try {
      const ref = req.params.ref;
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const emissaoResult = await pool.query(
        `SELECT * FROM nfe_emissoes WHERE ref = $1 AND empresa_id = $2`,
        [ref, empresaResolvida.id]
      );
      if (emissaoResult.rowCount === 0) return erro(res, 404, 'NF-e não encontrada');

      const emissao = emissaoResult.rows[0];
      const config = await obterConfigNfe(empresaResolvida.id);
      if (!config?.token_focusnfe) return erro(res, 400, 'Token não configurado');

      const pdf = await downloadDanfe(config.token_focusnfe, emissao.ambiente, ref);
      if (!pdf) return erro(res, 404, 'DANFE não disponível');

      res.set('Content-Type', pdf.contentType || 'application/pdf');
      res.set('Content-Disposition', `inline; filename="danfe-${ref}.pdf"`);
      return res.send(pdf.buffer);
    } catch (err) {
      console.error('[nfe] GET pdf:', err.message);
      return erro(res, 500, 'Erro ao baixar DANFE');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /nfe/xml/:ref — proxy XML
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/xml/:ref', auth, requirePermissao(pool, 'nfe', 'ver'), async (req, res) => {
    try {
      const ref = req.params.ref;
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const emissaoResult = await pool.query(
        `SELECT * FROM nfe_emissoes WHERE ref = $1 AND empresa_id = $2`,
        [ref, empresaResolvida.id]
      );
      if (emissaoResult.rowCount === 0) return erro(res, 404, 'NF-e não encontrada');

      const emissao = emissaoResult.rows[0];
      const config = await obterConfigNfe(empresaResolvida.id);
      if (!config?.token_focusnfe) return erro(res, 400, 'Token não configurado');

      const xml = await downloadXml(config.token_focusnfe, emissao.ambiente, ref);
      if (!xml) return erro(res, 404, 'XML não disponível');

      res.set('Content-Type', 'application/xml');
      res.set('Content-Disposition', `attachment; filename="nfe-${ref}.xml"`);
      return res.send(xml.text);
    } catch (err) {
      console.error('[nfe] GET xml:', err.message);
      return erro(res, 500, 'Erro ao baixar XML');
    }
  });

  return router;
};
