import { describe, expect, spyOn, test } from "bun:test";
import { t } from "elysia";
import logger from "@/api/lib/logger";
import { errors } from "@/api/lib/openapi";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// A refusal from the SCHEMA layer, as the client receives it and as the server records it.
//
// It goes through the REAL app because the branch under test is the `onError` in src/app.ts, and
// because the two things it has to stop doing are both invisible from a unit: the answer echoed the
// submitted body back (`found`), and the log line was the error itself, so the same echo reached
// stdout. `POST /api/v1/vault` is the call site that makes it concrete rather than theoretical: its
// body carries a write-only secret next to a `name` with `minLength: 1`, and schema validation runs
// BEFORE the role guard, so an unauthenticated request reaches this branch. Issue #255.
setupPrismaMock();
const app = (await import("@/app")).default;

const SUBMITTED_SECRET = "sk-live-DO-NOT-ECHO-ME";

app.post("/__schema/nested", () => ({ ok: true }), {
  body: t.Object({
    settings: t.Object({
      guardrails: t.Object({ templateMessage: t.String({ minLength: 3 }) }),
    }),
  }),
  response: errors(400, 422),
});
app.get("/__schema/query", () => ({ ok: true }), {
  query: t.Object({ limit: t.Numeric() }),
});
app.get("/__schema/response", () => ({ wrong: "shape" }) as never, {
  response: { 200: t.Object({ expected: t.String() }) },
});
// NOTE: see the note in refusal-wire.test.ts. Elysia freezes the route table on the first request
// the singleton serves, so a route registered by the second such file to load is silently dropped.
app.compile();

const send = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; raw: string; body: Record<string, unknown> }> => {
  const res = await app.handle(new Request(`http://localhost${path}`, init));
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, raw, body };
};

const postJson = (body: unknown, lang = "en"): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", "accept-language": lang },
  body: JSON.stringify(body),
});

const vaultWithBlankName = (lang = "en") =>
  send(
    "/api/v1/vault",
    postJson({ name: "", value: { api_key: SUBMITTED_SECRET } }, lang),
  );

// The second real call site, and the one that says WHY the field is not simply the pointer. The
// playground body declares `draft.promptVars` as `t.Record(t.String(), t.String({ maxLength: 500 }))`
// (agents.controller.ts:120), mounted directly rather than inside a union, so TypeBox descends into
// it and reports the CALLER's key as the last segment. Naming that segment would put a string the
// caller chose into the response and, worse, into the log line this file exists to keep clean.
const playgroundWithSecretVarName = () =>
  send(
    "/api/v1/agents/1/playground",
    postJson({
      message: "hello",
      draft: { promptVars: { [SUBMITTED_SECRET]: "x".repeat(501) } },
    }),
  );

describe("a schema refusal over the wire", () => {
  test("answers the canonical refusal body, naming the value that failed", async () => {
    const { status, body } = await vaultWithBlankName();
    expect(status).toBe(422);
    expect(body.error).toBeString();
    expect(body.field).toBe("name");
  });

  test("does not echo the submitted body back to the client", async () => {
    const { raw, body } = await vaultWithBlankName();
    expect(raw).not.toContain(SUBMITTED_SECRET);
    expect(Object.keys(body).sort()).toEqual(["error", "field"]);
  });

  test("does not write the submitted body to the log", async () => {
    const warn = spyOn(logger, "warn");
    const error = spyOn(logger, "error");
    try {
      await vaultWithBlankName();
      const lines = [...warn.mock.calls, ...error.mock.calls]
        .map((args) => args.map(String).join(" "))
        .join("\n");
      expect(lines).not.toContain(SUBMITTED_SECRET);
      // A client sending a body the schema refuses is expected control flow, not a server fault:
      // it is recorded at the level the AppError branch already uses for the same thing.
      expect(warn).toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("a record key written by the caller is never the name of the field", async () => {
    const { status, raw, body } = await playgroundWithSecretVarName();
    expect(status).toBe(422);
    // The record's own property, which is the input on the screen; not the key inside it.
    expect(body.field).toBe("draft.promptVars");
    expect(raw).not.toContain(SUBMITTED_SECRET);
  });

  test("a record key written by the caller never reaches the log either", async () => {
    const warn = spyOn(logger, "warn");
    const error = spyOn(logger, "error");
    try {
      await playgroundWithSecretVarName();
      const lines = [...warn.mock.calls, ...error.mock.calls]
        .map((args) => args.map(String).join(" "))
        .join("\n");
      expect(lines).not.toContain(SUBMITTED_SECRET);
      // The rule still gets recorded: it is the half that says what to do about the refusal.
      expect(lines).toContain("draft.promptVars");
      expect(lines).toContain("500");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("the sentence follows Accept-Language and the field does not", async () => {
    const en = await vaultWithBlankName("en");
    const pt = await vaultWithBlankName("pt-BR");
    expect(pt.body.error).not.toBe(en.body.error);
    expect(en.body.field).toBe("name");
    expect(pt.body.field).toBe("name");
  });

  test("a nested value is named by the dotted path the rest of the app uses", async () => {
    const { status, body } = await send(
      "/__schema/nested",
      postJson({ settings: { guardrails: { templateMessage: "ab" } } }),
    );
    expect(status).toBe(422);
    expect(body.field).toBe("settings.guardrails.templateMessage");
  });

  test("a refused query parameter is named too", async () => {
    const { status, body } = await send("/__schema/query?limit=abc");
    expect(status).toBe(422);
    expect(body.field).toBe("limit");
  });

  test("a response that fails its OWN schema is the server's fault, not the client's", async () => {
    const error = spyOn(logger, "error");
    try {
      const { status, body } = await send("/__schema/response");
      expect(status).toBe(500);
      expect(body.error).toBeString();
      expect(body.field).toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  // Elysia sets 422 on the context BEFORE it throws, so a branch that answers a different status
  // with a raw Response leaves the access log reporting the status it did not send. Measured on a
  // listening app: a server fault answered 500 and was logged as 422 with the sync line removed.
  test("the access log reports the status that was actually sent", async () => {
    const info = spyOn(logger, "info");
    try {
      await send("/__schema/response");
      // NOTE: onAfterResponse resolves a tick after handle() returns.
      await Bun.sleep(10);
      const logged = info.mock.calls.at(-1);
      expect(logged?.at(-1)).toBe(500);
    } finally {
      info.mockRestore();
    }
  });
});
