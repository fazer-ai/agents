import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { documentToolName } from "@/modules/documents/slug";

// ONE PLACE SPELLS THE TOOL NAME.
//
// `send_<slug>` is what the model is offered, what the grants editor shows the operator, and what
// the template modal previews while they type a name. It had been written out by hand in three of
// those, and the fourth reader is always the one that ends up disagreeing — the console showed a
// tool name derived one way while the runtime built another.
//
// So this reads the source rather than the behaviour: a decision table proves the FUNCTION, and the
// thing that keeps going wrong is a call site not using it.

const ROOT = join(import.meta.dir, "..", "..", "src");
const ALLOWED = join("modules", "documents", "slug.ts");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sources(full, out);
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// The interpolated form only: `send_image` and friends are native tool names spelled in full, and a
// rule about a template's slug says nothing about them.
const INTERPOLATED = /`send_\$\{/;

function offenders(): string[] {
  return sources(ROOT)
    .filter((f) => !f.endsWith(ALLOWED))
    .filter((f) => INTERPOLATED.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length + 1));
}

test("the send_<slug> rule is spelled in exactly one module", () => {
  expect(offenders()).toEqual([]);
});

test("the sweep would actually catch a second copy", () => {
  // Validated against a known positive, because a detector that reports zero on every input is
  // indistinguishable from a broken one — and this one is a regex over files it found itself, so
  // both halves can fail silently (an empty file list reports clean just as loudly).
  expect(sources(ROOT).length).toBeGreaterThan(100);
  const slugModule = readFileSync(join(ROOT, ALLOWED), "utf8");
  expect(INTERPOLATED.test(slugModule)).toBe(true);
});

test("and the one module produces what everything else asks it for", () => {
  expect(documentToolName("orcamento")).toBe("send_orcamento");
});
