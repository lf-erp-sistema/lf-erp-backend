/**
 * NFS-e — LF ERP
 * Emissão de Nota Fiscal de Serviço Eletrônica via FocusNFe.
 *
 * Rotas:
 *   GET    /nfse/config           — configuração da empresa
 *   PUT    /nfse/config           — salvar configuração
 *   GET    /nfse/lista            — listar emissões
 *   POST   /nfse/emitir           — emitir NFS-e avulsa (sem venda)
 *   POST   /nfse/emitir/:vendaId  — emitir NFS-e a partir de uma venda
 *   GET    /nfse/consultar/:ref   — consultar status
 *   POST   /nfse/cancelar/:ref    — cancelar
 *   GET    /nfse/pdf/:ref         — DANFS-e PDF (proxy)
 */

const crypto = require('crypto');
const {
  emitirNfse, consultarNfse, cancelarNfse, downloadNfsePdf, listarNfse
} = require('../utils/focusnfe');
const { erro, ok } = require('../utils/routeHelpers');
const { encryptField, decryptField } = require('../utils/pixCrypto');

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, requirePermissao }) {
  const router = require('express').Router();



  async function getConfig(empresaId) {
    const r = await pool.query(
      `SELECT * FROM nfse_config WHERE empresa_id = $1 LIMIT 1`,
      [empresaId]
    );
    const cfg = r.rows[0] || null;
    if (cfg?.token_focus) cfg.token_focus = decryptField(cfg.token_focus);
    return cfg;
  }

  async function proximoRpsNumero(client, empresaId) {
    const r = await client.query(
      `UPDATE nfse_config SET rps_ultimo_numero = rps_ultimo_numero + 1, atualizado_em = NOW()
       WHERE empresa_id = $1 RETURNING rps_ultimo_numero`,
      [empresaId]
    );
    return r.rows[0]?.rps_ultimo_numero || 1;
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  router.get('/config', auth, requirePermissao(pool, 'nfse', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const cfg = await getConfig(empresaResolvida.id);
      if (!cfg) return ok(res, { config: null });

      return ok(res, {
        config: {
          ...cfg,
          token_focus: cfg.token_focus ? '***' : null
        }
      });
    } catch (err) {
      console.error('[nfse] GET config:', err.message);
      return erro(res, 500, 'Erro ao buscar configuração');
    }
  });

  router.put('/config', auth, writeRateLimiter, requirePermissao(pool, 'nfse', 'configurar'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const {
        token_focus, ambiente, codigo_municipio, item_lista_servico,
        aliquota_iss, incentivo_fiscal, rps_serie
      } = req.body;

      await pool.query(
        `INSERT INTO nfse_config
           (empresa_id, token_focus, ambiente, codigo_municipio, item_lista_servico,
            aliquota_iss, incentivo_fiscal, rps_serie)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (empresa_id) DO UPDATE SET
           token_focus        = COALESCE(NULLIF($2,'***'), nfse_config.token_focus),
           ambiente           = $3,
           codigo_municipio   = $4,
           item_lista_servico = $5,
           aliquota_iss       = $6,
           incentivo_fiscal   = $7,
           rps_serie          = $8,
           atualizado_em      = NOW()`,
        [
          empresaResolvida.id,
          token_focus && token_focus !== '***' ? encryptField(token_focus) : null,
          Number(ambiente || 2),
          codigo_municipio || null,
          item_lista_servico || null,
          normalizarDecimal(aliquota_iss || 5),
          Boolean(incentivo_fiscal),
          rps_serie || '1'
        ]
      );

      return ok(res, { mensagem: 'Configuração NFS-e salva' });
    } catch (err) {
      console.error('[nfse] PUT config:', err.message);
      return erro(res, 500, 'Erro ao salvar configuração');
    }
  });

  // ── Lista ──────────────────────────────────────────────────────────────────

  router.get('/lista', auth, requirePermissao(pool, 'nfse', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);
      const pagina = Math.max(Number(req.query.pagina) || 1, 1);
      const offset = (pagina - 1) * limite;

      const result = await pool.query(
        `SELECT * FROM nfse_emissoes WHERE empresa_id = $1 ORDER BY criado_em DESC LIMIT $2 OFFSET $3`,
        [empresaResolvida.id, limite, offset]
      );

      return ok(res, { emissoes: result.rows });
    } catch (err) {
      console.error('[nfse] GET lista:', err.message);
      return erro(res, 500, 'Erro ao listar NFS-e');
    }
  });

  // ── Emitir ─────────────────────────────────────────────────────────────────

  router.post('/emitir', auth, writeRateLimiter, requirePermissao(pool, 'nfse', 'emitir'), async (req, res) => {
    const client = await pool.connect();
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const cfg = await getConfig(empresaResolvida.id);
      if (!cfg?.token_focus) return erro(res, 400, 'Configure o token FocusNFe em NFS-e → Configuração');
      if (!cfg?.codigo_municipio) return erro(res, 400, 'Configure o código IBGE do município em NFS-e → Configuração');
      if (cfg.ambiente === 1 && process.env.LF_ERP_FISCAL_PRODUCTION_ENABLED !== 'true') {
        return erro(res, 403, 'Emissão fiscal em produção bloqueada. Configure LF_ERP_FISCAL_PRODUCTION_ENABLED=true no servidor.');
      }

      const {
        tomador_nome, tomador_cpf_cnpj, tomador_email,
        tomador_logradouro, tomador_numero, tomador_municipio, tomador_uf, tomador_cep,
        discriminacao, valor_servico, item_lista_servico, aliquota_iss,
        data_emissao, venda_id
      } = req.body;

      if (!tomador_nome || !valor_servico || !discriminacao) {
        return erro(res, 400, 'tomador_nome, valor_servico e discriminacao são obrigatórios');
      }

      await client.query('BEGIN');

      const rpsNum = await proximoRpsNumero(client, empresaResolvida.id);
      const ref    = `nfse_${empresaResolvida.id}_${rpsNum}_${crypto.randomBytes(4).toString('hex')}`;

      const payload = {
        data_emissao:  data_emissao || new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Fortaleza' }).format(new Date()),
        serie:         cfg.rps_serie || '1',
        rps_numero:    rpsNum,
        rps_tipo:      'RPS',
        tomador: {
          cpf_cnpj:     tomador_cpf_cnpj  || null,
          razao_social: tomador_nome,
          email:        tomador_email      || null,
          logradouro:   tomador_logradouro || null,
          numero:       tomador_numero     || null,
          municipio:    tomador_municipio  || null,
          uf:           tomador_uf         || null,
          cep:          tomador_cep ? String(tomador_cep).replace(/\D/g, '') : null
        },
        servico: {
          aliquota:             normalizarDecimal(aliquota_iss || cfg.aliquota_iss || 5),
          discriminacao,
          codigo_municipio:     cfg.codigo_municipio,
          item_lista_servico:   item_lista_servico || cfg.item_lista_servico || '01.01',
          valor_servico:        normalizarDecimal(valor_servico),
          incentivo_fiscal:     Boolean(cfg.incentivo_fiscal)
        }
      };

      // Insere registro como pendente
      const emissaoResult = await client.query(
        `INSERT INTO nfse_emissoes
           (empresa_id, venda_id, ref, rps_numero, status, valor_servico,
            tomador_nome, tomador_cpf_cnpj, discriminacao, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,'pendente',$5,$6,$7,$8,NOW(),NOW())
         RETURNING *`,
        [empresaResolvida.id, venda_id || null, ref, rpsNum,
         normalizarDecimal(valor_servico), tomador_nome,
         tomador_cpf_cnpj || null, discriminacao]
      );

      await client.query('COMMIT');

      // Envia para FocusNFe em background
      const emissao = emissaoResult.rows[0];
      const emissaoEmpresaId = emissao.empresa_id;

      emitirNfse(cfg.token_focus, cfg.ambiente, ref, payload)
        .then(async (r) => {
          const statusBody = r.data?.situacao || r.data?.status;
          const status = (r.ok && (statusBody === 'autorizado' || statusBody === 'autorizada'))
            ? 'autorizada' : 'erro';
          await pool.query(
            `UPDATE nfse_emissoes SET
               status = $1,
               numero_nfse = $2,
               link_pdf = $3,
               codigo_verificacao = $4,
               mensagem_erro = $5,
               atualizado_em = NOW()
             WHERE ref = $6 AND empresa_id = $7`,
            [
              status,
              r.data?.numero_nfse || null,
              r.data?.caminho_pdf_nota_fiscal || null,
              r.data?.codigo_verificacao || null,
              status === 'erro' ? JSON.stringify(r.data?.erros || r.data) : null,
              ref,
              emissaoEmpresaId
            ]
          );
        })
        .catch((e) => console.error('[nfse] emissão assíncrona:', e.message));

      return res.status(201).json({
        sucesso: true,
        emissao,
        mensagem: 'NFS-e enviada para processamento. Consulte o status em alguns segundos.'
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[nfse] POST emitir:', err.message);
      return erro(res, 500, 'Erro ao emitir NFS-e');
    } finally {
      client.release();
    }
  });

  // ── Consultar ──────────────────────────────────────────────────────────────

  router.get('/consultar/:ref', auth, requirePermissao(pool, 'nfse', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { ref } = req.params;

      const emissaoCheck = await pool.query(
        `SELECT id FROM nfse_emissoes WHERE ref = $1 AND empresa_id = $2 LIMIT 1`,
        [ref, empresaResolvida.id]
      );
      if (emissaoCheck.rowCount === 0) return erro(res, 404, 'NFS-e não encontrada');

      const cfg = await getConfig(empresaResolvida.id);
      if (!cfg?.token_focus) return erro(res, 400, 'FocusNFe não configurado');

      const r = await consultarNfse(cfg.token_focus, cfg.ambiente, ref);

      // Atualiza status no banco
      if (r.ok) {
        const _statusSefaz = r.data?.status_sefaz;
        const STATUS_SEFAZ_MAP = { '100': 'autorizada', '101': 'cancelada', '135': 'cancelada', '150': 'cancelada' };
        const status = STATUS_SEFAZ_MAP[_statusSefaz] || (_statusSefaz ? 'erro' : 'pendente');
        await pool.query(
          `UPDATE nfse_emissoes SET
             status = $1, numero_nfse = $2,
             link_pdf = $3, codigo_verificacao = $4, atualizado_em = NOW()
           WHERE ref = $5 AND empresa_id = $6`,
          [status, r.data?.numero_nfse || null, r.data?.caminho_pdf_nota_fiscal || null,
           r.data?.codigo_verificacao || null, ref, empresaResolvida.id]
        );
      }

      return ok(res, { ref, status: r.data });
    } catch (err) {
      console.error('[nfse] GET consultar:', err.message);
      return erro(res, 500, 'Erro ao consultar NFS-e');
    }
  });

  // ── Cancelar ───────────────────────────────────────────────────────────────

  router.post('/cancelar/:ref', auth, writeRateLimiter, requirePermissao(pool, 'nfse', 'cancelar'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { ref } = req.params;

      const emissaoCheck = await pool.query(
        `SELECT id, status FROM nfse_emissoes WHERE ref = $1 AND empresa_id = $2 LIMIT 1`,
        [ref, empresaResolvida.id]
      );
      if (emissaoCheck.rowCount === 0) return erro(res, 404, 'NFS-e não encontrada');
      const statusAtual = emissaoCheck.rows[0].status;
      if (statusAtual === 'cancelada') return erro(res, 400, 'NFS-e já está cancelada');
      if (statusAtual !== 'autorizada') return erro(res, 400, `NFS-e não pode ser cancelada no status "${statusAtual}"`);

      const cfg = await getConfig(empresaResolvida.id);
      if (!cfg?.token_focus) return erro(res, 400, 'FocusNFe não configurado');

      const r = await cancelarNfse(cfg.token_focus, cfg.ambiente, ref);

      // Verifica status real no body — HTTP 200 (r.ok) não garante aprovação
      // pela prefeitura; é necessário confirmar o campo de status no retorno.
      const statusSefaz = r.data?.status_sefaz;
      const situacao    = r.data?.situacao || r.data?.status;
      const SEFAZ_CANCELADOS = { '101': true, '135': true, '150': true };
      const cancelado = r.ok && (
        situacao === 'cancelado' || situacao === 'cancelada' ||
        SEFAZ_CANCELADOS[statusSefaz]
      );

      if (!cancelado) {
        return erro(res, 422,
          r.data?.mensagem || r.data?.erros?.[0]?.mensagem || 'FocusNFe recusou o cancelamento'
        );
      }

      await pool.query(
        `UPDATE nfse_emissoes SET status = 'cancelada', atualizado_em = NOW()
         WHERE ref = $1 AND empresa_id = $2`,
        [ref, empresaResolvida.id]
      );

      return ok(res, { ref, mensagem: 'NFS-e cancelada', detalhe: r.data });
    } catch (err) {
      console.error('[nfse] POST cancelar:', err.message);
      return erro(res, 500, 'Erro ao cancelar NFS-e');
    }
  });

  // ── PDF ────────────────────────────────────────────────────────────────────

  router.get('/pdf/:ref', auth, requirePermissao(pool, 'nfse', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const emissaoCheck = await pool.query(
        `SELECT id FROM nfse_emissoes WHERE ref = $1 AND empresa_id = $2 LIMIT 1`,
        [req.params.ref, empresaResolvida.id]
      );
      if (emissaoCheck.rowCount === 0) return erro(res, 404, 'NFS-e não encontrada');

      const cfg = await getConfig(empresaResolvida.id);
      if (!cfg?.token_focus) return erro(res, 400, 'FocusNFe não configurado');

      const result = await downloadNfsePdf(cfg.token_focus, cfg.ambiente, req.params.ref);
      if (!result) return erro(res, 404, 'PDF não disponível');

      res.setHeader('Content-Type', result.contentType || 'application/pdf');
      res.send(result.buffer);
    } catch (err) {
      console.error('[nfse] GET pdf:', err.message);
      return erro(res, 500, 'Erro ao baixar PDF');
    }
  });

  return router;
};
