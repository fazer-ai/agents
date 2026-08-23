import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  decodeMultipartFlag,
  playgroundFollowupBodySchema,
  playgroundTurnBodySchema,
} from "@/api/v1/agents.controller";

// The guardrail toggle is a boolean the handler reads off the body, and Elysia strips any field the
// schema does not declare — silently, before the handler runs. So a turn sent with screening off
// would screen anyway, and every service-level test would still pass, because they all call the
// service directly (issue #170's shape).
//
// The REAL schemas are imported, never copied: a mirrored schema validates its own fields and can
// never see one missing from the endpoint's.

const app = new Elysia()
  .post(
    "/turn",
    ({ body }) => ({
      seen: (body as Record<string, unknown>).guardrails ?? null,
    }),
    {
      body: playgroundTurnBodySchema,
    },
  )
  .post(
    "/followup",
    ({ body }) => ({
      seen: (body as Record<string, unknown>).guardrails ?? null,
    }),
    { body: playgroundFollowupBodySchema },
  );

const post = (path: string, body: unknown) =>
  app
    .handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
    .then((r) => r.json() as Promise<{ seen: unknown }>);

describe("playground guardrail toggle survives the HTTP boundary", () => {
  test("the turn body carries guardrails:false to the handler", async () => {
    expect(await post("/turn", { message: "oi", guardrails: false })).toEqual({
      seen: false,
    });
  });

  // The direction that is easy to forget, because omitting it reads as the default either way.
  test("the follow-up body carries it too", async () => {
    expect(await post("/followup", { guardrails: false })).toEqual({
      seen: false,
    });
  });

  // Absent must stay absent rather than arriving as `false`: the service reads `!== false`, so a
  // normalizer that filled in a default would flip every turn's screening off.
  test("omitting it leaves it undefined, not false", async () => {
    expect(await post("/turn", { message: "oi" })).toEqual({ seen: null });
  });

  // The audio and file turns carry the flag as a multipart STRING, and the same rule has to hold
  // there: absent means "whatever the service decides", not "on". Coerced to a boolean at the
  // handler, the default would exist twice, and the copy on these two endpoints is the one a change
  // to the real one would never reach.
  test("the multipart flag keeps absent absent", () => {
    expect(decodeMultipartFlag(undefined)).toBeUndefined();
    expect(decodeMultipartFlag("false")).toBe(false);
    expect(decodeMultipartFlag("true")).toBe(true);
    // Anything else present is a decision to screen, which is the safe reading of a garbled field.
    expect(decodeMultipartFlag("")).toBe(true);
    expect(decodeMultipartFlag("no")).toBe(true);
  });
});
