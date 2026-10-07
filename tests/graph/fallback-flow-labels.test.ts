import { describe, expect, test } from "bun:test";

// EVERY FALLBACK LINE NAMES THE MODEL IT IS ABOUT.
//
// Four events describe the fallback (retry, fallback, fallback-failed, unavailable), written by
// handlers in three entrypoints (webhook turn, nudge, both playground handlers). Each has the
// PRIMARY's labels in scope, so one that ignores the event's labels does not fail: it files the line
// under the working model, or under none. The labels are required on the callback types, but a
// destructure that ignores a field is invisible to tsc, so this proves the handlers READ them.
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
// every file whether or not the code is right. The positive control below guards against that.
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
// follow-up) and checking only the first would miss the second.
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
// `emitFlowEvent` alerts on every inbox `warn`/`error`, coalesced on (channel, stage, level). The
// `generate` stage emits its OWN `generate`/`error` when the turn throws, so a fallback-failed line
// at that level pages the operator twice for one outage ("×2", or two sends on a lost coalesce race).
// The stage owns the alarm; the fallback line only says WHICH model died. The two lines about a turn
// STILL RUNNING stay at `warn`: nothing else reports them and no stage line collides with them.
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

  // NOTE: POSITIVE CONTROL, in the shape of the defect this fences.
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

  // NOTE: POSITIVE CONTROL: the handler has the labels in scope and writes the line without them.
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

// The fallback's failure is a provider failure like any other, so its line names the class an alert
// keys a cause or a rate on (`detail.failure`), never only the redacted reason.
describe("the fallback-failed line carries its failure class", () => {
  for (const file of [...FILES, "src/modules/observe/job.ts"]) {
    test(`${file} writes detail.failure on every fallback-failed line`, async () => {
      const source = await Bun.file(file).text();
      const bodies = allHandlerBodies(source, "onModelFallbackFailed").filter(
        (b) => b.includes("emitFlowEvent"),
      );
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      for (const body of bodies)
        expect(body).toMatch(/detail:\s*\{[^}]*\bfailure\b/);
    });
  }
});
