import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runI18nExtract } from "../../scripts/i18n-extract";

// mkdir/mkdtemp/rm still use node:fs/promises because Bun has no
// equivalents yet; file writes use Bun.write per the project guideline.
async function makeFixture(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "i18n-extract-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "locales"), { recursive: true });
  await Bun.write(join(dir, "src", "a.tsx"), source);
  const configPath = join(dir, "config.cjs");
  const srcGlob = JSON.stringify(join(dir, "src"));
  const outDir = JSON.stringify(join(dir, "locales"));
  await Bun.write(
    configPath,
    `module.exports = {
  locales: ["en"],
  output: ${outDir} + "/$LOCALE.json",
  input: [${srcGlob} + "/**/*.{ts,tsx}"],
  defaultNamespace: "translation",
  keySeparator: ".",
  namespaceSeparator: ":",
  createOldCatalogs: false,
  defaultValue: (_l, _n, _k, v) => v || "",
  lexers: { ts: ["JavascriptLexer"], tsx: ["JsxLexer"] },
  lineEnding: "lf",
};`,
  );
  return { dir, configPath };
}

describe("i18n-extract conflict detection", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const dir of cleanup) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanup.length = 0;
  });

  test("exits 1 when the same key is called with different default values", async () => {
    const { dir, configPath } = await makeFixture(`
import { useTranslation } from "react-i18next";
export function X() {
  const { t } = useTranslation();
  return [t("demo.dup", "First"), t("demo.dup", "Second")];
}
`);
    cleanup.push(dir);

    const result = await runI18nExtract([{ label: "fixture", configPath }], {
      silent: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.conflicts).toEqual([
      { label: "fixture", key: "translation:demo.dup" },
    ]);
  });

  test("exits 0 when all call sites agree on the default value", async () => {
    const { dir, configPath } = await makeFixture(`
import { useTranslation } from "react-i18next";
export function X() {
  const { t } = useTranslation();
  return [t("demo.same", "Same"), t("demo.same", "Same")];
}
`);
    cleanup.push(dir);

    const result = await runI18nExtract([{ label: "fixture", configPath }], {
      silent: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.conflicts).toEqual([]);
  });
});
