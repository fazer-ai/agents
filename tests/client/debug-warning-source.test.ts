import { describe, expect, test } from "bun:test";

// The behaviour of the console's debug window (the warning, the switch, the server's clock) is
// rendered in tests/client/debug-window-editor.test.ts. What stays here is the census, which no
// rendering can see: a NEW client-side reader of the window would be correct TypeScript and pass
// every rendered test (the test's clock is the component's clock), and only be wrong on an
// operator's machine whose clock is off.

// The census, because the question is "which reads of the window run in a BROWSER". The one that
// PERSISTS matters most: `observabilityToForm` decodes the deadline on load, so a window it reads as
// expired becomes the `null` that the next save of any Behavior field writes back. Server-side
// readers are on the server's clock by construction; a new client-side one would not be.
describe("every client-side read of the window is on the server's clock", () => {
  test("there are exactly two, and neither reads the browser's clock", async () => {
    const dir = new URL("../../src/client/", import.meta.url).pathname;
    const files = (
      await Array.fromAsync(
        new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: dir, absolute: true }),
      )
    ).sort();
    const touching: string[] = [];
    for (const f of files) {
      const text = await Bun.file(f).text();
      if (
        /readObservabilityConfig|debugModesFrom|readDebugModes|isFullDetailWindowOpen/.test(
          text,
        )
      ) {
        touching.push(f.slice(dir.length));
        // Same rule for whichever file it is: the instant has to come from `serverClock`.
        expect(text).not.toContain("Date.now()");
        expect(text).not.toContain("new Date()");
        expect(text).toContain("@/client/lib/serverClock");
      }
    }
    expect(touching).toEqual([
      "pages/agents/BehaviorTab.tsx",
      "pages/agents/observabilityFormState.ts",
    ]);
  });
});
