import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";

import {
  applyStaticCacheControl,
  cacheControlFor,
  developmentIndexHandler,
  isStaticAssetPath,
  productionIndexHandler,
} from "@/api/lib/static-cache";

const IMMUTABLE = "public, max-age=31536000, immutable";
const DAY = "public, max-age=86400";

describe("cacheControlFor", () => {
  test.each([
    ["/", "no-cache"],
    ["/index.html", "no-cache"],
    ["/index-7e0bwj53.js", IMMUTABLE],
    ["/index-nc9hezq1.css", IMMUTABLE],
    ["/favicon-dark-kqzj48tr.png", IMMUTABLE],
    ["/assets/logo.png", DAY],
    ["/assets/fonts/inter.woff2", DAY],
    ["/assets/fonts/inter-variable.woff2", DAY],
    ["/assets/fonts/jetbrains-mono-variable.woff2", DAY],
    ["/settings/profile", undefined],
    ["/users/jane.doe", undefined],
    ["/api/health", undefined],
    ["/api/v1/audit/export.json", undefined],
    ["/api/v1/logo.png", undefined],
  ])("%s → %s", (path, expected) => {
    expect(cacheControlFor(path)).toBe(expected);
  });

  // NOTE: the hashed shape alone is not enough: a deep route may end in a long dashed slug.
  test("a hashed-looking segment without an asset extension is not an asset", () => {
    expect(cacheControlFor("/posts/hello-abcdefgh1234.draft")).toBeUndefined();
  });
});

describe("isStaticAssetPath", () => {
  test("names a file only by a known asset extension on the last segment", () => {
    expect(isStaticAssetPath("/index-deadbeef1234.js")).toBe(true);
    expect(isStaticAssetPath("/assets/does-not-exist.png")).toBe(true);
    expect(isStaticAssetPath("/robots.txt")).toBe(true);
    expect(isStaticAssetPath("/users/jane.doe")).toBe(false);
    expect(isStaticAssetPath("/v1.2/settings")).toBe(false);
    expect(isStaticAssetPath("/settings/profile")).toBe(false);
  });
});

describe("applyStaticCacheControl", () => {
  // Mirrors staticPlugin, which answers with its own Response and its own cache-control.
  const pluginLike = () =>
    new Response("body", { headers: { "Cache-Control": DAY } });

  const app = new Elysia()
    .onAfterHandle(applyStaticCacheControl)
    .get("/index-7e0bwj53.js", pluginLike)
    .get("/assets/logo.png", pluginLike)
    .get("/index-a1b2c3d4e5.js", () => new Response(null, { status: 304 }))
    .get("/index-abcdefgh1234.js", ({ set }) => {
      set.status = 404;
      return "Not Found";
    })
    .get("/gone-abcdefgh1234.js", () => new Response("gone", { status: 410 }))
    .get("/", () => "shell")
    .get("/api/thing", () => ({ ok: true }));

  const get = (path: string) =>
    app.handle(new Request(`http://localhost${path}`));

  test("overrides the plugin's own header so a hashed bundle becomes immutable", async () => {
    const res = await get("/index-7e0bwj53.js");
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
  });

  test("keeps a day for an unhashed file", async () => {
    const res = await get("/assets/logo.png");
    expect(res.headers.get("cache-control")).toBe(DAY);
  });

  test("stamps the document through set.headers", async () => {
    const res = await get("/");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("a 304 revalidating a file carries its policy", async () => {
    const res = await get("/index-a1b2c3d4e5.js");
    expect(res.status).toBe(304);
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
  });

  test("never gives a failed response the asset's policy", async () => {
    const viaSet = await get("/index-abcdefgh1234.js");
    expect(viaSet.status).toBe(404);
    expect(viaSet.headers.get("cache-control")).toBeNull();

    const viaResponse = await get("/gone-abcdefgh1234.js");
    expect(viaResponse.status).toBe(410);
    expect(viaResponse.headers.get("cache-control")).toBeNull();
  });

  test("leaves API responses alone", async () => {
    const res = await get("/api/thing");
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("productionIndexHandler", async () => {
  const dir = await mkdtemp(join(tmpdir(), "static-cache-"));
  const documentPath = join(dir, "index.html");
  await Bun.write(documentPath, "<!doctype html><title>shell</title>");
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const app = new Elysia()
    .onAfterHandle(applyStaticCacheControl)
    .get("/*", productionIndexHandler(documentPath));
  const get = (path: string) =>
    app.handle(new Request(`http://localhost${path}`));

  test.each([
    "/settings/profile",
    "/settings/profile/",
    "/users/jane.doe",
    "/admin?tab=users",
  ])("%s gets the shell, revalidated on every load", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    // NOTE: under happy-dom a Bun.file body reads back as "[object Blob]", so the document itself
    // is asserted by the production smoke (`bun smoke:prod`); here it is enough that it is not
    // the missing-file answer.
    expect(await res.text()).not.toBe("Not Found");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test.each([
    "/index-deadbeef1234.js",
    "/nope.js",
    "/assets/does-not-exist.png",
  ])(
    "a missing file %s is a 404 nothing may store, not the shell",
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not Found");
      expect(res.headers.get("cache-control")).toBe("no-store");
    },
  );
});

// In dev the browser's document comes from Bun's native routes, so Elysia's `/*` sees only what the
// carve-outs hand back. Run through the app's own after-handle, because that hook is what stamped a
// missing asset with a day of cache before.
describe("developmentIndexHandler", () => {
  const app = new Elysia()
    .onAfterHandle(applyStaticCacheControl)
    .get("/*", developmentIndexHandler("the document"));
  const get = (path: string) =>
    app.handle(new Request(`http://localhost${path}`));

  test.each(["/assets/does-not-exist.png", "/assets/fonts/nope.woff2"])(
    "a missing file %s is a 404 nothing may store",
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not Found");
      expect(res.headers.get("cache-control")).toBe("no-store");
    },
  );

  test("a route still gets the document", async () => {
    const res = await get("/settings/profile");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the document");
  });
});
