import { describe, expect, test } from "bun:test";
import {
  findNonAbsoluteUrls,
  rewriteAssetUrlsForCdn,
} from "@/../scripts/lib/cdn-assets";

describe("rewriteAssetUrlsForCdn", () => {
  test("points root-relative /assets/ references at the CDN", () => {
    const { html, rewritten } = rewriteAssetUrlsForCdn(
      `<style>src: url("/assets/fonts/a.woff2"); src: url('/assets/fonts/b.woff2');</style>`,
      "https://cdn.example.com",
    );
    expect(rewritten).toBe(2);
    expect(html).toContain(
      `url("https://cdn.example.com/assets/fonts/a.woff2")`,
    );
    expect(html).toContain(
      `url('https://cdn.example.com/assets/fonts/b.woff2')`,
    );
  });

  test("normalizes a trailing slash on the CDN origin", () => {
    const { html } = rewriteAssetUrlsForCdn(
      `url("/assets/x.woff2")`,
      "https://cdn.example.com/",
    );
    expect(html).toBe(`url("https://cdn.example.com/assets/x.woff2")`);
  });

  test("is a no-op without a CDN, so a plain deploy keeps serving from itself", () => {
    const input = `url("/assets/x.woff2")`;
    expect(rewriteAssetUrlsForCdn(input, "")).toEqual({
      html: input,
      rewritten: 0,
    });
  });

  test("leaves URLs it does not own alone", () => {
    // An absolute URL is already routed; a data: URI has no origin; a path
    // outside /assets/ is not something the release workflow uploads.
    const input = `url("https://other.example/f.woff2") url("data:font/woff2;base64,AA") url("/static/f.woff2")`;
    const { html, rewritten } = rewriteAssetUrlsForCdn(
      input,
      "https://cdn.example.com",
    );
    expect(rewritten).toBe(0);
    expect(html).toBe(input);
  });
});

describe("findNonAbsoluteUrls", () => {
  test("reports what the rewrite did not reach", () => {
    expect(
      findNonAbsoluteUrls(
        `url("https://cdn.example.com/assets/a.woff2") url("/static/b.woff2") url(c.woff2)`,
      ),
    ).toEqual(["/static/b.woff2", "c.woff2"]);
  });
});

// The two above prove the helpers behave; this one keeps them pointed at the real document. A url()
// in index.html in a shape the rewrite does not match would be served from the application origin
// by a CDN build.
describe("public/index.html against the rewrite", () => {
  test("every url() it declares is reachable by the CDN rewrite", async () => {
    const html = await Bun.file("public/index.html").text();
    const before = findNonAbsoluteUrls(html);
    expect(before.length).toBeGreaterThan(0);

    const { html: after } = rewriteAssetUrlsForCdn(
      html,
      "https://cdn.example.com",
    );
    expect(findNonAbsoluteUrls(after)).toEqual([]);
  });
});
