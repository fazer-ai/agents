import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { staticPlugin } from "@elysiajs/static";
import Elysia from "elysia";

// NOTE: Exercises the dev-mode static plugin config to catch regressions like
// @elysiajs/static#63, where 1.4.9 flipped the HTML bundling default to off and
// silently broke `bun dev` serving of `public/index.html`.

describe("dev static plugin HTML bundling", () => {
  let app: Elysia;
  let baseUrl: string;

  beforeAll(async () => {
    app = new Elysia().use(
      await staticPlugin({
        assets: "public",
        prefix: "/",
        alwaysStatic: true,
        bunFullstack: true,
      }),
    );
    app.listen(0);
    const port = app.server?.port;
    if (!port) throw new Error("server did not bind");
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    app?.stop();
  });

  test("GET / returns bundled HTML with Bun bundle refs", async () => {
    const res = await Bun.fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('id="root"');
    expect(body).toMatch(/\/_bun\/client\/[^"]+\.js/);
  });

  test("bundled client script is served with js MIME", async () => {
    const html = await (await Bun.fetch(`${baseUrl}/`)).text();
    const match = html.match(/src="(\/_bun\/client\/[^"]+\.js)"/);
    expect(match).not.toBeNull();
    const res = await Bun.fetch(`${baseUrl}${match?.[1]}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    // Skip content-length because chunked responses omit it
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test("bundled assets referenced by HTML are served", async () => {
    const html = await (await Bun.fetch(`${baseUrl}/`)).text();
    const match = html.match(/href="(\/_bun\/asset\/[^"]+)"/);
    expect(match).not.toBeNull();
    const res = await Bun.fetch(`${baseUrl}${match?.[1]}`);
    expect(res.status).toBe(200);
  });
});
