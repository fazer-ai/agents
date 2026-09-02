import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// Who is allowed to read a vault secret RAW, and who has to go through a resolver that answers for
// the pairing. Issue #471.
//
// `tryResolveVaultEntry` hands back `secret: unknown` plus the entry's `kind`, and answering "can
// this serve my field?" from those two is the caller's job. Eight call sites got that wrong the same
// way (they wrote `<string>` and used it), so the compiler now refuses the assertion — but a caller
// can still narrow with a bare `typeof x === "string"`, which passes `mcp_env`: a real string the
// catalog says must never leave this process. That is the hole a type cannot close, and this is the
// fence over it.
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
  "src/modules/tenant-settings/service.ts":
    "reads the entry to assert a fixed kind (langfuse) at the write boundary; no secret is used",
};

async function rawReaders(root: string): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of new Glob("**/*.{ts,tsx}").scan(root)) {
    const path = `${root}/${rel}`;
    if ((await Bun.file(path).text()).includes(RAW_READER)) out.push(path);
  }
  return out.sort();
}

describe("who may read a vault secret without asking what it is for", () => {
  test("every raw reader is listed, and every listing is a raw reader", async () => {
    const found = await rawReaders("src");
    // Both directions: an unlisted reader is the defect, and a listing with no reader left is a stale
    // exemption that would silently adopt the next module to take that path.
    expect(new Set(found)).toEqual(new Set(Object.keys(ALLOWED)));
  });

  // The fence is only worth its line count if it fails on the thing it describes. The defect is a
  // module outside the list reading the raw resolver, so the control is exactly that, in a file the
  // scan actually walks.
  test("it catches a reader that is not listed", async () => {
    const path = `src/modules/vault/__fence_probe_${process.pid}.ts`;
    await Bun.write(
      path,
      `import { ${RAW_READER} } from "./service";\nexport const x = ${RAW_READER};\n`,
    );
    try {
      const found = await rawReaders("src");
      expect(found).toContain(path);
      expect(new Set(found)).not.toEqual(new Set(Object.keys(ALLOWED)));
    } finally {
      await Bun.file(path).delete();
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
      expect(await Bun.file(path).text()).toContain("tryResolveApiKeyEntry");
    }
  });
});
