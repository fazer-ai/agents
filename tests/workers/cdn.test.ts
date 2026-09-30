import { describe, expect, test } from "bun:test";

import { cacheControlFor } from "@/api/lib/static-cache";

// Loaded through a path the type-checker does not follow. The worker is type-checked
// against @cloudflare/workers-types by its own tsconfig (the root one excludes workers/), and a
// static import would pull R2Bucket and ExportedHandler into the app's program, where they do not
// exist. What runs is the worker's real `fetch`, so a rule that drifts in the worker fails here.
const WORKER_PATH = "../../workers/cdn/src/index.ts";
const worker = (await import(WORKER_PATH)).default as {
  fetch(request: Request, env: unknown): Promise<Response>;
};

const IMMUTABLE = "public, max-age=31536000, immutable";
const DAY = "public, max-age=86400";

// Every key exists; the bucket answers like R2 for an object that is there.
const env = {
  ASSETS: {
    get: async (key: string) => ({ key, body: "x", size: 1, httpEtag: '"e"' }),
  },
  ALLOWED_ORIGINS: "",
};

async function cacheControlOf(key: string, init?: RequestInit) {
  const res = await worker.fetch(
    new Request(`https://cdn.example/${key}`, init),
    env,
  );
  return { status: res.status, cacheControl: res.headers.get("cache-control") };
}

// The keys are dist/-relative, which is how docs/cdn-r2-setup.md uploads them: bundler
// outputs at the root, public/assets/ copied verbatim under assets/.
const KEYS = [
  "index-7e0bwj53.js",
  "index-nc9hezq1.css",
  "favicon-dark-kqzj48tr.png",
  "assets/fonts/inter-variable.woff2",
  "assets/fonts/jetbrains-mono-variable.woff2",
  "assets/logo.png",
  "assets/logo-mark-light.png",
];

describe("CDN worker cache policy", () => {
  test.each([
    ["index-7e0bwj53.js", IMMUTABLE],
    ["favicon-dark-kqzj48tr.png", IMMUTABLE],
    ["assets/fonts/inter-variable.woff2", DAY],
    ["assets/fonts/jetbrains-mono-variable.woff2", DAY],
    ["assets/logo.png", DAY],
  ])("%s → %s", async (key, expected) => {
    expect((await cacheControlOf(key)).cacheControl).toBe(expected);
  });

  test("a revalidation and a HEAD of a verbatim file carry the same policy", async () => {
    const key = "assets/fonts/inter-variable.woff2";
    const revalidated = await cacheControlOf(key, {
      headers: { "If-None-Match": '"e"' },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.cacheControl).toBe(DAY);
    expect((await cacheControlOf(key, { method: "HEAD" })).cacheControl).toBe(
      DAY,
    );
  });

  // NOTE: the worker and the app answer the same question for the same files, and nothing else
  // keeps two copies of the rule in step.
  test.each(KEYS)("%s gets the same policy as from the app", async (key) => {
    expect((await cacheControlOf(key)).cacheControl).toBe(
      cacheControlFor(`/${key}`) ?? null,
    );
  });
});
