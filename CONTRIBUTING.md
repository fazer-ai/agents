# Contribuindo

**Português (Brasil)** · [English](CONTRIBUTING-en.md)


Obrigado pelo interesse em contribuir com o **fazer.ai agents**! Bug reports, correções, testes e documentação são bem-vindos.

## Como este repositório funciona

Este repositório é gerado a partir de um monorepo master interno, de onde saem a edição Free (open-source, Apache 2.0), a edição Pro (comercial) e os demais artefatos de distribuição. O espelhamento aparece no histórico como commits `Sync free (agents@<sha>)` do `fazer-ai-bot`.

Isso muda pouco para quem contribui, mas explica duas coisas:

- **Sua PR é aceita aqui, no repositório público.** Depois do merge, a mudança é reintegrada no master com a **sua autoria preservada** e o espelhamento seguinte regenera a árvore já com ela. Seu commit permanece no histórico deste repositório.
- **Nem todo arquivo do master existe aqui.** Funcionalidades da edição Pro são removidas na derivação (ou viram stubs que retornam 403, atrás de um `ProGate` na UI). PRs que reconstruam funcionalidade Pro não são aceitas; fora isso, toda a superfície Free é código de verdade, aberto a contribuição.

## Issues

- Procure issues existentes (abertas e fechadas) antes de abrir uma nova.
- Para bugs, inclua: passos de reprodução, comportamento esperado, comportamento observado e logs relevantes. Issues como a [#2](https://github.com/fazer-ai/agents/issues/2) são um bom modelo.
- **Uma issue, uma coisa.** Dimensione a issue para que uma única pull request consiga fechá-la. Trabalho que se divide em várias pull requests são várias issues: issue que ninguém consegue fechar é issue que ninguém consegue terminar, e ela para de conseguir dizer o que falta. Isso é sobre como escrever uma, não uma exigência de que toda pull request tenha issue.
- **Vulnerabilidades de segurança não vão em issue pública:** escreva para [support@fazer.ai](mailto:support@fazer.ai).

## Pull requests

1. Para mudanças grandes, abra uma issue antes, para alinhar a abordagem e evitar retrabalho. Não é preciso pedir permissão para contribuir nem esperar resposta para começar: se preferir adiantar, mande a PR junto da issue, ou direto a PR. A issue serve para combinar o "como", e quem escreve código antes desse alinhamento assume o risco de descartar parte dele, o que é normal.
2. Prefira PRs pequenas e focadas: uma mudança lógica por PR.
3. **Testes acompanham fixes e features.** O ideal são testes que falham sem a mudança e passam com ela, provando que pinam o comportamento.
4. Rode `bun check` antes de submeter (lint, type-check, i18n e testes, o mesmo que o CI roda).
5. Mensagens de commit seguem [Conventional Commits](https://www.conventionalcommits.org/pt-br/) (`fix(escopo): ...`, `feat(escopo): ...`).
6. Texto de UI passa pelo i18n (`bun i18n:extract`, chaves em pt-BR e en); veja [`docs/i18n.md`](docs/i18n.md).

## Setup de desenvolvimento

O passo a passo está no [README](README.md#desenvolvimento-local). Em resumo:

```bash
bun install
cp .env.example .env      # DATABASE_URL, MIGRATION_DATABASE_URL, ENCRYPTION_KEY
docker compose up -d      # PostgreSQL (pgvector)
bun db:bootstrap          # role de runtime + grants
bun prisma:migrate
bun dev                   # http://localhost:3000
```

Guias por subsistema vivem em [`docs/`](docs/); leia o do subsistema que você for tocar.

## Estilo de código

- Biome formata e linta (`bun lint`, `bun format`): 2 espaços, LF.
- TypeScript estrito; alias `@/` aponta para `src/`.
- Comentários apenas quando estritamente necessários, nunca redundantes.

## CLA (Contributor License Agreement)

O projeto é distribuído em duas edições geradas do mesmo master: a Free (Apache 2.0) e a Pro (comercial). Para que a sua contribuição possa ser reintegrada no master e distribuída nas duas, pedimos a concordância com o [CLA](https://github.com/fazer-ai/agents/blob/main/CLA.md), um license grant que autoriza esse uso **sem transferir a titularidade**: o código continua seu.

**Ao submeter uma pull request, você declara que leu e concorda com o [CLA](https://github.com/fazer-ai/agents/blob/main/CLA.md)** para essa contribuição e as futuras.
