'use strict';

const { createEmpresaUtils } = require('../utils/empresa');

function mockPool(rows) {
  return { query: jest.fn().mockResolvedValue({ rowCount: rows.length, rows }) };
}

describe('obterEmpresaPorId', () => {
  test('retorna null para id falsy (0/null/undefined) sem consultar o banco', async () => {
    const pool = mockPool([]);
    const { obterEmpresaPorId } = createEmpresaUtils(pool);
    expect(await obterEmpresaPorId(0)).toBeNull();
    expect(await obterEmpresaPorId(null)).toBeNull();
    expect(await obterEmpresaPorId(undefined)).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('retorna null quando a empresa não existe', async () => {
    const pool = mockPool([]);
    const { obterEmpresaPorId } = createEmpresaUtils(pool);
    expect(await obterEmpresaPorId(999)).toBeNull();
  });

  test('retorna {id, nome} quando a empresa existe', async () => {
    const pool = mockPool([{ id: 1, nome: 'Lucileide Variedades' }]);
    const { obterEmpresaPorId } = createEmpresaUtils(pool);
    const r = await obterEmpresaPorId(1);
    expect(r).toEqual({ id: 1, nome: 'Lucileide Variedades' });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), [1]);
  });
});

describe('obterEmpresaPorNome', () => {
  test('retorna null para nome falsy (""/null/undefined) sem consultar o banco', async () => {
    const pool = mockPool([]);
    const { obterEmpresaPorNome } = createEmpresaUtils(pool);
    expect(await obterEmpresaPorNome('')).toBeNull();
    expect(await obterEmpresaPorNome(null)).toBeNull();
    expect(await obterEmpresaPorNome(undefined)).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('retorna null quando a empresa não existe', async () => {
    const pool = mockPool([]);
    const { obterEmpresaPorNome } = createEmpresaUtils(pool);
    expect(await obterEmpresaPorNome('Empresa Fantasma')).toBeNull();
  });

  test('retorna {id, nome} quando a empresa existe (match case-insensitive é feito no SQL)', async () => {
    const pool = mockPool([{ id: 2, nome: 'Lucileide Variedades' }]);
    const { obterEmpresaPorNome } = createEmpresaUtils(pool);
    const r = await obterEmpresaPorNome('lucileide variedades');
    expect(r).toEqual({ id: 2, nome: 'Lucileide Variedades' });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('LOWER(nome) = LOWER($1)'), ['lucileide variedades']);
  });
});

describe('resolverEmpresaRequest — prioridade das fontes', () => {
  test('empresaIdInformado tem prioridade sobre tudo', async () => {
    const pool = mockPool([{ id: 5, nome: 'Empresa Por Id' }]);
    const { resolverEmpresaRequest } = createEmpresaUtils(pool);
    const req = { body: {}, query: {}, params: {}, user: { empresa_id: 1, empresa: 'Outra' } };
    const r = await resolverEmpresaRequest(req, 'Nome Informado', 5);
    expect(r).toEqual({ id: 5, nome: 'Empresa Por Id' });
  });

  test('cai para empresaInformada (nome) quando nenhum id é informado', async () => {
    const pool = mockPool([{ id: 6, nome: 'Nome Informado' }]);
    const { resolverEmpresaRequest } = createEmpresaUtils(pool);
    const req = { body: {}, query: {}, params: {}, user: { empresa_id: 1, empresa: 'Outra' } };
    const r = await resolverEmpresaRequest(req, 'Nome Informado', null);
    expect(r).toEqual({ id: 6, nome: 'Nome Informado' });
  });

  test('cai para req.user.empresa_id quando nada foi informado explicitamente', async () => {
    const pool = mockPool([{ id: 1, nome: 'Empresa Do Usuario' }]);
    const { resolverEmpresaRequest } = createEmpresaUtils(pool);
    const req = { body: {}, query: {}, params: {}, user: { empresa_id: 1 } };
    const r = await resolverEmpresaRequest(req, null, null);
    expect(r).toEqual({ id: 1, nome: 'Empresa Do Usuario' });
  });

  test('cai para req.user.empresa (nome legado) quando não há empresa_id', async () => {
    const pool = mockPool([{ id: 1, nome: 'Empresa Legado' }]);
    const { resolverEmpresaRequest } = createEmpresaUtils(pool);
    const req = { body: {}, query: {}, params: {}, user: { empresa: 'Empresa Legado' } };
    const r = await resolverEmpresaRequest(req, null, null);
    expect(r).toEqual({ id: 1, nome: 'Empresa Legado' });
  });

  test('lê empresa_id de req.body/query/params quando empresaIdInformado não foi passado', async () => {
    const pool = mockPool([{ id: 9, nome: 'Via Body' }]);
    const { resolverEmpresaRequest } = createEmpresaUtils(pool);
    const req = { body: { empresa_id: 9 }, query: {}, params: {}, user: {} };
    const r = await resolverEmpresaRequest(req, null, null);
    expect(r).toEqual({ id: 9, nome: 'Via Body' });
  });

  test('retorna null quando nenhuma fonte resolve uma empresa', async () => {
    const pool = mockPool([]);
    const { resolverEmpresaRequest } = createEmpresaUtils(pool);
    const req = { body: {}, query: {}, params: {}, user: {} };
    const r = await resolverEmpresaRequest(req, null, null);
    expect(r).toBeNull();
  });
});

describe('validarAcessoEmpresa — mecanismo central de isolamento multiempresa', () => {
  test('BLOQUEIA: usuário comum não pode acessar empresa de outro id (IDOR horizontal)', async () => {
    // Usuário autenticado pertence à empresa 1, mas tenta explicitamente acessar a empresa 2
    // (ex. meio de um empresa_id manipulado no body/query da requisição).
    const pool = mockPool([{ id: 2, nome: 'Empresa Alvo' }]);
    const { validarAcessoEmpresa } = createEmpresaUtils(pool);
    const req = { user: { empresa_id: 1, empresa: 'Minha Empresa', is_saas_owner: false } };
    const r = await validarAcessoEmpresa(req, null, 2);
    expect(r).toBeNull();
  });

  test('BLOQUEIA: usuário comum não pode acessar empresa de outro nome (IDOR horizontal)', async () => {
    const pool = mockPool([{ id: 2, nome: 'Empresa Da Concorrente' }]);
    const { validarAcessoEmpresa } = createEmpresaUtils(pool);
    const req = { user: { empresa_id: 1, empresa: 'Minha Empresa', is_saas_owner: false } };
    const r = await validarAcessoEmpresa(req, 'Empresa Da Concorrente', null);
    expect(r).toBeNull();
  });

  test('PERMITE: usuário comum acessando a própria empresa via empresa_id', async () => {
    const pool = mockPool([{ id: 1, nome: 'Minha Empresa' }]);
    const { validarAcessoEmpresa } = createEmpresaUtils(pool);
    const req = { user: { empresa_id: 1, empresa: 'Minha Empresa', is_saas_owner: false } };
    const r = await validarAcessoEmpresa(req, null, 1);
    expect(r).toEqual({ id: 1, nome: 'Minha Empresa' });
  });

  test('PERMITE: usuário legado (só empresa TEXT, sem empresa_id) acessando a própria empresa por nome', async () => {
    const pool = mockPool([{ id: 1, nome: 'Empresa Legado' }]);
    const { validarAcessoEmpresa } = createEmpresaUtils(pool);
    const req = { user: { empresa_id: null, empresa: 'Empresa Legado', is_saas_owner: false } };
    const r = await validarAcessoEmpresa(req, null, null);
    expect(r).toEqual({ id: 1, nome: 'Empresa Legado' });
  });

  test('PERMITE: match só por id também libera, mesmo com nome do token divergente (dual-key)', async () => {
    const pool = mockPool([{ id: 1, nome: 'Nome Atualizado No Banco' }]);
    const { validarAcessoEmpresa } = createEmpresaUtils(pool);
    const req = { user: { empresa_id: 1, empresa: 'Nome Antigo No Token', is_saas_owner: false } };
    const r = await validarAcessoEmpresa(req, null, 1);
    expect(r).toEqual({ id: 1, nome: 'Nome Atualizado No Banco' });
  });

  test('BLOQUEIA: nenhuma fonte resolve empresa (resolverEmpresaRequest retorna null)', async () => {
    const pool = mockPool([]);
    const { validarAcessoEmpresa } = createEmpresaUtils(pool);
    const req = { user: { empresa_id: 1, empresa: 'Minha Empresa', is_saas_owner: false } };
    const r = await validarAcessoEmpresa(req, null, null);
    expect(r).toBeNull();
  });

  test('SAAS OWNER: pula a checagem de pertencimento e pode resolver qualquer empresa', async () => {
    const pool = mockPool([{ id: 2, nome: 'Empresa De Outro Cliente' }]);
    const { validarAcessoEmpresa } = createEmpresaUtils(pool);
    const req = { user: { empresa_id: 1, empresa: 'Empresa Do Owner', is_saas_owner: true } };
    const r = await validarAcessoEmpresa(req, null, 2);
    expect(r).toEqual({ id: 2, nome: 'Empresa De Outro Cliente' });
  });
});

describe('adicionarFiltroEmpresaSaaS — fragmento SQL dual-key (empresa_id + empresa legado)', () => {
  test('sem alias: usa as colunas sem prefixo e numera os placeholders a partir do array vazio', () => {
    const pool = {};
    const { adicionarFiltroEmpresaSaaS } = createEmpresaUtils(pool);
    const params = [];
    const sql = adicionarFiltroEmpresaSaaS({ params, empresaResolvida: { id: 7, nome: 'Empresa X' } });
    expect(params).toEqual([7, 'Empresa X']);
    expect(sql).toContain('empresa_id = $1');
    expect(sql).toContain('empresa_id IS NULL');
    expect(sql).toContain('empresa = $2');
  });

  test('com alias: prefixa as colunas e numera os placeholders considerando params já existentes', () => {
    const pool = {};
    const { adicionarFiltroEmpresaSaaS } = createEmpresaUtils(pool);
    const params = ['filtro-ja-existente'];
    const sql = adicionarFiltroEmpresaSaaS({ alias: 'v', params, empresaResolvida: { id: 3, nome: 'Empresa Y' } });
    expect(params).toEqual(['filtro-ja-existente', 3, 'Empresa Y']);
    expect(sql).toContain('v.empresa_id = $2');
    expect(sql).toContain('v.empresa_id IS NULL');
    expect(sql).toContain('v.empresa = $3');
  });

  test('empresaResolvida.id é sempre coagido para Number', () => {
    const pool = {};
    const { adicionarFiltroEmpresaSaaS } = createEmpresaUtils(pool);
    const params = [];
    adicionarFiltroEmpresaSaaS({ params, empresaResolvida: { id: '42', nome: 'Empresa Z' } });
    expect(params[0]).toBe(42);
    expect(typeof params[0]).toBe('number');
  });
});

describe('podeGerenciarUsuarios / podeGerenciarFinanceiro / podeGerenciarCompras', () => {
  const { podeGerenciarUsuarios, podeGerenciarFinanceiro, podeGerenciarCompras } = createEmpresaUtils({});

  test.each([podeGerenciarUsuarios, podeGerenciarFinanceiro, podeGerenciarCompras])(
    'admin e gerente podem; funcionario e tipos desconhecidos não podem',
    (fn) => {
      expect(fn({ user: { tipo: 'admin' } })).toBe(true);
      expect(fn({ user: { tipo: 'gerente' } })).toBe(true);
      expect(fn({ user: { tipo: 'funcionario' } })).toBe(false);
      expect(fn({ user: { tipo: 'xyz_fake' } })).toBe(false);
      expect(fn({ user: {} })).toBe(false);
    }
  );
});

describe('podeGerenciarVendas', () => {
  const { podeGerenciarVendas } = createEmpresaUtils({});

  test('admin, gerente e funcionario podem', () => {
    expect(podeGerenciarVendas({ user: { tipo: 'admin' } })).toBe(true);
    expect(podeGerenciarVendas({ user: { tipo: 'gerente' } })).toBe(true);
    expect(podeGerenciarVendas({ user: { tipo: 'funcionario' } })).toBe(true);
  });

  test('tipos desconhecidos não podem', () => {
    expect(podeGerenciarVendas({ user: { tipo: 'xyz_fake' } })).toBe(false);
    expect(podeGerenciarVendas({ user: {} })).toBe(false);
  });
});
