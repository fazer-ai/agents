import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildHttpTools } from "@/graph/tools/assemble";
import { buildHttpTool } from "@/graph/tools/http";
import { buildRagTools } from "@/graph/tools/rag";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { importAgent } from "@/modules/agents/transfer";
import { resolveVariantOverride } from "@/modules/experiments/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  agentCreate,
  agentImport,
  toolCreate,
  toolUpdate,
} from "@/modules/mcp/write-agents";
import {
  knowledgeCreate,
  knowledgeUpdate,
} from "@/modules/mcp/write-knowledge";
import {
  experimentCreate,
  experimentUpdate,
} from "@/modules/mcp/write-settings";

// Three write families accepted input their own domain cannot use, and each rule already existed
// somewhere else: on the REST transport (a knowledge base's name is `minLength: 1` there, an
// experiment's is 1-200) or in the runtime that reads the row back (a `urlTemplate` the tool call
// feeds to `new URL`, an `agentId` the variant resolver looks up). The core never asked, so the MCP
// road walked past all of them and the row landed. Issue #501.
//
// What each test pins is the EFFECT first and the refusal second, because a bound with no effect
// behind it is a number someone will relax later. The effects are measured on the base commit:
//
//   - a base whose name is blank is dropped from `search_knowledge`'s scope list (buildRagTools
//     filters on `name.trim()`), which also collapses the `knowledge_base` parameter for every
//     OTHER base the agent has;
//   - a 5000-character name goes whole into that tool's description on every turn, and evicts the
//     other bases from the 1000-character budget the file keeps precisely so "a verbose KB never
//     bloats the prompt";
//   - a `url_template` that is not a URL builds a tool, grants it, offers it to the model and
//     THROWS on the first call (`tool X: invalid urlTemplate`, 400) — not a ToolFailure the model
//     can read, a raw AppError;
//   - an experiment on an id that names no agent overrides nothing, forever.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
afterAll(async () => {
  await su?.$disconnect();
  await app?.$disconnect();
});
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

// ── the effects, which need no database ──

describe("what the agent does with a name its domain cannot use", () => {
  const kb = (id: bigint, name: string) => ({ id, name, description: null });
  const searchTool = (
    kbs: { id: bigint; name: string; description: string | null }[],
  ) =>
    buildRagTools(
      {
        tenantId: 1n,
        base: appDb,
        knowledgeBaseIds: kbs.map((k) => k.id),
        knowledgeBases: kbs,
        threadId: "t",
      },
      ["search_knowledge"],
    )[0] as unknown as {
      description: string;
      schema: { shape: Record<string, unknown> };
    };

  test("a blank name takes the scope parameter away from the OTHER base too", () => {
    const both = searchTool([kb(1n, "Manual"), kb(2n, "Trocas")]);
    expect(Object.keys(both.schema.shape)).toContain("knowledge_base");

    const blank = searchTool([kb(1n, "   "), kb(2n, "Trocas")]);
    // The blank one is filtered out, which leaves ONE named base — and with one there is nothing to
    // narrow, so the parameter disappears. "Trocas" was searchable by name a moment ago.
    expect(Object.keys(blank.schema.shape)).not.toContain("knowledge_base");
    // And the model still reads it in the list, as an element with no name.
    expect(blank.description).toContain("<knowledge_base/>");
  });

  test("one 5000-character name evicts every other base from the list", () => {
    const huge = searchTool([
      kb(1n, "A".repeat(5000)),
      kb(2n, "Trocas"),
      kb(3n, "Manual"),
    ]);
    expect(huge.description).toContain('<more count="2"/>');
    expect(huge.description).not.toContain("Trocas");
    expect(huge.description.length).toBeGreaterThan(5000);
  });
});

describe("what the model gets when a url_template is not a URL", () => {
  // A public IP LITERAL, not a hostname: the control below reaches `assertSafeOutboundUrl`, which
  // resolves the host before the fake `fetchImpl` is ever called — so a runner without external DNS
  // would fail this on the lookup and read as a defect in the code under test. The repo's existing
  // pattern (mcp-write-channels, the dry-run fence) is this same address, and the allowlist matches
  // it because the SSRF check compares the hostname it actually gets (review round 4).
  const HOST = "93.184.216.34";
  const def = (urlTemplate: string) => ({
    name: "consulta_pedido",
    method: "GET",
    urlTemplate,
    allowedHosts: [HOST],
    headers: {},
    inputSchema: {},
  });
  const deps = {
    resolveCredential: async () => null,
    fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
  };

  test("the tool builds, is offered, and throws on the first call", async () => {
    const t = buildHttpTool(def("not-a-url"), deps) as unknown as {
      invoke: (i: unknown) => Promise<unknown>;
    };
    expect(t.invoke).toBeFunction();
    await expect(t.invoke({})).rejects.toThrow("invalid urlTemplate");
    // The control: the same tool with a URL answers.
    const ok = buildHttpTool(def(`https://${HOST}/p`), deps) as unknown as {
      invoke: (i: unknown) => Promise<unknown>;
    };
    expect(String(await ok.invoke({}))).toContain("HTTP 200");
  });

  // The other shape the write was not asking about: a template that starts with `/` is RELATIVE and
  // takes its host from the credential's base URL. With no base there is nothing to prepend, and
  // this one does not even build — it throws where the toolset is assembled, before any call.
  test("a relative template with no base does not even build", async () => {
    expect(() => buildHttpTool(def("/v1/items"), deps)).toThrow(
      /relative urlTemplate requires a credential with a base URL/,
    );
    // The control: the same template with a base builds and answers.
    const ok = buildHttpTool(
      { ...def("/p"), credentialBaseUrl: `https://${HOST}` },
      deps,
    ) as unknown as { invoke: (i: unknown) => Promise<unknown> };
    expect(String(await ok.invoke({}))).toContain("HTTP 200");
  });
});

// ── the refusals, on both halves of every tool ──

describe.skipIf(!dbUp)(
  "a write refuses input its domain has no use for",
  () => {
    let tenantId = 0n;
    let agentId = "";
    const principal = (): VerifiedToken =>
      ({
        userId: 1n,
        tenantId,
        role: "TENANT_ADMIN",
        scopes: ["mcp:read", "mcp:write"],
        clientId: "c",
        jti: "j",
      }) as VerifiedToken;
    const D = { base: appDb };

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "NoUse", slug: `nouse-${process.pid}` },
      });
      tenantId = t.id;
      const a = await agentCreate(
        principal(),
        { name: "A", dry_run: false },
        D,
      );
      agentId = idOf(a, "agent", "id");
    });

    afterAll(async () => {
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    });

    // The seeded row's id, and a loud failure when the seed itself was refused: a `.data.id` read off
    // a refusal is `undefined`, and every assertion after it would then be about the string "undefined".
    function idOf(r: { ok: boolean }, ...path: string[]): string {
      if (!r.ok) {
        throw new Error(
          `seed refused: ${(r as unknown as { error: string }).error}`,
        );
      }
      let v: unknown = (r as unknown as { data: unknown }).data;
      for (const k of path) v = (v as Record<string, unknown>)[k];
      // NOTE: a path that names nothing used to return the string "undefined", and a `tool_id` of
      // "undefined" is refused by BOTH halves — so every assertion that both halves refuse passed
      // without the rule under test ever being reached. Two rows in this file were vacuous that way
      // (review round 13, found by a mutation that would not die).
      if (v === undefined || v === null) {
        throw new Error(`no ${path.join(".")} in ${JSON.stringify(v)}`);
      }
      return String(v);
    }

    // Both halves of one tool, on one input. The apply is asked FIRST so a preview that wrote (the
    // #510 regression) would leave the row this counts.
    async function halves(
      fn: (
        p: VerifiedToken,
        a: Record<string, unknown>,
        d: { base: PrismaClient },
      ) => Promise<{ ok: boolean; error?: string }>,
      args: Record<string, unknown>,
    ): Promise<{ applied: boolean; previewed: boolean; error?: string }> {
      const applied = await fn(principal(), { ...args, dry_run: false }, D);
      const previewed = await fn(principal(), { ...args }, D);
      return {
        applied: applied.ok,
        previewed: previewed.ok,
        error: applied.error ?? previewed.error,
      };
    }

    // Waits until SOME backend is blocked BY `pid`, which is the fact every race assertion below is
    // about. Polls Postgres rather than the clock: on a fast machine it returns in one round trip,
    // and on a slow one it keeps asking instead of concluding.
    async function someoneBlockedBy(pid: number, ms = 5000): Promise<boolean> {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const rows = await suDb.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
        if (rows.length > 0) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    }

    describe("a knowledge base's name", () => {
      test("blank, whitespace-only and over the ceiling are all refused", async () => {
        for (const name of ["", "   ", "x".repeat(201)]) {
          const r = await halves(knowledgeCreate as never, { name });
          expect({ name: name.slice(0, 12), ...r }).toEqual({
            name: name.slice(0, 12),
            applied: false,
            previewed: false,
            error: expect.stringContaining("name"),
          });
        }
        expect(await suDb.knowledgeBase.count({ where: { tenantId } })).toBe(0);
      });

      test("the update is held to the same rule, and only when it sets the name", async () => {
        const created = await knowledgeCreate(
          principal(),
          { name: "Manual", dry_run: false },
          D,
        );
        const id = idOf(created, "id");

        const blanked = await halves(knowledgeUpdate as never, {
          knowledge_base_id: id,
          name: "  ",
        });
        expect(blanked).toMatchObject({ applied: false, previewed: false });

        // A patch that never names the name is untouched by the rule.
        const other = await knowledgeUpdate(
          principal(),
          { knowledge_base_id: id, description: "d", dry_run: false },
          D,
        );
        expect(other.ok).toBe(true);
        expect(
          (
            await suDb.knowledgeBase.findUniqueOrThrow({
              where: { id: BigInt(id) },
              select: { name: true },
            })
          ).name,
        ).toBe("Manual");
      });

      test("a name at the ceiling still applies", async () => {
        const r = await knowledgeCreate(
          principal(),
          { name: "y".repeat(200), dry_run: false },
          D,
        );
        expect(r.ok).toBe(true);
      });
    });

    describe("a tool's url_template", () => {
      const tool = (over: Record<string, unknown>) => ({
        name: `t_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`,
        label: "T",
        allowed_hosts: ["example.com"],
        ...over,
      });

      // A credential that DOES supply a host, and one that does not because its kind ignores the
      // column. The second is written straight through Prisma: #521 refuses to store a base URL on
      // a kind that has no use for it, so the only way that row exists is from before that rule —
      // and rows from before a rule are exactly what a read-backed check has to answer about.
      let dialable = "";
      let ignored = "";
      beforeAll(async () => {
        const withBase = await suDb.vaultEntry.create({
          data: {
            tenantId,
            name: `base_${process.pid}`,
            kind: "generic",
            baseUrl: "https://api.example.com",
            secret: "placeholder",
            status: "pending",
          },
          select: { id: true },
        });
        dialable = `vault:${withBase.id}`;
        const baseIgnored = await suDb.vaultEntry.create({
          data: {
            tenantId,
            name: `ignored_${process.pid}`,
            kind: "openai",
            baseUrl: "https://api.example.com",
            secret: "placeholder",
            status: "pending",
          },
          select: { id: true },
        });
        ignored = `vault:${baseIgnored.id}`;
      });

      // The fourth site of the same sentence, and the one that had a control blessing it (review
      // round 13). A template that starts with `/` is RELATIVE: `buildHttpTool` prepends the
      // credential's base URL and, with none to prepend, refuses to build the tool at all — so the
      // row stores, gets granted, is offered to the model, and throws on the first call. The
      // console's form has blocked that pair on save all along; the core had not been asked.
      test("a relative template with no host to take is refused by both halves", async () => {
        // No credential at all.
        expect(
          await halves(
            toolCreate as never,
            tool({ url_template: "/v1/items" }),
          ),
        ).toMatchObject({ applied: false, previewed: false });
        // A credential whose KIND makes the runtime ignore the column, which is why the check reads
        // `dialableBaseUrl` and not the raw base URL: it is the reader the runtime itself uses.
        expect(
          await halves(
            toolCreate as never,
            tool({ url_template: "/v1/items", credential_ref: ignored }),
          ),
        ).toMatchObject({ applied: false, previewed: false });
      });

      test("a relative template applies when a credential supplies the host", async () => {
        const r = await toolCreate(
          principal(),
          {
            ...tool({ url_template: "/v1/items", credential_ref: dialable }),
            dry_run: false,
          },
          D,
        );
        expect(r.ok).toBe(true);
        const id = idOf(r, "tool", "id");

        // The pair is judged on the PATCH too, and on the effective row: clearing the credential
        // leaves a relative template with no host, and moving the template to a relative one on a
        // tool that has no credential is the same row reached from the other side.
        expect(
          await halves(toolUpdate as never, {
            tool_id: id,
            credential_ref: null,
          }),
        ).toMatchObject({ applied: false, previewed: false });

        // And a patch that names NEITHER is not a statement about the pairing: a row stored before
        // this rule stays editable through everything else (the #524 shape).
        const legacy = await suDb.toolDefinition.create({
          data: {
            tenantId,
            name: `legacy_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`,
            label: "Legacy",
            method: "GET",
            urlTemplate: "/v1/items",
            allowedHosts: ["api.example.com"],
          },
          select: { id: true },
        });
        expect(
          await halves(toolUpdate as never, {
            tool_id: String(legacy.id),
            label: "Renomeada",
          }),
        ).toMatchObject({ applied: true, previewed: true });
        // The other half of the same sentence: touching either side of the pair IS asking.
        expect(
          await halves(toolUpdate as never, {
            tool_id: String(legacy.id),
            url_template: "/v2/items",
          }),
        ).toMatchObject({ applied: false, previewed: false });
        // And wiring a credential that supplies the host repairs it.
        expect(
          await halves(toolUpdate as never, {
            tool_id: String(legacy.id),
            credential_ref: dialable,
          }),
        ).toMatchObject({ applied: true, previewed: true });

        // The mirror, and the row that makes "effective" mean something on the template side: a
        // tool whose STORED template is absolute, moved to a relative one. Judging the stored value
        // would find an absolute template, return early, and store a tool that cannot build.
        const absolute = await toolCreate(
          principal(),
          {
            ...tool({ url_template: "https://example.com/v1/items" }),
            dry_run: false,
          },
          D,
        );
        expect(absolute.ok).toBe(true);
        expect(
          await halves(toolUpdate as never, {
            tool_id: idOf(absolute, "tool", "id"),
            url_template: "/v1/items",
          }),
        ).toMatchObject({ applied: false, previewed: false });
      });

      test("a template the runtime cannot build a URL from is refused by both halves", async () => {
        for (const url_template of [
          "not-a-url",
          "{{base}}/v1/items",
          "ftp://x/y",
          // Parses, and still cannot run: the runtime probes the origin with a neutral filler and
          // refuses a real interpolation that moves it, so a host placeholder fails every call.
          "https://{{host}}/v1/items",
          "https://api.{{tenant}}.example.com/v1",
          // The SINGLE-BRACE spelling of the same thing, which this check used to let through
          // (round 6): `new URL` accepts the braces, and `normalizeToolShapes` rewrites the token to
          // `{{contact_id}}` on the way to storage, so the runtime refuses it on every call.
          // Measured on the base: `interpolation altered the origin`.
          "https://api.{contact_id}.example.com/x",
        ])
          expect({
            url_template,
            ...(await halves(toolCreate as never, tool({ url_template }))),
          }).toEqual({
            url_template,
            applied: false,
            previewed: false,
            error: expect.stringContaining("url"),
          });
      });

      test("the shapes the runtime DOES build still apply", async () => {
        for (const url_template of [
          "https://example.com/v1/items",
          "https://example.com/v1/items/{{order_id}}",
          // Single brace in the PATH stays legal, which is what keeps the rule above from being a
          // ban on the spelling: it does not move the origin, whichever way it normalizes.
          "https://example.com/v1/items/{order_id}",
        ]) {
          const r = await toolCreate(
            principal(),
            { ...tool({ url_template }), dry_run: false },
            D,
          );
          expect({ url_template, ok: r.ok }).toEqual({
            url_template,
            ok: true,
          });
        }
      });

      test("the update asks it too, on both halves", async () => {
        const created = await toolCreate(
          principal(),
          {
            ...tool({ url_template: "https://example.com/ok" }),
            dry_run: false,
          },
          D,
        );
        const id = idOf(created, "tool", "id");
        const r = await halves(toolUpdate as never, {
          tool_id: id,
          url_template: "also-not-a-url",
        });
        expect(r).toMatchObject({ applied: false, previewed: false });
        expect(
          (
            await suDb.toolDefinition.findUniqueOrThrow({
              where: { id: BigInt(id) },
              select: { urlTemplate: true },
            })
          ).urlTemplate,
        ).toBe("https://example.com/ok");
      });
    });

    // The FOURTH road, and the one this round declared out of scope until it was exercised. The agent
    // import writes tool definitions straight through Prisma, so none of the asserts above are on its
    // path — and measured, a hand-edited bundle carrying `urlTemplate: "not-a-url"` imported CLEAN,
    // with an empty warnings array and the row stored. `agent_import` is one of the MCP write tools
    // this issue is about, so that was a site of the same defect, not another door.
    //
    // Warn-and-skip, in the module's own vocabulary and asking the SAME function the write asks: the
    // tool this build cannot call is left out and named, the rest of the agent imports.
    describe("the import road", () => {
      const bundle = (urlTemplate: string) => ({
        version: 1,
        kind: "fazer-ai.agent",
        agent: {
          name: "Imported",
          systemPrompt: "p",
          modelConfig: {} as Record<string, unknown>,
          settings: {},
          transferWithSummary: false,
          businessHours: null,
          followUpHours: null,
          tools: [],
          credentials: [] as Array<{ name: string; kind: string }>,
        },
        components: {
          mcpServers: [],
          integrations: [],
          knowledgeBases: [] as Array<{ name: string }>,
          httpTools: [
            {
              name: `imported_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`,
              label: "Imported",
              description: null,
              method: "GET",
              urlTemplate,
              allowedHosts: ["example.com"],
              headers: {},
              inputSchema: {},
              outputSchema: {},
              body: {},
              riskTier: "medium",
              ackEnabled: false,
            },
          ],
        },
      });

      test("a bundle whose tool cannot be called leaves that tool out, and says so", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const before = await suDb.toolDefinition.count({ where: { tenantId } });
        const r = await importAgent(ctx, bundle("not-a-url"), appDb);
        expect(r.warnings.map((w) => w.code)).toContain(
          "httpToolUrlTemplateUnusable",
        );
        expect(await suDb.toolDefinition.count({ where: { tenantId } })).toBe(
          before,
        );
        // The rest of the agent imported: skipping one tool is not refusing the bundle.
        expect(r.agent.name).toBe("Imported");

        // The control that makes the row above mean something: the same bundle with a URL imports the
        // tool, with no warning.
        const ok = await importAgent(
          ctx,
          bundle("https://example.com/v1/items"),
          appDb,
        );
        expect(ok.warnings.map((w) => w.code)).not.toContain(
          "httpToolUrlTemplateUnusable",
        );
        expect(await suDb.toolDefinition.count({ where: { tenantId } })).toBe(
          before + 1,
        );
        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // The other half, and the one the apply-side fix itself created (review round 5): a rule added
      // to the apply alone leaves the preview approving the creation of a component that will not be
      // created. The count it shows and the warnings it names now come from the reader the apply
      // skips with.
      test("the preview subtracts the tool the apply will skip, and names it", async () => {
        const bad = await agentImport(
          principal(),
          { export: bundle("not-a-url") },
          D,
        );
        const badData = (bad as { data: Record<string, unknown> }).data;
        expect(badData.dryRun).toBe(true);
        expect(
          (badData.warnings as Array<{ code: string }>).map((w) => w.code),
        ).toEqual(["httpToolUrlTemplateUnusable"]);

        // The control: the same bundle with a URL counts the tool and warns about nothing.
        const ok = await agentImport(
          principal(),
          { export: bundle("https://example.com/v1/items") },
          D,
        );
        const okData = (ok as { data: Record<string, unknown> }).data;
        expect((okData.components as { httpTools: number }).httpTools).toBe(1);
        expect(okData.warnings).toBeUndefined();
        // And the rehearsal left NOTHING: the transaction it ran in was rolled back.
        expect(await suDb.toolDefinition.count({ where: { tenantId } })).toBe(
          0,
        );
        expect(
          await suDb.agent.count({ where: { tenantId, name: "Imported" } }),
        ).toBe(0);
      });

      // THE INVERSE, which the round-5 fix walked straight into (round 7): the apply asks whether a
      // row under that name already exists BEFORE it asks whether this build can store the bundle's
      // version, and reuses the row. A preview that only asked the second question announced a tool
      // as skipped that the apply reuses and grants — the same divergence pointing the other way.
      test("a bundled tool the tenant already has is reused, not reported as skipped", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const b = bundle("not-a-url");
        const name = b.components.httpTools[0]?.name as string;
        // The row that exists here is a WORKING tool: what the bundle carries says nothing about it.
        await suDb.toolDefinition.create({
          data: {
            tenantId,
            name,
            label: "Already here",
            method: "GET",
            urlTemplate: "https://example.com/v1/ok",
            allowedHosts: ["example.com"],
          },
        });

        const preview = await agentImport(principal(), { export: b }, D);
        const data = (preview as { data: Record<string, unknown> }).data;
        expect(
          (data.warnings as Array<{ code: string }>).map((w) => w.code),
        ).toContain("httpToolReused");
        expect(
          (data.warnings as Array<{ code: string }>).map((w) => w.code),
        ).not.toContain("httpToolUrlTemplateUnusable");

        // And the apply agrees: reused, not skipped, and the stored URL is untouched.
        const applied = await importAgent(ctx, b, appDb);
        expect(applied.warnings.map((w) => w.code)).toContain("httpToolReused");
        expect(applied.warnings.map((w) => w.code)).not.toContain(
          "httpToolUrlTemplateUnusable",
        );
        expect(
          (
            await suDb.toolDefinition.findFirstOrThrow({
              where: { tenantId, name },
              select: { urlTemplate: true },
            })
          ).urlTemplate,
        ).toBe("https://example.com/v1/ok");

        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // A bundle carrying the same tool name TWICE, which the rename logic in that module exists
      // for: the apply creates the first and finds the row it just wrote for the second. Two
      // independent passes over the state before the import read both entries as creations, so the
      // preview reported as skipped a tool the apply reuses (round 8).
      test("a name created earlier in the same bundle is reused by what follows it", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const b = bundle("https://example.com/v1/ok");
        const first = b.components.httpTools[0] as { name: string };
        // The SECOND entry is the malformed one, under the name the first will create.
        b.components.httpTools.push({
          ...first,
          urlTemplate: "not-a-url",
        } as (typeof b.components.httpTools)[number]);

        const preview = await agentImport(principal(), { export: b }, D);
        const data = (preview as { data: Record<string, unknown> }).data;
        expect(
          (data.warnings as Array<{ code: string }>).map((w) => w.code),
        ).toContain("httpToolReused");

        const applied = await importAgent(ctx, b, appDb);
        expect(applied.warnings.map((w) => w.code)).toContain("httpToolReused");
        expect(applied.warnings.map((w) => w.code)).not.toContain(
          "httpToolUrlTemplateUnusable",
        );
        expect(await suDb.toolDefinition.count({ where: { tenantId } })).toBe(
          1,
        );

        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // The reuse lookup is against the name the apply will STORE, not the one the bundle carries,
      // and those differ for exactly one bundle: a tool named after a native, which the import
      // stores as `<name>_2` (#457, #485). A mutation that looked the bundle's own name up survived
      // every row above, because in all of them the two names are the same string.
      test("the name the preview looks up is the one the apply will store", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const b = bundle("not-a-url");
        // Named after a native tool, so the import cannot store it under its own name.
        (b.components.httpTools[0] as { name: string }).name = "calculator";
        // The row that exists is the RENAMED one, which is what the apply will find.
        await suDb.toolDefinition.create({
          data: {
            tenantId,
            name: "calculator_2",
            label: "Already here",
            method: "GET",
            urlTemplate: "https://example.com/v1/ok",
            allowedHosts: ["example.com"],
          },
        });

        const preview = await agentImport(principal(), { export: b }, D);
        const data = (preview as { data: Record<string, unknown> }).data;
        expect(
          (data.warnings as Array<{ code: string }>).map((w) => w.code),
        ).toContain("httpToolReused");

        const applied = await importAgent(ctx, b, appDb);
        expect(applied.warnings.map((w) => w.code)).toContain("httpToolReused");
        expect(applied.warnings.map((w) => w.code)).not.toContain(
          "httpToolUrlTemplateUnusable",
        );

        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // A preview that writes is not a preview, and running the apply is what made this reachable
      // (review round 9). For a credential the bundle names and the tenant lacks, the import creates
      // a reference-only entry so the ref stays wired — and it created it on the outer client, which
      // opens its own transaction and commits past the rehearsal's rollback. Measured before the fix:
      // the agent unwound and the vault kept the row, plus a `credential.create` audit row for a write
      // that never happened, after which the second preview read the credential as FOUND and stopped
      // warning about it. A dry run that changes its own answer is the divergence this file is about,
      // arriving through the mechanism meant to close it.
      test("the preview leaves no credential behind, and answers the same twice", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const b = bundle("https://example.com/v1/ok");
        b.agent.modelConfig = { credentialRef: "cred_501" };
        b.agent.credentials = [{ name: "cred_501", kind: "generic" }];

        const codes = (r: Awaited<ReturnType<typeof agentImport>>) =>
          (
            ((r as { data: Record<string, unknown> }).data.warnings ??
              []) as Array<{ code: string }>
          ).map((w) => w.code);

        const first = await agentImport(principal(), { export: b }, D);
        expect(codes(first)).toContain("credentialPending");
        expect(
          await suDb.vaultEntry.count({
            where: { tenantId, name: { startsWith: "cred_" } },
          }),
        ).toBe(0);
        expect(
          await suDb.auditLog.count({
            where: { tenantId, action: "credential.create" },
          }),
        ).toBe(0);

        // The same bundle, previewed again against the same tenant: same answer, which is only true
        // because the first preview wrote nothing for the second one to find.
        const second = await agentImport(principal(), { export: b }, D);
        expect(codes(second)).toContain("credentialPending");

        // The control that makes the two rows above mean something: the APPLY does create it.
        await importAgent(ctx, b, appDb);
        expect(
          await suDb.vaultEntry.count({
            where: { tenantId, name: { startsWith: "cred_" } },
          }),
        ).toBe(1);
        expect(
          await suDb.auditLog.count({
            where: { tenantId, action: "credential.create" },
          }),
        ).toBe(1);

        await suDb.auditLog.deleteMany({ where: { tenantId } });
        await suDb.vaultEntry.deleteMany({
          where: { tenantId, name: { startsWith: "cred_" } },
        });
        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // The lookup and the write have to ask about the SAME string, and they did not: the vault trims
      // a name before storing it, and the import resolved the bundle's spelling verbatim. A bundle
      // carrying ` cred ` therefore resolved as missing on EVERY import — the first stored `cred`,
      // and the second failed to find ` cred `, reached the insert, and collided with the row it had
      // just written. Before round 9 that collision was swallowed into a `credentialNotFound` warning
      // that silently unwired the ref; after it, with the write inside the import's transaction, it
      // would take the whole import down. Neither is right: the name the lookup asks about is now the
      // name the write stores (review round 10).
      test("a credential name the vault would trim resolves to the row it stored", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const b = bundle("https://example.com/v1/ok");
        b.agent.modelConfig = { credentialRef: "  cred_ws_501  " };
        b.agent.credentials = [{ name: "  cred_ws_501  ", kind: "generic" }];

        const first = await importAgent(ctx, b, appDb);
        expect(first.warnings.map((w) => w.code)).toContain(
          "credentialPending",
        );
        const stored = await suDb.vaultEntry.findMany({
          where: { tenantId, name: { startsWith: "cred_" } },
          select: { id: true, name: true },
        });
        expect(stored.map((e) => e.name)).toEqual(["cred_ws_501"]);

        // The second import finds it instead of colliding with it: one entry, reused, and no warning
        // claiming the credential is missing.
        const second = await importAgent(ctx, b, appDb);
        expect(second.warnings.map((w) => w.code)).not.toContain(
          "credentialNotFound",
        );
        expect(second.warnings.map((w) => w.code)).not.toContain(
          "credentialPending",
        );
        expect(
          await suDb.vaultEntry.count({
            where: { tenantId, name: { startsWith: "cred_" } },
          }),
        ).toBe(1);
        // And the ref landed wired to that row, which is the point of creating it at all.
        const agents = await suDb.agent.findMany({
          where: { tenantId, name: "Imported" },
          select: { modelConfig: true },
        });
        for (const a of agents) {
          expect(
            (a.modelConfig as { credentialRef?: string })?.credentialRef,
          ).toBe(`vault:${stored[0]?.id}`);
        }

        await suDb.auditLog.deleteMany({ where: { tenantId } });
        await suDb.vaultEntry.deleteMany({
          where: { tenantId, name: { startsWith: "cred_" } },
        });
        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // And the read has to be in the same transaction as the write, for the same reason (review
      // round 11). A bundle can reference the SAME missing credential twice under trim-equivalent
      // spellings — the ref map is keyed by what the bundle wrote, so `cred` and ` cred ` are two
      // passes — and a lookup on a separate connection cannot see the row the first pass created
      // inside the import's transaction. The second pass therefore read it as missing and the insert
      // collided with it, taking the whole import down, dry run included.
      test("the same missing credential named twice is created once", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const b = bundle("https://example.com/v1/ok");
        // Two spellings of one name, on two different credential slots of the same agent.
        b.agent.modelConfig = { credentialRef: "cred_twice_501" };
        b.agent.settings = {
          stt: { credentialRef: "  cred_twice_501  " },
        } as Record<string, unknown>;
        b.agent.credentials = [
          { name: "cred_twice_501", kind: "generic" },
          { name: "  cred_twice_501  ", kind: "generic" },
        ];

        // The preview first: it runs the apply, so the collision took the dry run down too.
        const preview = await agentImport(principal(), { export: b }, D);
        expect(preview.ok).toBe(true);

        const applied = await importAgent(ctx, b, appDb);
        expect(applied.agent.name).toBe("Imported");
        const rows = await suDb.vaultEntry.findMany({
          where: { tenantId, name: { startsWith: "cred_" } },
          select: { name: true },
        });
        expect(rows.map((r) => r.name)).toEqual(["cred_twice_501"]);

        await suDb.auditLog.deleteMany({ where: { tenantId } });
        await suDb.vaultEntry.deleteMany({
          where: { tenantId, name: { startsWith: "cred_" } },
        });
        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // The lookup belongs to the import's transaction for a second reason, and this is the one that
      // is observable now that the insert tolerates a duplicate: asking it on the outer client opens
      // a SECOND transaction while the import already holds one, so the import needs two connections
      // to finish. On a pool that can give one it waits for a connection it will never get, and the
      // failure is a transaction-start timeout rather than anything naming the vault. Measured: 33ms
      // with the read inside, and `Unable to start a transaction in the given time` after 2s with it
      // outside.
      test("the import finishes on a pool that can give one connection", async () => {
        const tiny = new PrismaClient({
          adapter: new PrismaPg({ connectionString: appUrl as string, max: 1 }),
        });
        try {
          const ctx = {
            tenantId,
            userId: 1n,
            role: "TENANT_ADMIN",
          } as TenantContext;
          const b = bundle("https://example.com/v1/ok");
          b.agent.modelConfig = { credentialRef: "cred_pool_501" };
          b.agent.credentials = [{ name: "cred_pool_501", kind: "generic" }];
          const applied = await importAgent(ctx, b, tiny);
          expect(applied.warnings.map((w) => w.code)).toContain(
            "credentialPending",
          );
        } finally {
          await tiny.$disconnect();
        }

        await suDb.auditLog.deleteMany({ where: { tenantId } });
        await suDb.vaultEntry.deleteMany({
          where: { tenantId, name: { startsWith: "cred_" } },
        });
        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // The pairing from round 13, on the import road (review round 15). Left alone at first on the
      // reasoning that an import lands a configuration the operator completes — it creates PENDING
      // credentials on purpose. Measuring what the stored row costs overturned that: `buildHttpTools`
      // is a bare `.map` inside the toolset literal, so a tool it cannot build throws out of the
      // whole assembly and the agent loses EVERY tool, not just this one. There is nothing to
      // complete later on an agent whose next turn has no tools.
      test("a bundled tool with no host to take is left out, not stored", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        // The runtime's own answer first: one unbuildable definition takes the toolset with it.
        expect(() =>
          buildHttpTools(
            [
              {
                name: "boa",
                method: "GET",
                urlTemplate: "https://example.com/ok",
                allowedHosts: ["example.com"],
                headers: {},
                inputSchema: {},
              },
              {
                name: "ruim",
                method: "GET",
                urlTemplate: "/v1/items",
                allowedHosts: ["example.com"],
                headers: {},
                inputSchema: {},
              },
            ] as never,
            {
              resolveCredential: async () => null,
              fetchImpl: (async () =>
                new Response("{}")) as unknown as typeof fetch,
            } as never,
          ),
        ).toThrow(/relative urlTemplate requires a credential with a base URL/);

        const b = bundle("/v1/items");
        const before = await suDb.toolDefinition.count({ where: { tenantId } });
        const applied = await importAgent(ctx, b, appDb);
        expect(applied.warnings.map((w) => w.code)).toContain(
          "httpToolUrlTemplateUnusable",
        );
        expect(await suDb.toolDefinition.count({ where: { tenantId } })).toBe(
          before,
        );
        expect(applied.agent.name).toBe("Imported");

        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // The import writes knowledge bases straight through Prisma too, so the name rule at the top of
      // this file is not on that path either (review round 14). A blank name is the same base the
      // agent cannot scope a search to, and a 5000-character one eats the same tool-description
      // budget — the two effects this whole round opened with. Warn and skip, in the module's own
      // vocabulary, and the grants that named it then report `kbGrantNotFound`.
      test("a bundled knowledge base whose name is unusable is left out, and said", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const b = bundle("https://example.com/v1/ok");
        b.components.knowledgeBases = [
          { name: "   " },
          { name: "x".repeat(201) },
          { name: "boa_base_501" },
        ];

        const applied = await importAgent(ctx, b, appDb);
        expect(
          applied.warnings.filter(
            (w) => w.code === "knowledgeBaseNameUnusable",
          ),
        ).toHaveLength(2);
        // The control in the same bundle: the usable one landed, so this is a skip and not a refusal
        // of the whole components array.
        // NOTE: by NAME, not by tenant: earlier describes in this file leave their own bases in the
        // same tenant, and a count over all of them measures those instead of this bundle.
        const bases = await suDb.knowledgeBase.findMany({
          where: {
            tenantId,
            name: { in: ["   ", "x".repeat(201), "boa_base_501"] },
          },
          select: { name: true },
        });
        expect(bases.map((k) => k.name)).toEqual(["boa_base_501"]);
        expect(applied.agent.name).toBe("Imported");

        await suDb.knowledgeBase.deleteMany({
          where: {
            tenantId,
            name: { in: ["   ", "x".repeat(201), "boa_base_501"] },
          },
        });
        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // And the report has to survive the clip (review round 16). The warning names a clipped name,
      // because it fires precisely when the name may be enormous — and `dedupeWarnings` keyed on the
      // code and the RENDERED params, so two bases whose names share their first 60 characters
      // collapsed into one warning while both were skipped. The target is part of a warning's
      // identity now, and it carries the whole name.
      test("two bases that clip to the same text are still reported twice", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const b = bundle("https://example.com/v1/ok");
        // A prefix of this test's own, long enough to survive the 60-character clip and unique in the
        // tenant, so the count below measures these two bases and not another describe's control.
        const prefix = "kbclip501".padEnd(60, "z");
        b.components.knowledgeBases = [
          { name: `${prefix}${"a".repeat(200)}` },
          { name: `${prefix}${"b".repeat(200)}` },
        ];

        const applied = await importAgent(ctx, b, appDb);
        const skipped = applied.warnings.filter(
          (w) => w.code === "knowledgeBaseNameUnusable",
        );
        expect(skipped).toHaveLength(2);
        // Both rendered the same clipped text, which is what made them collapse.
        expect(
          new Set(skipped.map((w) => (w.params as { name: string }).name)).size,
        ).toBe(1);
        expect(
          await suDb.knowledgeBase.count({
            where: { tenantId, name: { startsWith: prefix } },
          }),
        ).toBe(0);

        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // The order the tools already had to learn (round 7), on this component too: a row ALREADY
      // stored under that name is one to reuse whatever the bundle says. Asking the name rule first
      // would report as skipped a base the apply reuses and grants.
      test("a stored base under an unusable name is reused, not skipped", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        // Only a row from before the rule can hold this name, so it is written straight through.
        await suDb.knowledgeBase.create({
          data: { tenantId, name: "   " },
          select: { id: true },
        });
        const b = bundle("https://example.com/v1/ok");
        b.components.knowledgeBases = [{ name: "   " }];

        const applied = await importAgent(ctx, b, appDb);
        expect(applied.warnings.map((w) => w.code)).toContain("kbReused");
        expect(applied.warnings.map((w) => w.code)).not.toContain(
          "knowledgeBaseNameUnusable",
        );
        expect(
          await suDb.knowledgeBase.count({ where: { tenantId, name: "   " } }),
        ).toBe(1);

        await suDb.knowledgeBase.deleteMany({
          where: {
            tenantId,
            name: { in: ["   ", "x".repeat(201), "boa_base_501"] },
          },
        });
        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // And a row another writer commits BETWEEN the lookup and the insert is a fact to read, not an
      // error to survive (review round 12). Inside this transaction a failed INSERT aborts
      // everything, so a plain create took the whole agent down — dry run included — the moment two
      // imports of the same bundle overlapped. Nothing here is timed: the other writer holds an
      // UNCOMMITTED row, which the import cannot see, so it resolves the credential as missing and
      // reaches its own insert; `pg_blocking_pids` is what proves it got there and is waiting.
      test("a credential another writer is creating is reused, not a collision", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const b = bundle("https://example.com/v1/ok");
        b.agent.modelConfig = { credentialRef: "cred_race_501" };
        b.agent.credentials = [{ name: "cred_race_501", kind: "generic" }];

        let release!: () => void;
        const held = new Promise<void>((r) => {
          release = r;
        });
        let announce!: (pid: number) => void;
        const gotIt = new Promise<number>((r) => {
          announce = r;
        });
        const holder = runScopedOn(appDb, ctx, async (db) => {
          await db.vaultEntry.create({
            data: {
              tenantId,
              name: "cred_race_501",
              kind: "generic",
              secret: "placeholder",
              status: "pending",
            },
          });
          const [me] = await db.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid()::int AS pid`;
          announce(me?.pid as number);
          await held;
        });
        // A holder that fails would otherwise hang this forever on a promise nobody resolves.
        const pid = await Promise.race([gotIt, holder.then(() => -1)]);
        expect(pid).toBeGreaterThan(0);

        const running = importAgent(ctx, b, appDb);
        expect(await someoneBlockedBy(pid)).toBe(true);
        release();
        await holder;

        const applied = await running;
        expect(applied.agent.name).toBe("Imported");
        // One row, the other writer's, and the import wired the ref to it.
        const rows = await suDb.vaultEntry.findMany({
          where: { tenantId, name: { startsWith: "cred_" } },
          select: { id: true },
        });
        expect(rows.length).toBe(1);
        // Reused, so it does not claim to have created it, and files no audit row for a write it
        // did not perform.
        expect(applied.warnings.map((w) => w.code)).not.toContain(
          "credentialPending",
        );
        expect(
          await suDb.auditLog.count({
            where: { tenantId, action: "credential.create" },
          }),
        ).toBe(0);

        await suDb.auditLog.deleteMany({ where: { tenantId } });
        await suDb.vaultEntry.deleteMany({
          where: { tenantId, name: { startsWith: "cred_" } },
        });
        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });

      // The other half of that write, and the branch the fix rewrote: a kind that CANNOT be created
      // as a reference-only entry (managed OAuth gets its secret from a connect flow the empty
      // placeholder cannot complete). It is asked of the guard the write itself asks, BEFORE the
      // write, rather than by catching what the write throws — because the call now runs inside the
      // import's transaction, and a statement that fails in there aborts it, so swallowing a
      // database error would carry the import on over a connection where everything after fails.
      test("a credential kind that cannot be pending is named, and the rest imports", async () => {
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const b = bundle("https://example.com/v1/ok");
        b.agent.modelConfig = { credentialRef: "cred_oauth_501" };
        b.agent.credentials = [
          { name: "cred_oauth_501", kind: "google_oauth" },
        ];

        const applied = await importAgent(ctx, b, appDb);
        expect(applied.warnings.map((w) => w.code)).toContain(
          "credentialNotFound",
        );
        expect(applied.warnings.map((w) => w.code)).not.toContain(
          "credentialPending",
        );
        // No entry written, and the agent still imported: one credential the target cannot hold is
        // not a refusal of the bundle.
        expect(
          await suDb.vaultEntry.count({
            where: { tenantId, name: { startsWith: "cred_" } },
          }),
        ).toBe(0);
        expect(applied.agent.name).toBe("Imported");

        await suDb.auditLog.deleteMany({ where: { tenantId } });
        await suDb.agentToolSelection.deleteMany({ where: { tenantId } });
        await suDb.agent.deleteMany({ where: { tenantId, name: "Imported" } });
        await suDb.toolDefinition.deleteMany({ where: { tenantId } });
      });
    });

    describe("an experiment's agent", () => {
      const variants = [{ key: "v", system_prompt: "VARIANT" }];

      test("an id that names no agent is refused by both halves", async () => {
        const r = await halves(experimentCreate as never, {
          name: "e",
          agent_id: "999999999",
          variants,
        });
        expect(r).toMatchObject({ applied: false, previewed: false });
        expect(await suDb.experiment.count({ where: { tenantId } })).toBe(0);
      });

      test("another tenant's agent is refused the same way", async () => {
        const other = await suDb.tenant.create({
          data: { name: "Other", slug: `other-${process.pid}` },
        });
        const theirs = await suDb.agent.create({
          data: { tenantId: other.id, name: "Theirs", systemPrompt: "" },
          select: { id: true },
        });
        const r = await halves(experimentCreate as never, {
          name: "e",
          agent_id: String(theirs.id),
          variants,
        });
        expect(r).toMatchObject({ applied: false, previewed: false });
        await suDb.tenant.delete({ where: { id: other.id } });
      });

      // The round that measured this file left it as the one accepted shape here, with the note that
      // `agentId: null` matches no agent because the resolver filters by an exact id, and that the
      // REST body documented it as "any agent". #547 is that note answered: no agent named is input
      // no reader can use, which is the whole thesis of this file.
      test("no agent at all is refused by both halves, and the row nobody can reach proves why", async () => {
        // The REASON, not just the refusal: with the rule gone, `assertAgentPresent` chokes on an id
        // that is not there and refuses anyway, so a bare `applied: false` passes over a tree that
        // no longer asks this question at all.
        expect(
          await halves(experimentCreate as never, { name: "loose", variants }),
        ).toMatchObject({
          applied: false,
          previewed: false,
          error: expect.stringContaining("names none"),
        });
        expect(await suDb.experiment.count({ where: { tenantId } })).toBe(0);

        // Seeded past the write, because the write is what now refuses it: this is the row a
        // deployment carries from before the rule, and it overrides nobody.
        await suDb.experiment.create({
          data: {
            tenantId,
            name: "loose",
            agentId: null,
            variants: [{ key: "v", weight: 1, systemPrompt: "VARIANT" }],
            enabled: true,
          },
        });
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const override = await runScopedOn(appDb, ctx, (db) =>
          resolveVariantOverride(db, {
            tenantId,
            agentId: BigInt(agentId),
            threadId: "loose-thread",
          }),
        );
        expect(override).toBeNull();
        await suDb.experiment.deleteMany({ where: { tenantId } });
      });

      test("clearing the agent of an experiment that works is refused, not read as widening it", async () => {
        const created = await experimentCreate(
          principal(),
          { name: "kept", agent_id: agentId, variants, dry_run: false },
          D,
        );
        expect(created.ok).toBe(true);
        const id = idOf(created, "id");
        expect(
          await halves(experimentUpdate as never, {
            experiment_id: id,
            agent_id: null,
          }),
        ).toMatchObject({
          applied: false,
          previewed: false,
          error: expect.stringContaining("names none"),
        });
        expect(
          String(
            (
              await suDb.experiment.findUniqueOrThrow({
                where: { id: BigInt(id) },
                select: { agentId: true },
              })
            ).agentId,
          ),
        ).toBe(agentId);
        await suDb.experiment.deleteMany({ where: { tenantId } });
      });

      test("the agent that exists gets its override, and the update is held to the rule", async () => {
        const created = await experimentCreate(
          principal(),
          { name: "live", agent_id: agentId, variants, dry_run: false },
          D,
        );
        expect(created.ok).toBe(true);
        const id = idOf(created, "id");
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        expect(
          await runScopedOn(appDb, ctx, (db) =>
            resolveVariantOverride(db, {
              tenantId,
              agentId: BigInt(agentId),
              threadId: "live-thread",
            }),
          ),
        ).toBe("VARIANT");

        const moved = await halves(experimentUpdate as never, {
          experiment_id: id,
          agent_id: "888888888",
        });
        expect(moved).toMatchObject({ applied: false, previewed: false });
        // The name too, on the PATCH. A mutation that dropped this one call from the update preview
        // alone survived every create-side row: a rule asked of one tool's create is not thereby
        // asked of its update, and the preview that stops asking is the #490 divergence again.
        expect(
          await halves(experimentUpdate as never, {
            experiment_id: id,
            name: "  ",
          }),
        ).toMatchObject({ applied: false, previewed: false });
        expect(
          String(
            (
              await suDb.experiment.findUniqueOrThrow({
                where: { id: BigInt(id) },
                select: { agentId: true },
              })
            ).agentId,
          ),
        ).toBe(agentId);
        await suDb.experiment.deleteMany({ where: { tenantId } });
      });

      // THE RACE, and it is why the lookup LOCKS instead of reading. There is no foreign key on
      // `Experiment.agentId`, and `deleteAgent` is the writer that slips between an unlocked check and
      // the insert that references the row: it takes the agent `FOR UPDATE`, nulls every experiment
      // pointing at it, and deletes it — so at READ COMMITTED the check approves an agent that is gone
      // by the time the row lands, which is the dangling reference this file exists to refuse.
      //
      // Driven through the REAL write rather than by re-issuing the lock here, because a test that
      // takes its own lock proves Postgres works and says nothing about `assertAgentPresent`: a
      // mutation that put the unlocked `findUnique` back would leave it green.
      //
      // NOTHING HERE IS TIMED, and that is the whole shape of it (review round 2). A sleep before
      // starting the writer assumes the holder already has its connection and its row lock; a sleep
      // after it assumes "has not settled yet" means "is waiting", which a writer that is merely slow
      // to start satisfies just as well. Both are false greens on a loaded database, in opposite
      // directions. So the holder SIGNALS its backend pid from inside the transaction, right after the
      // lock, and the writer is then proved to be waiting by asking Postgres who is blocking whom.
      type Holder = {
        pid: number;
        release: () => void;
        done: Promise<unknown>;
      };

      // Takes the lock `deleteAgent` takes on an agent, and resolves once it HAS it.
      async function holdAgentLock(agentId: bigint): Promise<Holder> {
        let release!: () => void;
        const held = new Promise<void>((r) => {
          release = r;
        });
        let announce!: (pid: number) => void;
        const gotIt = new Promise<number>((r) => {
          announce = r;
        });
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        const done = runScopedOn(appDb, ctx, async (db) => {
          await db.$queryRaw`SELECT id FROM agents WHERE id = ${agentId} FOR UPDATE`;
          const [me] = await db.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid()::int AS pid`;
          announce(me?.pid as number);
          await held;
        });
        // A holder that fails (a typo in the SQL, a permission) would otherwise hang this forever on
        // a promise nobody resolves, and the failure would read as a timeout with no cause.
        return {
          pid: await Promise.race([gotIt, done.then(() => -1)]),
          release,
          done,
        };
      }

      test("the create waits for the agent's own lock, so a delete cannot land mid-write", async () => {
        const victim = await suDb.agent.create({
          data: { tenantId, name: "Victim", systemPrompt: "" },
          select: { id: true },
        });
        const holder = await holdAgentLock(victim.id);
        expect(holder.pid).toBeGreaterThan(0);

        let settled = false;
        const write = experimentCreate(
          principal(),
          {
            name: "raced",
            agent_id: String(victim.id),
            variants,
            dry_run: false,
          },
          D,
        ).then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        // Waiting on the holder's lock, asked of Postgres. Unlocked, the write never blocks on
        // anything and this stays false until the timeout.
        expect(await someoneBlockedBy(holder.pid)).toBe(true);
        expect(settled).toBe(false);

        holder.release();
        await holder.done;
        await write;
        expect(settled).toBe(true);
        await suDb.experiment.deleteMany({ where: { tenantId } });
        await suDb.agent.delete({ where: { id: victim.id } });
      });

      test("the update waits for it too, and takes it BEFORE the experiment's own row", async () => {
        const victim = await suDb.agent.create({
          data: { tenantId, name: "Victim2", systemPrompt: "" },
          select: { id: true },
        });
        const created = await experimentCreate(
          principal(),
          { name: "movable", agent_id: agentId, variants, dry_run: false },
          D,
        );
        const expId = idOf(created, "id");
        const holder = await holdAgentLock(victim.id);
        expect(holder.pid).toBeGreaterThan(0);

        let settled = false;
        const write = experimentUpdate(
          principal(),
          { experiment_id: expId, agent_id: String(victim.id), dry_run: false },
          D,
        ).then(() => {
          settled = true;
        });
        expect(await someoneBlockedBy(holder.pid)).toBe(true);
        expect(settled).toBe(false);

        // The ORDER is the half a blocking assertion cannot see, and it is what keeps this off a
        // deadlock with `deleteAgent` (the agent, then the experiments pointing at it). Read from
        // the effect: parked on the AGENT, the update has not taken the experiment's row, so a
        // second transaction can still take it. Under a statement timeout, because the wrong order
        // makes this WAIT — and a test that hangs reports nothing.
        const ctx = {
          tenantId,
          userId: 1n,
          role: "TENANT_ADMIN",
        } as TenantContext;
        await runScopedOn(appDb, ctx, async (db) => {
          await db.$executeRawUnsafe("SET LOCAL statement_timeout = '2000ms'");
          await db.$queryRaw`SELECT id FROM experiments WHERE id = ${BigInt(expId)} FOR UPDATE`;
        });

        holder.release();
        await holder.done;
        await write;
        expect(settled).toBe(true);
        await suDb.experiment.deleteMany({ where: { tenantId } });
        await suDb.agent.delete({ where: { id: victim.id } });
      });

      test("a blank or oversized experiment name is refused by both halves", async () => {
        for (const name of ["", "  ", "z".repeat(201)]) {
          expect({
            name: name.slice(0, 12),
            ...(await halves(experimentCreate as never, { name, variants })),
          }).toMatchObject({ applied: false, previewed: false });
        }
        expect(await suDb.experiment.count({ where: { tenantId } })).toBe(0);
      });
    });
  },
);
