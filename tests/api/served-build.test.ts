import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServedBuild } from "@/api/lib/served-build";
import { buildApp } from "@/app";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// Every response names the build the server serves, so an open console tab can compare it with its
// own; refusals too, since a 401 or a 404 after a deploy comes from the new build as well.
setupPrismaMock();

const BUILD = { version: "9.9.2", buildId: "9.9.2+b" };
const app = await buildApp({ build: BUILD });
const bare = await buildApp({ build: null });

const named = async (target: typeof app, path: string) => {
  const res = await target.handle(new Request(`http://localhost${path}`));
  return {
    status: res.status,
    build: res.headers.get("x-app-build"),
    version: res.headers.get("x-app-version"),
  };
};

describe("the served build on the wire", () => {
  test("a successful response names it", async () => {
    expect(await named(app, "/.well-known/oauth-authorization-server")).toEqual(
      { status: 200, build: "9.9.2+b", version: "9.9.2" },
    );
  });

  test("a refusal for a missing session names it", async () => {
    expect(await named(app, "/api/updates")).toEqual({
      status: 401,
      build: "9.9.2+b",
      version: "9.9.2",
    });
  });

  test("a missing API route names it", async () => {
    expect(await named(app, "/api/no-such-route")).toEqual({
      status: 404,
      build: "9.9.2+b",
      version: "9.9.2",
    });
  });

  test("a server with no build to name sends neither header", async () => {
    expect(await named(bare, "/api/no-such-route")).toEqual({
      status: 404,
      build: null,
      version: null,
    });
  });
});

const dir = await mkdtemp(join(tmpdir(), "served-build-"));

describe("reading dist/build.json", () => {
  afterAll(() => rm(dir, { recursive: true, force: true }));
  const write = async (name: string, body: string) => {
    const file = join(dir, name);
    await writeFile(file, body);
    return file;
  };

  test("reads the version and the build id the build wrote", async () => {
    const file = await write(
      "ok.json",
      '{"version":"9.9.2","buildId":"9.9.2+b"}\n',
    );
    expect(await readServedBuild(file)).toEqual(BUILD);
  });

  test("a file without a version still names the build, with an empty version", async () => {
    const file = await write("nover.json", '{"buildId":"9.9.2+b"}');
    expect(await readServedBuild(file)).toEqual({
      version: "",
      buildId: "9.9.2+b",
    });
  });

  test("a missing file is no build, not a stale one", async () => {
    expect(await readServedBuild(join(dir, "absent.json"))).toBeNull();
  });

  test("a file without a build id is no build", async () => {
    const file = await write("noid.json", '{"version":"9.9.2"}');
    expect(await readServedBuild(file)).toBeNull();
  });

  test("a file that is not JSON is no build", async () => {
    const file = await write("garbage.json", "<html>");
    expect(await readServedBuild(file)).toBeNull();
  });
});
