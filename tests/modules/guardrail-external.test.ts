import { describe, expect, spyOn, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { SsrfError } from "@/lib/ssrf";
import * as flowlog from "@/modules/flowlog/service";
import {
  askExternal,
  buildExternalCheck,
  candidateIdFor,
  EXTERNAL_REASON_MAX,
  EXTERNAL_REPLACE_MAX,
  EXTERNAL_TOOL_VALUE_MAX,
  readExternalAnswer,
  turnToolCalls,
} from "@/modules/guardrails/external";
import type { GuardrailReport } from "@/modules/guardrails/gate";
import {
  GUARDRAILS_DEFAULTS,
  type GuardrailsConfig,
  readGuardrailsConfig,
} from "@/modules/guardrails/settings";

// The external check (docs/guardrails-external.md): what it sends, how it reads the answer, and what it decides.

const CID = "cid-1";

describe("reading the endpoint's answer", () => {
  // The bug it catches: an answer that is not a decision obeyed as one, or a block inside an error
  // status treated as a block.
  test("only a 2xx JSON decision that echoes the candidate is one", () => {
    const ok = (v: unknown, status = 200) =>
      readExternalAnswer(status, JSON.stringify(v), CID);
    expect(ok({ decision: "allow", candidateId: CID })).toEqual({
      ok: true,
      decision: "allow",
      status: 200,
    });
    expect(ok({ decision: "block", candidateId: CID, reason: "R" })).toEqual({
      ok: true,
      decision: "block",
      status: 200,
      reason: "R",
    });
    expect(
      ok({ decision: "replace", candidateId: CID, text: "  novo  " }),
    ).toMatchObject({ ok: true, decision: "replace", text: "novo" });
    expect(ok({ decision: "block", candidateId: CID }, 500)).toEqual({
      ok: false,
      cause: "http_status",
      status: 500,
    });
    expect(readExternalAnswer(200, "isto não é json", CID)).toMatchObject({
      ok: false,
      cause: "malformed",
    });
    expect(ok({ decision: "approve", candidateId: CID })).toMatchObject({
      ok: false,
      cause: "malformed",
    });
    expect(ok({ decision: "allow", candidateId: "outro" })).toMatchObject({
      ok: false,
      cause: "unverifiable",
    });
    expect(ok({ decision: "allow" })).toMatchObject({
      ok: false,
      cause: "unverifiable",
    });
  });

  // The bug it catches: a replace with nothing to send delivering silence, or one past the cap
  // reaching a customer.
  test("a replace needs text within the cap, and a reason is clipped", () => {
    const r = (v: unknown) => readExternalAnswer(200, JSON.stringify(v), CID);
    expect(
      r({ decision: "replace", candidateId: CID, text: " " }),
    ).toMatchObject({ ok: false, cause: "malformed" });
    expect(
      r({
        decision: "replace",
        candidateId: CID,
        text: "x".repeat(EXTERNAL_REPLACE_MAX + 1),
      }),
    ).toMatchObject({ ok: false, cause: "malformed" });
    const long = r({
      decision: "block",
      candidateId: CID,
      reason: "y".repeat(EXTERNAL_REASON_MAX * 2),
    });
    expect(
      long.ok &&
        (long.reason?.length ?? 0) <=
          EXTERNAL_REASON_MAX + "…[truncated]".length,
    ).toBe(true);
  });

  // The bug it catches: a secret straddling the cap cut to a prefix no redaction pattern matches,
  // then stored in the trace and shown in the note.
  test("a reason is redacted before it is cut", () => {
    const token = `sk-${"a".repeat(48)}`;
    const answer = readExternalAnswer(
      200,
      JSON.stringify({
        decision: "block",
        candidateId: CID,
        reason: `${"x".repeat(EXTERNAL_REASON_MAX - 10)} ${token}`,
      }),
      CID,
    );
    expect(answer.ok && answer.reason?.includes("sk-aaaa")).toBe(false);
  });

  // The bug it catches: the same text in two turns answered by one cached decision.
  test("the candidate id is bound to the text and to the turn", () => {
    expect(candidateIdFor("t1", "a")).not.toBe(candidateIdFor("t1", "b"));
    expect(candidateIdFor("t1", "a")).not.toBe(candidateIdFor("t2", "a"));
    expect(candidateIdFor("t1", "a")).toBe(candidateIdFor("t1", "a"));
  });
});

describe("the turn's tool calls", () => {
  const messages = () => [
    new HumanMessage("antes"),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "old", name: "velha", args: {} }],
    }),
    new ToolMessage({ tool_call_id: "old", content: "VELHO" }),
    new HumanMessage("MSG"),
    new AIMessage({
      content: "",
      tool_calls: [
        { id: "a", name: "ferramenta_um", args: { q: "ARG-UM" } },
        { id: "b", name: "ferramenta_dois", args: { q: "ARG-DOIS" } },
      ],
    }),
    new ToolMessage({ tool_call_id: "a", content: "RESULTADO-UM" }),
    new ToolMessage({
      tool_call_id: "b",
      content: `RESULTADO-DOIS${"z".repeat(200_000)}`,
    }),
    new AIMessage("FINAL"),
  ];

  // The bug it catches: an earlier turn's calls sent as this one's, calls out of order, or a huge
  // result sent whole.
  test("this turn's calls, in order, paired with their results and capped", () => {
    const calls = turnToolCalls(messages(), true);
    expect(calls.map((c) => c.name)).toEqual([
      "ferramenta_um",
      "ferramenta_dois",
    ]);
    expect(calls[0]).toMatchObject({
      args: { q: "ARG-UM" },
      result: "RESULTADO-UM",
      isError: false,
    });
    expect(calls[1]?.result?.startsWith("RESULTADO-DOIS")).toBe(true);
    expect(
      (calls[1]?.result?.length ?? 0) <= EXTERNAL_TOOL_VALUE_MAX + 50,
    ).toBe(true);
    expect(calls[1]?.resultSize).toBe(200_000 + "RESULTADO-DOIS".length);
  });

  // The bug it catches: arguments held to the cap per string only, so many fields add up past it.
  test("the arguments are bounded as a whole", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 20; i++) wide[`f${i}`] = "a".repeat(5000);
    const calls = turnToolCalls(
      [
        new HumanMessage("MSG"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "w", name: "larga", args: wide }],
        }),
        new ToolMessage({ tool_call_id: "w", content: "ok" }),
        new AIMessage("FIM"),
      ],
      true,
    );
    expect(
      JSON.stringify(calls[0]?.args).length <= EXTERNAL_TOOL_VALUE_MAX + 50,
    ).toBe(true);
    expect(calls[0]?.argsSize).toBe(JSON.stringify(wide).length);
  });

  // The bug it catches: "send tool values" off still leaking an argument or a result.
  test("with values off, names and sizes go and nothing else", () => {
    const calls = turnToolCalls(messages(), false);
    const raw = JSON.stringify(calls);
    for (const v of ["ARG-UM", "ARG-DOIS", "RESULTADO-UM", "RESULTADO-DOIS"])
      expect(raw).not.toContain(v);
    expect(calls[0]).toEqual({
      name: "ferramenta_um",
      argsSize: JSON.stringify({ q: "ARG-UM" }).length,
      resultSize: "RESULTADO-UM".length,
      isError: false,
    });
  });
});

describe("asking the endpoint", () => {
  const body = { candidateId: CID };
  const safe = async (u: string) => new URL(u);

  // The bug it catches: a slow endpoint holding the reply past the budget.
  test("an answer later than the budget is a timeout", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(
      await askExternal("https://x.example/h", null, body, {
        fetchImpl: hang,
        assertSafe: safe,
        timeoutMs: 50,
      }),
    ).toEqual({ ok: false, cause: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // The bug it catches: a private address dialed because the check skipped the outbound guard.
  test("a URL the outbound guard refuses is never dialed", async () => {
    let dialed = false;
    const answer = await askExternal("https://intranet/h", null, body, {
      fetchImpl: (async () => {
        dialed = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
      assertSafe: async () => {
        throw new SsrfError("blocked");
      },
    });
    expect(answer).toEqual({ ok: false, cause: "unsafe_url" });
    expect(dialed).toBe(false);
  });

  // The bug it catches: an unsigned request going out when a secret was configured, or a signed
  // one when none was.
  test("signs only with a secret", async () => {
    const seen: Headers[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return new Response(
        JSON.stringify({ decision: "allow", candidateId: CID }),
      );
    }) as unknown as typeof fetch;
    await askExternal("https://x.example/h", "s", body, {
      fetchImpl,
      assertSafe: safe,
    });
    await askExternal("https://x.example/h", null, body, {
      fetchImpl,
      assertSafe: safe,
    });
    expect(seen[0]?.get("x-fazerai-signature")).toMatch(/^sha256=/);
    expect(seen[1]?.get("x-fazerai-signature")).toBeNull();
  });
});

describe("what the check decides", () => {
  const cfg = (over: Partial<GuardrailsConfig> = {}): GuardrailsConfig => ({
    ...structuredClone(GUARDRAILS_DEFAULTS),
    enabled: true,
    external: {
      url: "https://x.example/h",
      credentialRef: "vault:1",
      sendToolValues: true,
    },
    ...over,
  });
  const run = async (
    c: GuardrailsConfig,
    secret: string | null,
    answer?: (b: Record<string, unknown>) => unknown,
    extra: { secretMissing?: boolean; logValues?: boolean } = {},
  ) => {
    const reports: GuardrailReport[] = [];
    const check = buildExternalCheck({
      cfg: c,
      ctx: {
        tenantId: 1n,
        agentId: 2n,
        conversationId: 3n,
        chatwootConversationId: 4,
        turnId: "turn",
        customerMessage: "oi",
      },
      secret,
      ...extra,
      // No database here: the lines are the runtime tests' business.
      flow: {
        tenantId: 0n,
        turnId: "turn",
        source: "inbox",
        base: null,
      } as never,
      announce: (r) => {
        reports.push(r);
      },
      deps: {
        assertSafe: async (u) => new URL(u),
        fetchImpl: (async (_u: string, init: RequestInit) => {
          const b = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify(answer?.(b) ?? {}));
        }) as unknown as typeof fetch,
      },
    });
    if (!check) return { d: null, reports };
    const d = await check({
      text: "RESPOSTA",
      attachments: [],
      model: "primary",
      toolCalls: [],
    });
    return { d, reports };
  };

  // The bug it catches: an agent with guardrails off, or no endpoint, still calling out.
  test("nothing to ask with guardrails off or no URL", () => {
    expect(
      buildExternalCheck({
        cfg: cfg({ enabled: false }),
        ctx: {} as never,
        secret: null,
        flow: {} as never,
      }),
    ).toBeNull();
    expect(
      buildExternalCheck({
        cfg: readGuardrailsConfig({ guardrails: { enabled: true } }),
        ctx: {} as never,
        secret: null,
        flow: {} as never,
      }),
    ).toBeNull();
  });

  // The bug it catches: a deleted signing secret sending the request unsigned, which a verifying
  // endpoint refuses, instead of following onFailure.
  test("a signing secret that did not resolve follows onFailure", async () => {
    const pass = await run(cfg(), null, undefined, { secretMissing: true });
    expect(pass.d).toEqual({ kind: "unavailable", modelRan: true });
    expect(pass.reports[0]?.external).toMatchObject({
      decision: "failed",
      cause: "secret_not_found",
    });
    const hold = await run(cfg({ onFailure: "hold" }), null, undefined, {
      secretMissing: true,
    });
    expect(hold.d).toEqual({
      kind: "handed-off",
      reply: GUARDRAILS_DEFAULTS.output.handoffMessage,
    });
    expect(hold.reports[0]).toMatchObject({
      held: true,
      outcome: "handed-off",
    });
  });

  // The bug it catches: a signing secret whose value happens to be a sentinel read as unresolved.
  test("any resolved secret is used, whatever its value", async () => {
    const { d } = await run(cfg(), "missing", (b) => ({
      decision: "allow",
      candidateId: b.candidateId,
    }));
    expect(d).toEqual({ kind: "clean" });
  });

  // The bug it catches: the endpoint's free text, which may quote the customer, stored in a flow
  // line that promises no PII unless the operator turned tool values on.
  test("the reason reaches the flow line only with tool values on", async () => {
    const emit = spyOn(flowlog, "emitFlowEvent").mockImplementation(() => {});
    try {
      const block = (b: Record<string, unknown>) => ({
        decision: "block",
        candidateId: b.candidateId,
        reason: "Maria, 11 99999-0000",
      });
      await run(cfg(), null, block);
      await run(cfg(), null, block, { logValues: true });
      const details = emit.mock.calls.map(
        (c) => (c[1] as { detail: Record<string, unknown> }).detail,
      );
      expect(JSON.stringify(details[0])).not.toContain("Maria");
      expect(details[0]?.reasonChars).toBe("Maria, 11 99999-0000".length);
      expect(details[1]?.endpointReason).toBe("Maria, 11 99999-0000");
    } finally {
      emit.mockRestore();
    }
  });

  // The bug it catches: generated with no judge-written text sending nothing, or the configured
  // word reported instead of what went out.
  test("a block under generated sends the template and reports template", async () => {
    const out = { ...GUARDRAILS_DEFAULTS.output, action: "generated" as const };
    const { d, reports } = await run(cfg({ output: out }), null, (b) => ({
      decision: "block",
      candidateId: b.candidateId,
    }));
    expect(d).toEqual({ kind: "replaced", reply: out.templateMessage });
    expect(reports[0]).toMatchObject({
      action: "template",
      outcome: "replaced",
    });
  });
});

describe("reading the configuration", () => {
  // The bug it catches: a stored http URL dialed as if the write boundary had accepted it.
  test("only an https URL is kept, and tool values default on", () => {
    const read = (external: unknown) =>
      readGuardrailsConfig({ guardrails: { enabled: true, external } })
        .external;
    expect(read({ url: "https://x.example/h" })).toEqual({
      url: "https://x.example/h",
      credentialRef: null,
      sendToolValues: true,
    });
    expect(read({ url: "http://x.example/h" }).url).toBeNull();
    expect(read({ url: "https://a:b@x.example/h" }).url).toBeNull();
    expect(read({ sendToolValues: false }).sendToolValues).toBe(false);
  });
});
