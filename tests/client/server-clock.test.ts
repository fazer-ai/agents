import { afterEach, describe, expect, test } from "bun:test";
import {
  noteServerDate,
  resetServerClock,
  serverNow,
  serverNowDate,
} from "@/client/lib/serverClock";

// The console arms a deadline the SERVER enforces (`fullDetailUntil`, issue #58), so the browser's
// clock being wrong is not a display detail: it changes the length of the window that gets armed
// and it makes the warning stop, or keep going, at a different moment than the recording does.
//
// The offset is read off the `Date` header of responses the page already makes. This file covers
// what that reader does with a header it can and cannot use, because the failure mode of getting it
// wrong is silent in both directions.

const withDate = (raw: string) =>
  new Response(null, { headers: { date: raw } });

afterEach(() => resetServerClock());

describe("the offset comes off the response, and only when it is readable", () => {
  test("a server ten minutes ahead moves `serverNow` ten minutes ahead", () => {
    const ahead = new Date(Date.now() + 600_000);
    noteServerDate(withDate(ahead.toUTCString()));
    // `toUTCString` has one-second resolution, and the offset is read after the response landed.
    expect(Math.abs(serverNow() - ahead.getTime())).toBeLessThan(2_000);
  });

  test("a server behind moves it back, which is the direction that silently arms nothing", () => {
    const behind = new Date(Date.now() - 13 * 3_600_000);
    noteServerDate(withDate(behind.toUTCString()));
    expect(serverNow()).toBeLessThan(Date.now() - 12 * 3_600_000);
  });

  test("with no response yet, it is the browser's own clock", () => {
    expect(Math.abs(serverNow() - Date.now())).toBeLessThan(50);
  });

  test("a response with no date leaves the offset ALONE, rather than resetting it", () => {
    const ahead = new Date(Date.now() + 600_000);
    noteServerDate(withDate(ahead.toUTCString()));
    noteServerDate(new Response(null));
    // A missing header says nothing about the clock. Treating it as zero would make the offset
    // depend on which endpoint answered last.
    expect(Math.abs(serverNow() - ahead.getTime())).toBeLessThan(2_000);
  });

  test("an unparseable date is ignored, not read as NaN", () => {
    // `Date.parse` returns NaN, and an offset of NaN makes every comparison against `serverNow()`
    // false — the window would read as closed forever, with the switch turning on and nothing
    // anywhere explaining it.
    noteServerDate(withDate("not a date"));
    expect(Number.isNaN(serverNow())).toBe(false);
    expect(Math.abs(serverNow() - Date.now())).toBeLessThan(50);
  });

  test("`serverNowDate` is the same instant as a Date", () => {
    const ahead = new Date(Date.now() + 600_000);
    noteServerDate(withDate(ahead.toUTCString()));
    expect(serverNowDate().getTime()).toBe(serverNow());
  });
});

describe("the header this reads is one the server actually sends", () => {
  test("Bun.serve answers a parseable `Date`", async () => {
    // The whole mechanism rests on this, and it is a property of the runtime rather than of any
    // code in this repo — so it is measured rather than assumed.
    //
    // The CORS headers are a TEST artifact: happy-dom's `fetch` preflights every call and filters
    // response headers down to the safelist, which `Date` is not on. The console is served by the
    // same Bun server it calls (`treaty<App>(window.location.origin)`), so nothing there is
    // cross-origin and nothing is filtered. Same workaround as
    // tests/graph/usage-provider-counts.test.ts.
    const CORS = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*",
      "access-control-expose-headers": "*",
    };
    const BunResponse = (
      globalThis as unknown as { BunResponse: typeof Response }
    ).BunResponse;
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        req.method === "OPTIONS"
          ? new BunResponse(null, { status: 204, headers: CORS })
          : new BunResponse("ok", { headers: CORS }),
    });
    try {
      const res = await fetch(`http://localhost:${server.port}/`);
      const raw = res.headers.get("date");
      expect(raw).toBeTruthy();
      expect(Number.isNaN(Date.parse(raw ?? ""))).toBe(false);
      // And it is the instant the response was written, not some fixed string.
      expect(Math.abs(Date.parse(raw ?? "") - Date.now())).toBeLessThan(60_000);
    } finally {
      server.stop(true);
    }
  });
});
