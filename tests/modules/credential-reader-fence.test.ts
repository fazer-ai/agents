import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Glob } from "bun";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { formatVaultRef } from "@/client/lib/credentialRef";
import { loadAgentConfig } from "@/graph/prepare";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { listProviderModels } from "@/modules/models/service";
import { transcribePlaygroundAudio } from "@/modules/stt/service";
import { listTtsOptions } from "@/modules/tts/listing";
import { synthesizeReply } from "@/modules/tts/service";
import { TTS_DEFAULTS, type TtsConfig } from "@/modules/tts/settings";
import { extractPlaygroundFile } from "@/modules/vision/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { withoutComments } from "@/tests/utils/source-text";

// Who is allowed to read a vault secret RAW, and who has to go through a resolver that answers for
// the pairing. `tryResolveVaultEntry` hands back `secret: unknown` plus the entry's `kind`, and a
// caller can still narrow with a bare `typeof x === "string"`, which passes `mcp_env`: a real string
// the catalog says must never leave this process. A type cannot close that, so this fence does.
//
// The rule: a module that sends a secret to somebody else's endpoint resolves it through
// `tryResolveApiKeyEntry` (a plain key) or `resolveInjectableCredential*` (a key or a refreshed OAuth
// token). Everything else is listed here with the reason it reads the entry directly.

const RAW_READER = "tryResolveVaultEntry";

// path → why this module reads the entry directly instead of through a use-aware resolver.
const ALLOWED: Record<string, string> = {
  "src/modules/vault/service.ts":
    "defines both resolvers; the use-aware one is built on the raw one",
  "src/modules/vault/injectable.ts":
    "IS the use-aware resolver for the injectable case: refreshes managed-OAuth tokens, refuses a non-string otherwise",
  "src/graph/observability.ts":
    "langfuse is a declared key PAIR, not a string: it parses the object with langfuseKeysSchema and the value never leaves as a credential header",
  "src/graph/tools/assemble.ts":
    "MCP tool assembly: reads kind + paramName as well, and the token for a managed-OAuth kind is refreshed later, outside the tx",
  "src/modules/mcp-connections/service.ts":
    "same as assemble.ts, for the Discover path",
  "src/modules/integrations/google-calendar.service.ts":
    "asks for one specific kind (google_oauth) by name and refuses everything else",
  "src/modules/integrations/google-drive.service.ts": "same as google-calendar",
};

// Comments are not usage, and a fence that counts them lies in the direction that matters: it lets a
// file stay on the list for a MENTION and then covers a real raw read added there later. Strings are
// kept, since a file that names the resolver inside one is doing something worth listing.
//
// Paths come back relative to `root` (`src/...`), the spelling ALLOWED uses, so the same scan reads
// the checkout and a scratch tree laid out like it.
async function rawReaders(root = "."): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of new Glob("src/**/*.{ts,tsx}").scan(root)) {
    const code = withoutComments(await Bun.file(join(root, rel)).text());
    if (code.includes(RAW_READER)) out.push(rel);
  }
  return out.sort();
}

// The controls below need a file the scan walks, and `src/` is not theirs to write: another test
// process sweeping `src/` at the same moment lists the file and then reads it after it is gone. So
// they scan a scratch tree holding the listed readers at their real paths plus the file under test.
async function scratchTree(extra: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "credential-reader-fence-"));
  for (const path of Object.keys(ALLOWED)) await cp(path, join(root, path));
  for (const [path, text] of Object.entries(extra))
    await Bun.write(join(root, path), text);
  return root;
}

describe("who may read a vault secret without asking what it is for", () => {
  test("every raw reader is listed, and every listing is a raw reader", async () => {
    const found = await rawReaders();
    // Both directions: an unlisted reader is the defect, and a listing with no reader left is a stale
    // exemption that would silently adopt the next module to take that path.
    expect(new Set(found)).toEqual(new Set(Object.keys(ALLOWED)));
  });

  // The fence is only worth its line count if it fails on the thing it describes. The defect is a
  // module outside the list reading the raw resolver, so the control is exactly that, at a path the
  // scan walks, next to the listed readers that alone satisfy the fence.
  test("it catches a reader that is not listed", async () => {
    const path = "src/modules/vault/__fence_probe.ts";
    const root = await scratchTree({
      [path]: `import { ${RAW_READER} } from "./service";\nexport const x = ${RAW_READER};\n`,
    });
    try {
      const found = await rawReaders(root);
      expect(found).toContain(path);
      expect(new Set(found)).not.toEqual(new Set(Object.keys(ALLOWED)));
      expect(new Set(found.filter((p) => p !== path))).toEqual(
        new Set(Object.keys(ALLOWED)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The other direction: a file whose only occurrence is a comment must NOT read as a reader, or an
  // exemption granted for a mention keeps standing over the real read somebody adds under it later.
  test("a file that only mentions the resolver in a comment is not a reader", async () => {
    const path = "src/modules/vault/__fence_mention.ts";
    const root = await scratchTree({
      [path]:
        `// a note about ${RAW_READER} and why this file does not use it\n` +
        `/* ${RAW_READER} again, in a block */\n` +
        `export const y = 1;\n`,
    });
    try {
      expect(await rawReaders(root)).not.toContain(path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

// The other half of the rule: every module that sends a key to a vendor refuses an `mcp_env` entry,
// a real string the catalog says never leaves this process. Each sink is called twice, once with a
// plain API key (which has to reach the vendor, or the refusal below proves nothing) and once with
// the stdio token, which must reach no request at all.
const KEY = `sk-sink-${process.pid}`;
const STDIO = `stdio-token-${process.pid}`;

let tenantId = 0n;
let keyRef = "";
let envRef = "";
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Every request a sink makes, flattened to text, so a secret is found wherever it travels: the URL,
// a header, or the body.
function recordingFetch(body: () => Response) {
  const seen: string[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push(
      [
        String(url),
        JSON.stringify([...headers.entries()]),
        typeof init?.body === "string" ? init.body : "",
      ].join(" "),
    );
    return body();
  }) as unknown as typeof fetch;
  return {
    fn,
    sent: (secret: string) => seen.some((s) => s.includes(secret)),
    count: () => seen.length,
  };
}

const json = (value: unknown) => () => Response.json(value);

// The outcome after the credential is not what these tests are about: a vendor answering a stub
// may fail further on, and only what reached the wire is asserted.
async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (err) {
    return err;
  }
}

describe.skipIf(!dbUp)(
  "every API-key sink refuses a never-outbound secret",
  () => {
    beforeAll(async () => {
      tenantId = (
        await suDb.tenant.create({
          data: { name: "Sinks", slug: `sinks-${process.pid}` },
          select: { id: true },
        })
      ).id;
      const mk = async (
        name: string,
        kind: string,
        secret: string,
        extra = {},
      ) =>
        formatVaultRef(
          String(
            (
              await suDb.vaultEntry.create({
                data: {
                  tenantId,
                  name,
                  kind,
                  secret: encryptJson(secret),
                  ...extra,
                },
                select: { id: true },
              })
            ).id,
          ),
        );
      keyRef = await mk("vendor-key", "generic", KEY);
      envRef = await mk("stdio-token", "mcp_env", STDIO, {
        paramName: "API_TOKEN",
      });
    });

    afterAll(async () => {
      if (tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("the turn's model key (graph/prepare.ts)", async () => {
      const load = async (credentialRef: string) => {
        const agent = await suDb.agent.create({
          data: {
            tenantId,
            name: `Model ${credentialRef}`,
            systemPrompt: "x",
            modelConfig: {
              provider: "openai",
              model: "gpt-4o-mini",
              credentialRef,
            },
          },
          select: { id: true },
        });
        return runScopedOn(appDb, ctx(), (db) =>
          loadAgentConfig(db, {
            tenantId,
            instanceId: 0n,
            conversationId: 1,
            agentId: agent.id,
            threadId: `${tenantId}:0:1`,
          }),
        );
      };
      expect((await load(keyRef))?.apiKey).toBe(KEY);
      expect(await load(envRef)).toBeNull();
    });

    test("the model picker's listing (modules/models/service.ts)", async () => {
      const list = async (credentialRef: string) => {
        const wire = recordingFetch(json({ data: [{ id: "gpt-4o" }] }));
        await settle(() =>
          listProviderModels(
            ctx(),
            { provider: "openai", credentialRef },
            appDb,
            wire.fn,
          ),
        );
        return wire;
      };
      expect((await list(keyRef)).sent(KEY)).toBe(true);
      const refused = await list(envRef);
      expect(refused.sent(STDIO)).toBe(false);
      expect(refused.count()).toBe(0);
    });

    test("the voice picker's listing (modules/tts/listing.ts)", async () => {
      const list = async (credentialRef: string) => {
        const wire = recordingFetch(json({ voices: [] }));
        const out = await settle(() =>
          listTtsOptions(
            ctx(),
            { provider: "elevenlabs", kind: "voices", credentialRef },
            appDb,
            wire.fn,
            async (url: string) => new URL(url),
          ),
        );
        return { wire, out };
      };
      expect((await list(keyRef)).wire.sent(KEY)).toBe(true);
      const refused = await list(envRef);
      expect(refused.wire.count()).toBe(0);
      expect((refused.out as { translationKey?: string }).translationKey).toBe(
        "errors.credentialNotUsable",
      );
    });

    test("the spoken reply (modules/tts/service.ts)", async () => {
      const speak = async (credentialRef: string) => {
        const wire = recordingFetch(
          () =>
            new Response(new ArrayBuffer(16), {
              status: 200,
              headers: { "content-type": "audio/ogg" },
            }),
        );
        const cfg: TtsConfig = {
          ...TTS_DEFAULTS,
          mode: "mirror",
          provider: "openai",
          model: "tts-1",
          voice: "alloy",
          credentialRef,
          normalize: false,
        };
        const out = await settle(() =>
          synthesizeReply({
            tenantId,
            cfg,
            text: "olá",
            base: appDb,
            deps: { fetchImpl: wire.fn },
          }),
        );
        return { wire, out };
      };
      expect((await speak(keyRef)).wire.sent(KEY)).toBe(true);
      const refused = await speak(envRef);
      expect(refused.wire.count()).toBe(0);
      expect(refused.out).toBeNull();
    });

    test("the playground transcription (modules/stt/service.ts)", async () => {
      const hear = async (credentialRef: string) => {
        const wire = recordingFetch(json({ text: "oi" }));
        const out = await settle(() =>
          transcribePlaygroundAudio({
            ctx: ctx(),
            agentId: 1n,
            audio: new ArrayBuffer(8),
            mimeType: "audio/ogg",
            settings: {
              stt: {
                enabled: true,
                provider: "openai",
                model: "whisper-1",
                credentialRef,
              },
            },
            base: appDb,
            deps: { fetchImpl: wire.fn },
          }),
        );
        return { wire, out };
      };
      expect((await hear(keyRef)).wire.sent(KEY)).toBe(true);
      const refused = await hear(envRef);
      expect(refused.wire.count()).toBe(0);
      expect((refused.out as { translationKey?: string }).translationKey).toBe(
        "errors.credentialKindUnusableAsKey",
      );
    });

    test("the playground file reading (modules/vision/service.ts)", async () => {
      const read = async (credentialRef: string) => {
        const wire = recordingFetch(
          json({
            choices: [{ message: { role: "assistant", content: "um recibo" } }],
          }),
        );
        const out = await settle(() =>
          extractPlaygroundFile({
            ctx: ctx(),
            agentId: 1n,
            file: new ArrayBuffer(8),
            mimeType: "image/png",
            settings: {
              vision: {
                enabled: true,
                provider: "openai",
                model: "gpt-4o",
                credentialRef,
              },
            },
            base: appDb,
            deps: { fetchImpl: wire.fn, sleep: async () => {} },
          }),
        );
        return { wire, out };
      };
      expect((await read(keyRef)).wire.sent(KEY)).toBe(true);
      const refused = await read(envRef);
      expect(refused.wire.count()).toBe(0);
      expect((refused.out as { translationKey?: string }).translationKey).toBe(
        "errors.credentialKindUnusableAsKey",
      );
    });
  },
);
