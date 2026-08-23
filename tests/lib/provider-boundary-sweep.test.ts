import { describe, expect, test } from "bun:test";

// THE GUARD AGAINST THE TENTH CALL SITE.
//
// The rule this file enforces was already written down nine times when the leak that motivated it
// was found, once beside each call site that follows it: `ChatwootApiError` (status and endpoint,
// never the body), `SttError` / `VisionError` (`never capture the response body`), the tool lane's
// first-line cut, the `tts` line's slug-shaped code, `redactSecretsDeep` on `detail`, the guard on
// the contact-authorization `reason`, and so on. Every one of those carries a comment explaining
// why. It still did not stop the tenth boundary from being written without it, because a rule kept
// beside its call sites is invisible from the place where the next call site is born.
//
// Prose cannot fix that — `docs/stt.md` already says "Adding a provider = one function + one
// registry entry" and names `SttError`, which is exactly why `stt` and `vision` held while
// embeddings, in a module with no such paragraph, did not. What reaches a module that does not
// exist yet is a check that FAILS on it.
//
// So: a file that authenticates to an operator-configured endpoint and issues a request is a
// provider boundary, and every one of them must be listed below saying HOW it keeps the other end's
// text out of an operator-facing store. A new one is a test failure until somebody answers the
// question. The list is the deliverable; the assertions under it are what keep the answers honest.

// How each boundary discharges the rule.
//
//   own-error-type   throws only a class it defines, built from a status and a constant
//   throughProvider  wraps the call in `@/lib/provider-failure`
//   runModelCall     the request is issued elsewhere, behind the model semaphore, which reduces it
//   not-a-provider   matched the predicate without being one; the entry records the judgement
type Discharge =
  | "own-error-type"
  | "throughProvider"
  | "runModelCall"
  | "not-a-provider";

const BOUNDARIES: Record<string, Discharge> = {
  // Builds the chat clients; nothing here awaits one. Every invocation goes through `runModelCall`
  // (src/graph/model-limit.ts), which replaces what the provider wrote.
  "src/graph/models.ts": "runModelCall",
  "src/modules/stt/providers.ts": "own-error-type",
  "src/modules/vision/providers.ts": "own-error-type",
  "src/modules/tts/providers.ts": "own-error-type",
  // The OpenAI client builds its message out of the response body, measured in
  // tests/modules/rag-embeddings-failure.test.ts, so this one needs the wrapper.
  "src/modules/rag/embeddings.ts": "throughProvider",
  // OUR server, not a provider client: it matches on the API-key admin tools it exposes and on a
  // URL fetch that carries no operator credential to a model vendor.
  "src/modules/mcp/server.ts": "not-a-provider",
};

// Authenticates to something the operator configured, AND issues the request itself.
function isCandidate(src: string): boolean {
  if (!src.includes("apiKey")) return false;
  return /fetchImpl\(|await fetch\(|new OpenAIEmbeddings|new Chat[A-Z]/.test(
    src,
  );
}

async function candidates(): Promise<string[]> {
  const { Glob } = await import("bun");
  const found: string[] = [];
  for await (const file of new Glob("src/**/*.ts").scan(".")) {
    if (isCandidate(await Bun.file(file).text())) found.push(file);
  }
  return found.sort();
}

describe("every provider boundary answers for the other end's text", () => {
  test("a boundary that is not on the list fails this test", async () => {
    const found = await candidates();
    // Both directions: an unlisted file is the tenth call site, and a listed file that stopped
    // matching means the list is describing code that no longer exists.
    expect(found).toEqual(Object.keys(BOUNDARIES).sort());
  });

  // The predicate itself, against a known positive and a known negative. A sweep that matches
  // nothing reports a clean tree forever, which is the failure mode of every check like this one.
  test("the predicate recognises a boundary and ignores a bystander", () => {
    expect(
      isCandidate(
        "const res = await req.fetchImpl(url, { headers: { authorization: apiKey } });",
      ),
    ).toBe(true);
    expect(isCandidate("const apiKey = cfg.apiKey; return apiKey;")).toBe(
      false,
    );
    expect(isCandidate("await fetch(url); // no credential here")).toBe(false);
  });

  test("each answer is the one the file actually gives", async () => {
    const offenders: string[] = [];
    for (const [file, discharge] of Object.entries(BOUNDARIES)) {
      const src = await Bun.file(file).text();
      if (discharge === "throughProvider") {
        // Per ENTRY POINT, not per file. Checking the file only asks whether the wrapper appears
        // somewhere in it, and a module with two exported calls satisfies that with one of them
        // wrapped — which is exactly the half-converted shape this whole change is about. Removing
        // the wrapper from `embedQuery` alone passed the file-level version of this check.
        const entries = src.split(/export async function /).slice(1);
        if (entries.length === 0) {
          offenders.push(
            `${file}: says throughProvider, exports no async entry point`,
          );
        }
        for (const entry of entries) {
          const name = entry.slice(0, entry.indexOf("("));
          if (!/\bthroughProvider\(/.test(entry)) {
            offenders.push(
              `${file}: ${name} does not go through throughProvider`,
            );
          }
        }
      }
      if (discharge === "own-error-type") {
        const owned = [...src.matchAll(/class (\w+) extends Error/g)].map(
          (m) => m[1],
        );
        if (owned.length === 0) {
          offenders.push(`${file}: says own-error-type, defines none`);
        }
        // The CALL, not the identifier: a file that defines its own error and then throws something
        // else somewhere is the half-converted shape this is meant to catch.
        for (const m of src.matchAll(/throw new (\w+)\(/g)) {
          const thrown = m[1] as string;
          if (!owned.includes(thrown)) {
            offenders.push(
              `${file}: throws ${thrown}, which it does not define`,
            );
          }
        }
      }
      if (
        discharge === "runModelCall" &&
        /await \w*\.(invoke|stream)\(/.test(src)
      ) {
        offenders.push(
          `${file}: says runModelCall, awaits a model call itself`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
