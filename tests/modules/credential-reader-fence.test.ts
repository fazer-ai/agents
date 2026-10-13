import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
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

  // The other half of the rule, and the reason the list above is not just "these files are old": the
  // modules that DO send a secret outbound resolve it through the use-aware entry point.
  test("the API-key readers go through the use-aware resolver", async () => {
    const expected = [
      "src/graph/prepare.ts",
      "src/modules/models/service.ts",
      "src/modules/stt/service.ts",
      "src/modules/tts/listing.ts",
      "src/modules/tts/service.ts",
      "src/modules/vision/service.ts",
    ];
    for (const path of expected) {
      // Stripped for the same reason as above: a comment naming the resolver is not a call to it.
      expect(withoutComments(await Bun.file(path).text())).toContain(
        "tryResolveApiKeyEntry",
      );
    }
  });
});
