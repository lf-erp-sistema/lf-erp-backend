/**
 * NFC-e (modelo 65) — LF ERP
 * Integração com Focus NFe (focusnfe.com.br).
 *
 * Rotas (montadas em /nfce):
 *   POST   /nfce/emitir/:vendaId   — emite NFC-e para uma venda
 *   GET    /nfce/consultar/:ref    — consulta status no Focus NFe
 *   POST   /nfce/cancelar/:nfceId  — cancela NFC-e (máx 30 min após emissão)
 *   GET    /nfce/lista             — lista NFC-es da empresa
 *   GET    /nfce/pdf/:ref          — proxy DANFCE (PDF)
 */

const { emitirNfce, consultarNfce, cancelarNfce, downloadDanfce } = require('../utils/focusnfe');
const { montarPayloadNfce } = require('../utils/nfce_builder');
const { randomUUID } = require('crypto');
const { erro, ok } = require('../utils/routeHelpers');
const { decryptField } = require('../utils/pixCrypto');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  requirePermissao
}) => {
  const router = require('express').Router();



  async function obterConfigNfe(empresaId) {
    const r = await pool.query(`SELECT * FROM nfe_config WHERE empresa_id = $1`, [empresaId]);
    const config = r.rows[0] || null;
    if (config?.token_focusnfe) config.token_focusnfe = decryptField(config.token_focusnfe);
    return config;
  }

  async function obterEmpresa(empresaId) {
    const r = await pool.query(`SELECT * FROM empresas WHERE id = $1`, [empresaId]);
    return r.rows[0] || null;
  }

  async function salvarEmissao(dados) {
    const { empresa_id, venda_id, ref, ambiente, status, chave_nfe, numero, serie, mensagem } = dados;
    await pool.query(
      `INSERT INTO nfce_emissoes (empresa_id, venda_id, ref, ambiente, status, chave_nfe, numero, serie, mensagem, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (ref) DO UPDATE SET
         status = $5, chave_nfe = COALESCE($6, nfce_emissoes.chave_nfe),
         numero = COALESCE($7, nfce_emissoes.numero),
         serie  = COALESCE($8, nfce_emissoes.serie),
         mensagem = $9, atualizado_em = NOW()`,
      [empresa_id, venda_id || null, ref, ambiente, status,
       chave_nfe || null, numero || null, serie || null, mensagem || null]
    );
  }

  // ── POST /nfce/emitir/:vendaId ─────────────────────────────────────────────
  router.post('/emitir/:vendaId', auth, writeRateLimiter, requirePermissao(pool, 'nfce', 'criar'), async (req, res) => {
    try {
      const vendaId = Number(req.params.vendaId);
      if (!vendaId) return erro(res, 400, 'ID de venda inválido');

      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const config = await obterConfigNfe(empresaResolvida.id);
      if (!config?.token_focusnfe) {
        return erro(res, 400, 'Configure o token Focus NFe em Configurações → NF-e antes de emitir NFC-e.');
      }

      // Advisory lock via conexão dedicada + xact lock (liberado automaticamente no COMMIT/ROLLBACK)
      const nfceClient = await pool.connect();
      try {
        await nfceClient.query('BEGIN');
        await nfceClient.query('SELECT pg_advisory_xact_lock($1)', [vendaId]);

      // Verifica emissão duplicada (dentro da transação com lock)
      const jaEmitida = await nfceClient.query(
        `SELECT * FROM nfce_emissoes WHERE venda_id = $1 AND empresa_id = $2 AND status = 'autorizado'`,
        [vendaId, empresaResolvida.id]
      );
      if (jaEmitida.rowCount > 0) {
        await nfceClient.query('ROLLBACK');
        nfceClient.release();
        return erro(res, 400, `Esta venda já possui NFC-e autorizada. Chave: ${jaEmitida.rows[0].chave_nfe}`);
      }

      // Busca venda + itens + dados fiscais do produto
      const [vendaResult, itensResult] = await Promise.all([
        nfceClient.query(
          `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [vendaId, empresaResolvida.id, empresaResolvida.nome]
        ),
        pool.query(
          `SELECT vi.*, p.ncm, p.cfop_padrao, p.origem, p.unidade,
                  p.icms_cst, p.icms_aliquota, p.icms_base_calculo,
                  p.pis_cst, p.pis_aliquota, p.cofins_cst, p.cofins_aliquota, p.gtin
           FROM venda_itens vi
           LEFT JOIN produtos p ON p.id = vi.produto_id
           WHERE vi.venda_id = $1
             AND (vi.empresa_id = $2 OR (vi.empresa_id IS NULL AND vi.empresa = $3))`,
          [vendaId, empresaResolvida.id, empresaResolvida.nome]
        )
      ]);

      if (vendaResult.rowCount === 0) return erro(res, 404, 'Venda não encontrada');

      const venda   = vendaResult.rows[0];
      const itens   = itensResult.rows;
      const empresa = await obterEmpresa(empresaResolvida.id);

      if (!empresa.cnpj) return erro(res, 400, 'Cadastre o CNPJ da empresa em Configurações → NF-e');
      if (!empresa.logradouro || !empresa.municipio || !empresa.uf) {
        return erro(res, 400, 'Preencha o endereço completo da empresa em Configurações → NF-e');
      }

      const ncmFaltando = itens.filter(i => !i.ncm?.trim());
      if (ncmFaltando.length > 0) {
        return erro(res, 400, `NCM não informado para: ${ncmFaltando.map(i => i.produto_nome).join(', ')}`);
      }

      // Busca cliente (opcional para NFC-e)
      let cliente = null;
      if (venda.cliente_id) {
        const cliR = await pool.query(
          `SELECT * FROM clientes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [venda.cliente_id, empresaResolvida.id, empresaResolvida.nome]
        );
        if (cliR.rowCount > 0) cliente = cliR.rows[0];
      }

      const ref = `lferp-nfce-${empresaResolvida.id}-${vendaId}-${randomUUID().slice(0, 8)}`;
      const payload = montarPayloadNfce({ venda, itens, empresa, cliente, nfeConfig: config });

      await salvarEmissao({
        empresa_id: empresaResolvida.id, venda_id: vendaId, ref,
        ambiente: config.ambiente, status: 'processando',
        mensagem: 'Aguardando resposta do Focus NFe'
      });

      const resposta = await emitirNfce(config.token_focusnfe, config.ambiente, ref, payload);

      let statusFinal = 'processando', chave = null, numero = null, serie = null, mensagem = null;

      if (resposta.ok || resposta.status === 201 || resposta.status === 200) {
        const d = resposta.data;
        statusFinal = d.status === 'autorizado' ? 'autorizado'
                    : d.status === 'processando_autorizacao' ? 'processando'
                    : d.status || 'processando';
        chave    = d.chave_nfe || null;
        numero   = d.numero_nfe || null;
        serie    = d.serie || null;
        mensagem = d.mensagem_sefaz || d.status_sefaz || null;
      } else {
        statusFinal = 'erro';
        mensagem = resposta.data?.erros?.[0]?.mensagem || resposta.data?.mensagem || `HTTP ${resposta.status}`;
      }

      await salvarEmissao({
        empresa_id: empresaResolvida.id, venda_id: vendaId, ref,
        ambiente: config.ambiente, status: statusFinal,
        chave_nfe: chave, numero, serie, mensagem
      });

      await nfceClient.query('COMMIT');
      nfceClient.release();

      return ok(res, {
        ref, status: statusFinal, chave_nfe: chave, numero, serie, mensagem,
        ambiente: config.ambiente === 1 ? 'producao' : 'homologacao'
      });

      } catch (lockErr) {
        await nfceClient.query('ROLLBACK').catch(() => {});
        nfceClient.release();
        throw lockErr;
      }
    } catch (err) {
      if (err.code === 'FISCAL_PROD_BLOCKED') return erro(res, 403, err.message);
      console.error('[nfce] POST emitir:', err.message);
      return erro(res, 500, 'Erro ao emitir NFC-e');
    }
  });

  // ── GET /nfce/consultar/:ref ───────────────────────────────────────────────
  router.get('/consultar/:ref', auth, requirePermissao(pool, 'nfce', 'ver'), async (req, res) => {
    try {
      const ref = req.params.ref;
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const emissaoResult = await pool.query(
        `SELECT * FROM nfce_emissoes WHERE ref = $1 AND empresa_id = $2`,
        [ref, empresaResolvida.id]
      );
      if (emissaoResult.rowCount === 0) return erro(res, 404, 'NFC-e não encontrada');

      const emissao = emissaoResult.rows[0];
      const config  = await obterConfigNfe(empresaResolvida.id);
      if (!config?.token_focusnfe) return erro(res, 400, 'Token Focus NFe não configurado');

      const resposta = await consultarNfce(config.token_focusnfe, emissao.ambiente, ref);
      const d = resposta.data;

      const statusFinal = d.status === 'autorizado' ? 'autorizado'
                        : d.status === 'cancelado'  ? 'cancelado'
                        : d.status || emissao.status;

      await pool.query(
        `UPDATE nfce_emissoes SET status=$1, chave_nfe=COALESCE($2,chave_nfe),
         numero=COALESCE($3,numero), serie=COALESCE($4,serie),
         mensagem=$5, atualizado_em=NOW() WHERE ref=$6 AND empresa_id=$7`,
        [statusFinal, d.chave_nfe || null, d.numero_nfe || null, d.serie || null,
         d.mensagem_sefaz || null, ref, empresaResolvida.id]
      );

      return ok(res, { ref, status: statusFinal, chave_nfe: d.chave_nfe, mensagem: d.mensagem_sefaz });
    } catch (err) {
      console.error('[nfce] GET consultar:', err.message);
      return erro(res, 500, 'Erro ao consultar NFC-e');
    }
  });

  // ── POST /nfce/cancelar/:nfceId ───────────────────────────────────────────
  router.post('/cancelar/:nfceId', auth, writeRateLimiter, requirePermissao(pool, 'nfce', 'editar'), async (req, res) => {
    try {
      const nfceId = Number(req.params.nfceId);
      const { justificativa } = req.body;
      if (!justificativa || justificativa.trim().length < 15) {
        return erro(res, 400, 'Informe justificativa com ao menos 15 caracteres');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const emissaoResult = await pool.query(
        `SELECT * FROM nfce_emissoes WHERE id = $1 AND empresa_id = $2`,
        [nfceId, empresaResolvida.id]
      );
      if (emissaoResult.rowCount === 0) return erro(res, 404, 'NFC-e não encontrada');

      const emissao = emissaoResult.rows[0];
      if (emissao.status !== 'autorizado') {
        return erro(res, 400, `NFC-e não pode ser cancelada no status "${emissao.status}"`);
      }

      const config = await obterConfigNfe(empresaResolvida.id);
      if (!config?.token_focusnfe) return erro(res, 400, 'Token Focus NFe não configurado');

      const resposta = await cancelarNfce(config.token_focusnfe, emissao.ambiente, emissao.ref, justificativa.trim());
      const cancelado = resposta.data?.status === 'cancelado';

      await pool.query(
        `UPDATE nfce_emissoes SET status=$1, mensagem=$2, cancelado_em=$3, motivo_cancelamento=$4, atualizado_em=NOW()
         WHERE id=$5 AND empresa_id=$6`,
        [cancelado ? 'cancelado' : emissao.status, resposta.data?.mensagem_sefaz || null,
         cancelado ? new Date() : null, cancelado ? justificativa.trim() : null, nfceId, empresaResolvida.id]
      );

      if (!cancelado) return erro(res, 400, `Focus NFe: ${resposta.data?.mensagem_sefaz || 'Cancelamento não aprovado'}`);
      return ok(res, { mensagem: 'NFC-e cancelada com sucesso', chave_nfe: emissao.chave_nfe });
    } catch (err) {
      console.error('[nfce] POST cancelar:', err.message);
      return erro(res, 500, 'Erro ao cancelar NFC-e');
    }
  });

  // ── GET /nfce/lista ───────────────────────────────────────────────────────
  router.get('/lista', auth, requirePermissao(pool, 'nfce', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { status } = req.query;
      const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);
      const pagina = Math.max(Number(req.query.pagina) || 1, 1);
      const offset = (pagina - 1) * limite;

      const params = [empresaResolvida.id, limite, offset];
      let filtroStatus = '';
      if (status) { filtroStatus = ' AND n.status = $4'; params.push(status); }

      const result = await pool.query(
        `SELECT n.*, v.total AS venda_total, v.cliente_nome
         FROM nfce_emissoes n
         LEFT JOIN vendas v ON v.id = n.venda_id
         WHERE n.empresa_id = $1 ${filtroStatus}
         ORDER BY n.criado_em DESC
         LIMIT $2 OFFSET $3`,
        params
      );

      const totalR = await pool.query(
        `SELECT COUNT(*) AS total FROM nfce_emissoes WHERE empresa_id = $1 ${filtroStatus ? 'AND status=$2' : ''}`,
        status ? [empresaResolvida.id, status] : [empresaResolvida.id]
      );

      return ok(res, { nfces: result.rows, total: Number(totalR.rows[0].total), pagina: Number(pagina), limite: Number(limite) });
    } catch (err) {
      console.error('[nfce] GET lista:', err.message);
      return erro(res, 500, 'Erro ao listar NFC-es');
    }
  });

  // ── GET /nfce/pdf/:ref — proxy DANFCE ─────────────────────────────────────
  router.get('/pdf/:ref', auth, requirePermissao(pool, 'nfce', 'ver'), async (req, res) => {
    try {
      const ref = req.params.ref;
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const emissaoResult = await pool.query(
        `SELECT * FROM nfce_emissoes WHERE ref = $1 AND empresa_id = $2`,
        [ref, empresaResolvida.id]
      );
      if (emissaoResult.rowCount === 0) return erro(res, 404, 'NFC-e não encontrada');

      const emissao = emissaoResult.rows[0];
      const config = await obterConfigNfe(empresaResolvida.id);
      if (!config?.token_focusnfe) return erro(res, 400, 'Token não configurado');

      const pdf = await downloadDanfce(config.token_focusnfe, emissao.ambiente, ref);
      if (!pdf) return erro(res, 404, 'DANFCE não disponível');

      res.set('Content-Type', pdf.contentType || 'application/pdf');
      res.set('Content-Disposition', `inline; filename="danfce-${ref}.pdf"`);
      return res.send(pdf.buffer);
    } catch (err) {
      console.error('[nfce] GET pdf:', err.message);
      return erro(res, 500, 'Erro ao baixar DANFCE');
    }
  });

  return router;
};
