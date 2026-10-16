# Correções de segurança e desempenho — 16/10/2026

O backend agora revalida usuário, perfil, empresa, versão de senha e blacklist compartilhada antes de executar rotas autenticadas. Gerentes não criam administradores nem delegam permissões; mudanças de delegação revogam sessões na mesma transação. Logout confirma persistência antes de responder sucesso. Portal e SSE respeitam revogação e expiração.

Saídas HTTP validam CIDRs IPv4/IPv6 e usam IPs aprovados no transporte; redirects entre origens são bloqueados. Respostas externas têm limite de 2 MB e timeout de 15 segundos (ou prazo menor enviado pelo chamador). Configurar integrações com sua URL final.

Consultas de BI deixam de duplicar tendência ou devolver zeros em falhas. Notificações compartilham payload por empresa. Paginação de contas a receber aceita `incluir_recebidos_parciais=false` para dispensar o total global que não é usado pela listagem. Helpers financeiros reutilizam o client em transações; rate limiters expurgam buckets antigos em lotes.

**Runtime e schema:** Node **24.x**, migrations aditivas **061** e **062**, aplicadas pelo runner de startup existente. A manutenção diária fica registrada no banco e recupera execuções perdidas no boot, com retry a cada 5 minutos. Verificar eventual override `NODE_VERSION` na plataforma.

**Validação:** 50 suítes / 599 testes backend em instalação limpa e diretório isolado; zero vulnerabilidades no audit completo da instalação; smoke passou. Testes de navegador pertencem ao frontend e rodam separadamente com `node --test`, sem checkout cruzado.

`loja.db` saiu do versionamento corrente com o arquivo local preservado; histórico e eventual reutilização de credenciais antigas devem ser revisados separadamente. Não houve reescrita de histórico, alteração de dados reais ou validação de migração em produção nesta etapa.
