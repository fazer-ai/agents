# Ocultar conversas de grupos na tela web

## Objetivo

Remover conversas de grupos do WhatsApp da tela web de conversas do `fazer.ai agents`. A mudança deve preservar o comportamento atual do MCP, dos demais consumidores internos e da consulta padrão do serviço, que continuam podendo listar essas conversas.

## Escopo

A alteração afeta somente a listagem em `ConversationsPage`. Conversas de grupos continuam espelhadas no banco, disponíveis para diagnóstico e acessíveis diretamente por outros fluxos existentes. O processamento de webhooks, o gate do agente e a tela de detalhes não mudam.

## Identificação de grupos

Uma conversa será classificada como grupo quando o contato normalizado trouxer um JID do WhatsApp terminado em `@g.us` no telefone ou no identificador. A verificação será centralizada em uma função pura, com comparação sem diferenciar maiúsculas de minúsculas e sem inferência pelo nome exibido.

O modelo `Conversation` receberá o campo booleano `isGroup`, mapeado para `is_group`, com valor padrão `false`. O espelho definirá esse campo ao criar a conversa e o atualizará apenas quando o evento contiver metadados suficientes para classificar o contato. Eventos parciais não devem rebaixar uma conversa já classificada como grupo.

Uma migration preencherá os registros existentes usando `contacts.phone` e `contacts.attributes->>'identifier'`. Registros sem um marcador conhecido permanecerão como conversas individuais.

## Contrato da listagem

`ListConversationsFilter` receberá `excludeGroups?: boolean`, com padrão efetivo `false`. Quando verdadeiro, o filtro será aplicado na consulta Prisma antes de ordenação, limite e cursor. Assim, grupos não ocupam vagas da página e a paginação permanece consistente.

O endpoint REST de conversas aceitará o parâmetro opcional correspondente. A `ConversationsPage` o enviará em todas as requisições, incluindo carga inicial, busca, filtro por status e paginação. O MCP e os demais chamadores não enviarão a opção, preservando a listagem completa.

## Realtime

A tela não precisa filtrar eventos no cliente. Uma conversa de grupo nunca entra no estado local pela carga inicial. Quando um evento realtime mencionar uma conversa desconhecida, o comportamento atual faz uma nova consulta; essa consulta já aplicará `excludeGroups=true` e o grupo continuará ausente.

## Compatibilidade e segurança

- Nenhuma linha será removida do banco.
- O isolamento RLS e o uso de `runScopedOn` permanecem inalterados.
- O novo campo será tenant-scoped por pertencer a `Conversation`.
- O padrão do serviço continuará incluindo grupos, evitando mudança silenciosa no MCP e em integrações.
- O nome do contato não será usado para classificar grupos.

## Testes

A implementação seguirá TDD e cobrirá:

1. classificação de JIDs `@g.us` e rejeição de identificadores individuais;
2. persistência do marcador pelo espelho sem regressão em eventos parciais;
3. `listConversations` incluindo grupos por padrão;
4. `listConversations` excluindo grupos quando solicitado, antes da paginação;
5. contrato REST aceitando a opção usada pela tela web;
6. requisições da `ConversationsPage` enviando a exclusão na carga inicial e nas páginas seguintes.

## Critérios de aceite

- Nenhuma conversa de grupo identificada aparece na tela web de conversas.
- Conversas individuais continuam aparecendo com busca, status, ordenação e paginação corretos.
- `list_conversations` do MCP continua retornando grupos.
- Registros históricos identificáveis desaparecem da tela após a migration.
- `bun check` conclui sem erros.
