---
paths:
  - "prisma/**"
  - "prisma.config.ts"
  - "scripts/db-bootstrap.ts"
---

# Prisma / migrations constraints

- `knowledge_chunks` is **externally managed** (`tables.external` in `prisma.config.ts`): the migrate diff ignores it, so any schema change to this table (columns, indexes) must be written by hand in a migration. Never remove the external config to "fix" a diff.
- The pgvector HNSW index `knowledge_chunks_embedding_hnsw` is not modeled by Prisma. A generated migration containing `DROP INDEX "knowledge_chunks_embedding_hnsw"` is a bug — it silently kills RAG KNN retrieval; delete that statement.
- Enums: a value added with `ALTER TYPE ... ADD VALUE` cannot be used (DML/DEFAULT) in the same migration that adds it. Split add-value and first-use into separate migrations.
- Runtime role, GRANTs and default privileges are provisioned by `scripts/db-bootstrap.ts` (runs before `migrate deploy` at boot) — never put them in migrations. Two exceptions, both for the same reason (the `migrate dev` SHADOW database is a fresh database bootstrap never touches) and both narrow: the baseline migration keeps an idempotent `CREATE EXTENSION IF NOT EXISTS vector` so the shadow database can create `vector(...)` columns; and `20260827000000_rls_split_tenant_and_fleet_policies` creates the **fleet role** it writes into `CREATE POLICY … TO`, which is a hard error on a role that does not exist. That one creates the role and nothing else — no grants, no default privileges. Don't remove either, don't add extensions in later migrations, and don't grow the list without the same kind of reason.
- **`migrate dev` leaves one fleet role behind per run**, because the name derives from the shadow database and dropping that database does not drop the role. Harmless but not free (managed servers cap roles). Clean them on a dev cluster with:
  ```sql
  DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'fazerai\\_fleet\\_prisma\\_migrate\\_shadow%' LOOP
      EXECUTE format('DROP ROLE %I', r.rolname);
    END LOOP;
  END $$;
  ```
- Never run a bare `prisma migrate reset`: it recreates the `public` schema and wipes the bootstrap-provisioned grants (Postgres `42501` on next boot). Use `bun db:reset`, or rerun `bun db:bootstrap` after any reset.
- **A DATA migration over a tenant-scoped table lifts FORCE around the statement** (`ALTER TABLE x NO FORCE ROW LEVEL SECURITY;` … `ALTER TABLE x FORCE ROW LEVEL SECURITY;`), for every forced table it WRITES **and every forced table it READS** — a `SELECT` that decides what to write is bound the same way and decides on zero rows (measured on the rename of HTTP tools, PR #485: the rename landed, the audit lines its scan of `agents` was to leave did not) — never entering the fleet role: `migrate dev` replays into a shadow database bootstrap never touches, where that role has no grants and no membership (measured — `permission denied to set role`). Whatever a file lifts it must restore; `tests/prisma/migration-rls-bypass.test.ts` asks both, per table, for reads and writes alike.
- RLS policies, partial/expression indexes and CHECK constraints are hand-written SQL in migrations (Prisma cannot model them). When adding a tenant-scoped table, the same migration gives it `ENABLE`/`FORCE ROW LEVEL SECURITY` plus the **policy PAIR** every tenant-scoped table has carried since `20260827000000_rls_split_tenant_and_fleet_policies`: `tenant_isolation`, which names no role, and `fleet_super_admin TO <fleet role>`, whose role name is resolved at runtime by `public.fazerai_fleet_role()` inside a `DO $$ … EXECUTE format(…)` block instead of being hardcoded. Copy it from `20260917180000_reply_claims_per_message`, **not** from the tail of the baseline migration: that tail still shows the retired single-policy shape with `current_setting('app.is_super_admin')`, and a table that lands with only half the pair fails `tests/lib/rls-policy-shape.test.ts`, which counts the policies per table (measured on #690, where the copied stale shape came back as a count two short).

## O arquivo da migration NÃO roda em transação

Medido na #520, nos dois modos: `migrate deploy` e o replay do shadow do `migrate dev` executam o
`.sql` **fora** de transação. As duas consequências andam juntas e a segunda é a que morde.

A boa: `CREATE INDEX CONCURRENTLY` funciona, e ele é o que você quer em tabela quente. O build comum
toma `SHARE`, que conflita com o `ROW EXCLUSIVE` de um INSERT — medido segurando cada lock e tentando
inserir com `lock_timeout`: `SHARE` responde `canceling statement due to lock timeout`,
`SHARE UPDATE EXCLUSIVE` (o do concorrente) insere na hora. E o build não é instantâneo: 821 ms em 6M
linhas / 299 MB, crescendo com a tabela. Na ordem de boot documentada em `docs/deploy.md` o
`migrate deploy` roda no contêiner NOVO com o velho ainda servindo, então esse lock para a escrita de
produção — e onde a linha de auditoria é escrita DENTRO da transação da mutação, ele para a mudança de
configuração, não só o registro dela.

A ruim: sem transação, um arquivo com vários statements **não é atômico**. E o `CONCURRENTLY`
interrompido é o pior formato disso, porque não deixa erro: fica um índice `indisvalid = false`, que o
Postgres recusa usar **em silêncio**. O plano volta ao que era, a migration fica marcada como
aplicada, e nada aparece. Ponha um `DROP INDEX IF EXISTS` antes de cada build, para o redeploy
reconstruir do zero em vez de achar o resíduo e mantê-lo, e asserte o catálogo:

```sql
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
  JOIN pg_class t ON t.oid = i.indrelid
 WHERE t.relname = '<tabela>' AND NOT i.indisvalid;   -- tem que vir vazio
```

**A asserção tem que dizer REINDEX, e não DROP** (issue #759). Quando ela dispara, o índice morto se conserta com `REINDEX INDEX CONCURRENTLY "<nome>"`, que revalida no lugar e preserva a definição; depois `prisma migrate resolve --rolled-back <a asserção>` e redeploy. Mandar dropar é o que parece óbvio e é a instrução errada: o arquivo que construiu o índice pode estar registrado como aplicado (é o desfecho de quem saiu do `P3009` com `resolve --applied`, que marca o arquivo como aplicado sem executá-lo), e aí o `migrate deploy` nunca mais o reexecuta. Quem dropa termina com a tabela **sem índice nenhum**, o deploy verde e nada perguntando: troca um índice que o Postgres recusa por um índice que não existe, com o mesmo silêncio. Medido num build genuinamente interrompido (um `CREATE INDEX CONCURRENTLY` sobre 250 mil linhas cujo backend foi terminado no meio da varredura): o `REINDEX INDEX CONCURRENTLY` leva de volta a `indisvalid = true` com o mesmo `pg_get_indexdef`.

**O REINDEX tem uma precondição: o índice precisa ser CONSTRUÍVEL.** Para índice não-único, que é o caso dos três builds concorrentes desta árvore, isso vale sempre. Índice ÚNICO cujos dados violam a unicidade é a exceção, e ali o REINDEX falha do mesmo jeito que o build falhou **e deixa um segundo índice inválido** (medido: `u_v_idx` mais `u_v_idx_ccnew`, os dois `indisvalid = false`, depois de um `REINDEX INDEX CONCURRENTLY` no índice deixado por uma falha de chave duplicada). Esse caso pede resolver os dados primeiro, ou dropar o índice de propósito. A mensagem da guarda tem que dizer isso, senão manda o operador num comando que piora o catálogo.

**E um build EM VOO lê exatamente como um cadáver.** O Postgres cria o índice inválido e valida depois, então um `CREATE INDEX CONCURRENTLY` rodando agora fica `indisvalid = false` pela duração inteira, e a asserção reprova o deploy em cima dele. Manter essa reprovação é o certo (adivinhar "alguém deve estar construindo" é como um cadáver de verdade passa), mas a mensagem tem que dizer como separar os dois, porque reindexar o build vivo de outra sessão é o movimento errado. O `indisready` **não** separa, e isso foi medido em vez de suposto: build morto durante a primeira varredura deixa `false/false`, o mesmo par que um build vivo mostra. O discriminador é o `pg_stat_activity` (um backend com `CREATE INDEX` ativo naquela tabela).

**E a asserção só pode relatar.** Consertar ali dentro precisaria do nome do índice morto, que não se conhece na hora de escrever o arquivo, logo de um `DO $$ … EXECUTE format('REINDEX INDEX CONCURRENTLY %I', …)`. O Postgres recusa: `REINDEX CONCURRENTLY cannot be executed from a function`. Guarda para o deploy e nomeia o índice; quem conserta é o operador.

**A asserção de uma tabela não cobre o build da próxima.** Ela roda uma vez, no deploy que a aplica, então cobre a janela entre o build que ela guarda e ela mesma. Todo build concorrente novo precisa da sua própria, e é a `tests/prisma/concurrent-index-guard.test.ts` que reprova quem esquecer (varredura: toda tabela com `CREATE INDEX CONCURRENTLY` tem asserção em migration POSTERIOR).

**O remédio é o arquivo abrir a própria transação**, e ele funciona: `BEGIN;` … `COMMIT;` dentro do `.sql` é honrado pelo `migrate deploy`. Medido na #555, num banco descartável, com uma migration que falha depois do primeiro statement: sem o `BEGIN` o primeiro statement **persiste** através da falha (`x=1`), com ele o estado volta (`x=0`), e nos dois casos a migration fica marcada como falha. Use sempre que o arquivo deixar um **invariante** meio-aplicado, e não só linhas meio-migradas: o caso que motivou isso é o `NO FORCE ROW LEVEL SECURITY` de uma data migration, onde a falha no meio deixa a tabela sem FORCE, ou seja, sem sujeitar o próprio dono à policy de tenant. A exceção é o `CONCURRENTLY` acima, que o Postgres recusa dentro de transação: arquivo com ele não pode ser embrulhado, e aí a defesa é o `DROP INDEX IF EXISTS` mais a asserção de catálogo.

**Como isso convive com o `CONCURRENTLY` acima, já que os dois foram medidos.** Um `DROP INDEX CONCURRENTLY` sozinho no arquivo aplica; com qualquer segundo statement junto, ele falha com `cannot run inside a transaction block` (é a regra que a `tests/prisma/tenant-index-redundancy.test.ts` guarda). Ou seja: o arquivo não é atômico E o `CONCURRENTLY` enxerga um bloco de transação. As duas coisas estão reproduzidas em banco descartável; a explicação que reconcilia as duas **não está**, e por isso nenhum comentário no repo deve afirmar uma. Na prática o que decide é o comportamento: embrulhe em `BEGIN`/`COMMIT` quando o arquivo deixa invariante meio-aplicado, e deixe o `CONCURRENTLY` sozinho no arquivo dele.

**E o teste que roda a migration não prova atomicidade se mandar o arquivo inteiro de uma vez.** Uma string multi-statement sai pelo protocolo simple-query, que o Postgres embrulha numa transação **implícita**: o arquivo fica atômico independentemente do que ele diz, e apagar o `BEGIN` não quebra teste nenhum. Medido na #555, foi exatamente o que aconteceu. Quem quiser asserir a atomicidade executa statement a statement, como o Prisma executa (`tests/prisma/mcp-oauth-consent-action-rename-migration.test.ts`).

Um índice parcial não é modelável pelo Prisma e vive só no `.sql`; o irmão não-parcial pode e deve ir
no `schema.prisma` como `@@index`, com o nome que a convenção do Prisma geraria (`<tabela>_<coluna>_idx`),
senão o próximo `migrate dev` gera um `RENAME INDEX`.

## Querying

- **`notIn` drops NULL rows.** Prisma renders it as a bare `NOT IN (...)`, and `NULL NOT IN (...)` is `NULL` in SQL, so on a nullable column the filter silently shrinks the result. Measured seeding `[null, "vision", "agent"]`: `notIn: ["vision"]` returns `["agent"]` only. Where NULL carries meaning (rows written before the column had a default), say so: `OR: [{ col: null }, { col: { notIn: [...] } }]`. There is no error and every historical count just gets smaller.
- **A `catch` cannot recover inside a scoped transaction.** `runScoped`/`runScopedOn` open a `$transaction` to `SET LOCAL app.tenant_id` for RLS (`src/lib/tenancy/multi-tenant.ts`), so a statement that fails puts the Postgres transaction in the aborted state and every later statement dies with `current transaction is aborted`: the try-create / catch-P2002 / update-instead pattern is dead code in there. Use `db.<model>.upsert` keyed on the full composite unique (Prisma emits a native `INSERT … ON CONFLICT DO UPDATE` when the where is a complete unique and create/update hold only scalars). Prisma has no manual savepoint; if upsert does not fit, restructure outside the transaction.

## Renaming a name the MODEL sees

A rename is not done when the keys move. Operator-authored prose names tools too, and it lives in
eleven sites of one walker (`src/modules/agents/text-caps.ts`, which says of itself that it is the
one place that knows where that text lives). Six of those sites carry text where a tool name MEANS
the agent's toolset, and those are the ones a rename has to rewrite. The axis is not "the reader has
tools": the first four below are read by the tool-calling model itself, and the two guardrail ones by
a model with no tools at all, but they are rules ABOUT what the agent may call.

```
toolGuidance.<tool>                 appended to that tool's description
handoff.instructions                appended to handoff_to_human's description
kanban.instructions                 appended to kanban_move_card's description
followUp.steps[i].instructions      "Operator guidance for this follow-up", in the nudge prompt
guardrails.customPolicy             "Additional policy", in every analysis prompt
guardrails.output.generationPrompt  steers the model that rewrites a refused reply
```

And prose does not all live in the settings bag. Two more surfaces are COLUMNS on the tool
definition tables, which the walker knows nothing about:

```
tool_definitions.description                    the model receives it as that tool's description
code_tool_definitions.description               idem
tool_definitions.input_schema.<field>.description       the model receives it as the argument's hint
code_tool_definitions.input_schema.<field>.description  idem
```

Plus `agents.system_prompt`, the one surface the first rename of `assign_label` → `set_labels` did
rewrite. It moved the `toolGuidance` KEY and left the value's text alone, and the result was measured
on a real installation: `readToolGuidance` went on appending, to the description of `set_labels`, a
rule about calling `assign_label`, a name the model is never shown and cannot call. Nothing was
lost and no capability broke, which is exactly why nobody noticed (issue #604).

The five sites NOT to rewrite are read by a person (`availability.awayMessage`,
`contactAuth.denyMessage`, the two `guardrails.*.templateMessage`, `signature.text`): `set_labels`
means no more to a customer than the old name did, so rewriting them edits a message a customer
reads and fixes nothing. `vision.extractionPrompt` is out for a different reason: it instructs the vision
model to read an image and is not a rule about the agent either, so a tool name in it refers to
nothing. What separates it from the two guardrail prompts is not that its reader lacks tools, since
neither reader has any.

The list is not maintained by memory: `tests/modules/operator-text-surface.test.ts` classifies every
site the walker has AND every `String` column of the two tool definition models, and fails on one it
does not know, so a field added later forces the decision instead of silently sitting outside every
future rename. The classification itself is `tests/utils/operator-text-classes.ts`.

Two things bite while writing one of these:

- **The prefilter over a serialized jsonb bag must be a SUBSTRING, never `\y`.** A newline inside the
  operator's text serializes as `\` + `n`, which puts a word character right before the name: the
  boundary fails and the whole row is skipped, stale and with no audit line. Keep `\y` for the
  DECODED value, where prose actually lives, and use `strpos` (not LIKE: `_` is a LIKE wildcard).
- **A bare literal on the right of `text[] ||` is parsed as an ARRAY literal** and the statement dies
  with `malformed array literal`. Append typed expressions only (`'x'::text`, `format(...)`, a
  concatenation). A DO block only fails when a row reaches it, so an empty table hides this until
  production. The working form of the rewrite, word
boundary and audit line included, is
`prisma/migrations/20260917120000_rename_tool_names_in_operator_settings_text`.

**Only a GLOBAL one-to-one rename can be rewritten this way.** The two migrations that move an HTTP
tool off a native's name (`20260903120000`, `20260903150000`) deliberately rewrite no prose: the new
name is derived per tenant (`<name>_N`), so there is no single replacement, and they leave the audit
trail as the list instead.

## Dropping a column

The condition for a safe `DROP COLUMN` is **not** "no code reads the field", it is "no query NAMES the column". A Prisma query without an explicit `select` asks for every scalar of the model, and a relation pulled as `toolDefinition: true` does the same, so a call site that never touches the field still puts the column in the SQL and the previous image answers `undefined_column` after the drop. Auditing the explicit `SELECT` lists answers backwards: the screen you expect to break is the one that survives, because it is the only one naming its columns. Measured on #149/#176 with the v1.9.0 client against a database already missing the column: the two `findMany`/`update` without `select` failed, the one with an explicit `select` passed.

The mechanism is `@ignore` on the schema field. It removes the field from the generated client, so no query shape can name the column and a read becomes a `TS2339`, and it has **no DDL effect** — a `migrate diff` across the attribute is an empty migration, and across the field's removal it is the `ALTER TABLE … DROP COLUMN` the next release carries. Two designs lose to it, both tried: per-call-site `select` (enumerating the shapes is a race you lose — `toolDefinition: true` matches no call-site pattern), and a global client `omit` (works in SQL but re-types `PrismaClient`, which 89 files here use raw, and any call site undoes it).

So: one release adds `@ignore`, the next removes the field and drops the column, and the release note belongs to the second, saying rollback past it is no longer supported. Test the **shapes** (implicit read, write whose result nobody reads, whole relation pulled, insert) with a raw `SELECT` control, not the call sites. Gotcha: a statement the database REJECTS emits no query event, so the insert has to succeed, and under RLS that wants the migration role.

## Postgres catalog columns have a version

A catalog column can be newer than the servers you must boot on: `pg_auth_members.inherit_option` is PG16+, and using it in `db-bootstrap.ts` (which runs at every boot) would break every 15-or-older server with `column am.inherit_option does not exist` — no local assertion would catch it, because the servers here run 17 and the failure is an old server refusing to parse. Prefer the portable function to gating by version (`pg_has_role(r, d, 'USAGE')` answered the same thing and exists in every version). Since the red is impossible locally, the fence is a test that reads the script's source and asserts every 16-only construct sits behind the version gate — validated against its own error by reintroducing the column.
