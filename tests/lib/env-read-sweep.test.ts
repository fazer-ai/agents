import { describe, expect, test } from "bun:test";
import { codeOnly } from "@/tests/utils/source-text";

// THE ENVIRONMENT IS READ IN ONE PLACE (issue #822).
//
// `src/config.ts` is where a variable becomes a setting: it is parsed, validated, given a default and
// listed where an operator can find it (`.env.example`). A read anywhere else skips all of that, and
// the one that prompted this file was a measurement probe, a `Bun.sleep` on an environment variable,
// committed by accident at the top of every flow-log write and shipped in every release for a month:
// undocumented, unvalidated (a non-numeric value became `NaN`), and on the hot path of every turn.
// Nothing would have caught it, because nothing asked.
//
// So a file under `src/` that reads the environment is either `src/config.ts` or listed below with the
// reason it cannot go through it. A new one fails until somebody answers the question; a listed one
// that stopped reading fails too, so the list never describes code that is gone.
const READS_OUTSIDE_CONFIG: Record<string, string> = {
  // Imported by `config.ts`'s own consumers at module load, and pinned per replica rather than per
  // install; the default is a fresh UUID, which config cannot express as a static value.
  "src/lib/instance.ts": "INSTANCE_ID",
  // An operator override for the decoder's location, read where the library is loaded so a copy can
  // be swapped without rebuilding; documented beside `LIBHEIF_WASM_PATH_ENV`.
  "src/modules/vision/convert/heic.ts": "VISION_LIBHEIF_WASM_PATH",
  // The browser bundle: Bun inlines `process.env.BUN_PUBLIC_*` at build time, and `config.ts` is
  // server-only.
  "src/client/lib/env.ts": "BUN_PUBLIC_*",
};

const READS_ENV = /\bprocess\.env\b|\bBun\.env\b|\bimport\.meta\.env\b/;

async function readers(): Promise<string[]> {
  const { Glob } = await import("bun");
  const found: string[] = [];
  for await (const file of new Glob("src/**/*.{ts,tsx}").scan(".")) {
    if (file === "src/config.ts") continue;
    // Through the scan, so a comment that names `process.env` (several explain why they do not read
    // it) does not make a file a reader.
    if (READS_ENV.test(codeOnly(await Bun.file(file).text()))) found.push(file);
  }
  return found.sort();
}

describe("the environment is read in src/config.ts, or the file says why not", () => {
  test("every reader outside config is on the list, and every listed file still reads", async () => {
    expect(await readers()).toEqual(Object.keys(READS_OUTSIDE_CONFIG).sort());
  });

  // A sweep that matches nothing reports a clean tree forever.
  test("the predicate sees a read and ignores a comment about one", () => {
    expect(
      READS_ENV.test(
        codeOnly("await Bun.sleep(Number(process.env.PROBE_X ?? 0));"),
      ),
    ).toBe(true);
    expect(READS_ENV.test(codeOnly('const v = Bun.env["X"];'))).toBe(true);
    expect(
      READS_ENV.test(codeOnly("// reads process.env only in config")),
    ).toBe(false);
  });
});
