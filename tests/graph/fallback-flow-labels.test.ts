import { describe, expect, test } from "bun:test";

// EVERY FALLBACK LINE NAMES THE MODEL IT IS ABOUT.
//
// Four events describe the fallback (`onModelFallback`, `onModelFallbackFailed`,
// `onModelFallbackUnavailable`, and the retry, which names whichever of the two made it), and the
// handlers that write them live in three entrypoints — the webhook turn, the nudge and the two
// playground handlers. Each of those handlers has the PRIMARY's labels in scope, so a handler that
// forgets to read the ones the event carries does not fail: it publishes the line under the name of
// the model that is working, and a filter by model shows it in the wrong place. The playground's
// omitted both and showed it under nothing.
//
// This has been found by review three times, on three different events, which is what makes it a
// rule rather than three mistakes: the labels are required ON the callback types now, and this is
// what proves the handlers actually READ them — a destructure that ignores a field is invisible to
// tsc, so the type alone cannot close it.
const FILES = [
  "src/graph/runtime.ts",
  "src/graph/nudge.ts",
  "src/modules/playground/service.ts",
] as const;

const HANDLERS = [
  "onModelRetry",
  "onModelFallback",
  "onModelFallbackFailed",
  "onModelFallbackUnavailable",
] as const;

// The handler body: its PARAMETERS and the expression they feed. Both halves matter and they are
// separated by the arrow, so a walker that stops at the first balanced group reads `({ reason })`
// and nothing else — it then finds no `emitFlowEvent`, skips the handler, and the fence passes for
// every file whether or not the code is right. That is how this scan was written the first time,
// and the positive control below is what caught it.
export function handlerBody(source: string, name: string, from = 0): string {
  const at = source.indexOf(`${name}: (`, from);
  if (at < 0) return "";
  const arrow = source.indexOf("=>", at);
  if (arrow < 0) return "";
  let depth = 0;
  let seen = false;
  for (let i = arrow; i < source.length; i++) {
    const c = source[i];
    if (c === "(" || c === "{") {
      depth += 1;
      seen = true;
    } else if (c === ")" || c === "}") {
      depth -= 1;
      if (seen && depth <= 0) return source.slice(at, i + 1);
    }
  }
  return "";
}

// Every occurrence, because one file holds the same handler twice (the playground's turn and its
// follow-up) and checking only the first is how the second stayed wrong for a round.
export function allHandlerBodies(source: string, name: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const body = handlerBody(source, name, from);
    if (!body) return out;
    out.push(body);
    from = source.indexOf(body, from) + body.length;
  }
}

export function unlabelled(source: string): string[] {
  const bad: string[] = [];
  for (const name of HANDLERS) {
    for (const [i, body] of allHandlerBodies(source, name).entries()) {
      if (!body.includes("emitFlowEvent")) continue;
      const labelled = /\bprovider\b/.test(body) && /\bmodel\b/.test(body);
      if (!labelled) bad.push(`${name}#${i}`);
    }
  }
  return bad;
}

// AND NONE OF THEM RAISES A SECOND ALARM FOR ONE FAILURE.
//
// `emitFlowEvent` dispatches an alert for every `warn` or `error` on inbox traffic, and the worker
// coalesces on (channel, stage, level). The `generate` stage these callbacks sit inside emits its
// OWN `generate`/`error` when the turn throws, so a fallback-failed line at that same level bumps
// one delivery to "×2" — or, losing the race on the coalesce window, sends two — and the operator is
// paged twice for one outage. The stage owns the alarm; the fallback line exists to say WHICH model
// died, because the stage is labelled with the primary by construction.
//
// The two lines that describe a turn STILL RUNNING are a different case and stay at `warn`: nothing
// else reports them, and `generate`/`warn` collides with no line the stage writes.
export function levelOf(body: string): string | null {
  return body.match(/level:\s*"(\w+)"/)?.[1] ?? null;
}

describe("one failure raises one alarm", () => {
  const ALERTING = new Set(["warn", "error"]);

  for (const file of FILES) {
    test(`${file} does not alert twice for the fallback's own failure`, async () => {
      const source = await Bun.file(file).text();
      const bodies = allHandlerBodies(source, "onModelFallbackFailed").filter(
        (b) => b.includes("emitFlowEvent"),
      );
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      for (const body of bodies) {
        expect(ALERTING.has(levelOf(body) ?? "")).toBe(false);
        // ...and it is still recorded as the failure it is.
        expect(body).toContain('status: "error"');
      }
    });
  }

  // The other two lines report a turn nothing else will report, so they keep the level that reaches
  // an operator. Asserted, not assumed: "do not alert twice" applied blindly would silence them.
  test("the took-the-turn and unavailable lines still reach an operator", async () => {
    const source = await Bun.file("src/graph/runtime.ts").text();
    for (const name of ["onModelFallback", "onModelFallbackUnavailable"]) {
      const [body] = allHandlerBodies(source, name);
      expect(levelOf(body ?? "")).toBe("warn");
    }
  });

  // POSITIVE CONTROL, in the shape the defect took.
  test("a fallback-failed line at error level is caught", () => {
    const broken = `
      onModelFallbackFailed: ({ provider, model, reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "error",
          status: "error",
          provider,
          model,
          detail: { fallbackFailed: reason },
        }),
    `;
    const [body] = allHandlerBodies(broken, "onModelFallbackFailed");
    expect(levelOf(body ?? "")).toBe("error");
  });
});

describe("the fallback's flow lines carry their own model", () => {
  for (const file of FILES) {
    test(`${file} labels every fallback line it writes`, async () => {
      const source = await Bun.file(file).text();
      expect(unlabelled(source)).toEqual([]);
    });
  }

  // The scan has to FIND the handlers, or an empty answer above is the scan failing rather than the
  // code passing — the failure mode of every fence that reads source.
  test("the scan sees all four events, and both playground handlers", async () => {
    const play = await Bun.file("src/modules/playground/service.ts").text();
    expect(allHandlerBodies(play, "onModelFallbackUnavailable").length).toBe(2);
    const runtime = await Bun.file("src/graph/runtime.ts").text();
    for (const name of HANDLERS) {
      expect(allHandlerBodies(runtime, name).length).toBeGreaterThanOrEqual(1);
    }
  });

  // POSITIVE CONTROL, in the exact shape the defect took: the handler has the labels in scope and
  // writes the line without them.
  test("a handler that drops the labels is caught", () => {
    const broken = `
      onModelFallbackUnavailable: ({ reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          detail: { fallbackUnavailable: reason },
        }),
    `;
    expect(unlabelled(broken)).toEqual(["onModelFallbackUnavailable#0"]);
  });

  test("and the same handler reading them is clean", () => {
    const fixed = `
      onModelFallbackUnavailable: ({ provider, model, reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          provider,
          model,
          detail: { fallbackUnavailable: reason },
        }),
    `;
    expect(unlabelled(fixed)).toEqual([]);
  });
});
