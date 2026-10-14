import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildId } from "../../scripts/lib/build-id";

// Two builds of one tree inline the same id (CI builds it for the CDN and again per image
// architecture); a change to anything the bundle is built from, or to the edition or CDN it is
// built for, gives another id.

const root = await mkdtemp(join(tmpdir(), "build-id-"));
afterAll(() => rm(root, { recursive: true, force: true }));

async function tree(name: string, files: Record<string, string>) {
  const dir = join(root, name);
  for (const [file, body] of Object.entries(files)) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), body);
  }
  return dir;
}

const BASE = {
  "package.json": '{"version":"9.9.2"}',
  "bun.lock": "lock",
  "build.ts": "build",
  "src/client/App.tsx": "app",
  "public/index.html": "<html>",
};
const BUILT = { cdnUrl: "", edition: "full" };
const id = (dir: string, built = BUILT) =>
  buildId({ root: dir, version: "9.9.2", ...built });

describe("the build id", () => {
  test("is the same for two builds of the same tree, prefixed by the version", async () => {
    const a = await id(await tree("a", BASE));
    const b = await id(await tree("b", BASE));
    expect([a === b, a.startsWith("9.9.2+")]).toEqual([true, true]);
  });

  test("changes with a source file", async () => {
    const a = await id(await tree("c", BASE));
    const b = await id(
      await tree("d", { ...BASE, "src/client/App.tsx": "app2" }),
    );
    expect(a === b).toBe(false);
  });

  test("changes when a file moves to another path with the same bytes", async () => {
    const { "src/client/App.tsx": app, ...rest } = BASE;
    const a = await id(await tree("m", BASE));
    const b = await id(
      await tree("n", { ...rest, "src/client/Main.tsx": app }),
    );
    expect(a === b).toBe(false);
  });

  test("changes with a file under public/", async () => {
    const a = await id(await tree("e", BASE));
    const b = await id(
      await tree("f", { ...BASE, "public/index.html": "<html lang>" }),
    );
    expect(a === b).toBe(false);
  });

  test("changes with the lockfile", async () => {
    const a = await id(await tree("g", BASE));
    const b = await id(await tree("h", { ...BASE, "bun.lock": "lock2" }));
    expect(a === b).toBe(false);
  });

  test("changes with tsconfig.json, whose aliases and JSX options the bundler reads", async () => {
    const a = await id(await tree("o", { ...BASE, "tsconfig.json": "{}" }));
    const b = await id(
      await tree("p", { ...BASE, "tsconfig.json": '{"compilerOptions":{}}' }),
    );
    expect(a === b).toBe(false);
  });

  test("ignores a markdown file, which the image's build never sees", async () => {
    const a = await id(await tree("i", BASE));
    const b = await id(
      await tree("j", { ...BASE, "src/client/NOTES.md": "notes" }),
    );
    expect(a === b).toBe(true);
  });

  test("changes with the edition and with the CDN the bundle points at", async () => {
    const dir = await tree("k", BASE);
    const base = await id(dir);
    const free = await id(dir, { ...BUILT, edition: "free" });
    const cdn = await id(dir, { ...BUILT, cdnUrl: "https://cdn" });
    expect([base === free, base === cdn]).toEqual([false, false]);
  });
});
