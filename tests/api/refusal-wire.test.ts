import { describe, expect, test } from "bun:test";
import { errors } from "@/api/lib/openapi";
import { AppError } from "@/lib/errors";
import { SettingsTextTooLongError } from "@/modules/agents/service";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The refusal as the CLIENT receives it, through the app the process actually serves.
//
// It goes through the REAL app rather than a rebuilt one because the branch under test is the
// `onError` registered in src/app.ts, and an app built here would pin this file's own ordering
// instead of the app's. The declared-response route is the second half: Elysia's `normalize` strips
// what a schema does not declare, and an error body is only exempt because the handler answers with
// a raw `Response`. That exemption is asserted, not assumed. Issue #231.
setupPrismaMock();
const app = (await import("@/app")).default;

app.get("/__refusal/named", () => {
  throw new SettingsTextTooLongError(
    "guardrails.output.templateMessage",
    5000,
    2000,
  );
});
app.get(
  "/__refusal/declared",
  () => {
    throw new SettingsTextTooLongError("kanban.instructions", 5000, 2000);
  },
  { response: errors(400) },
);
app.get("/__refusal/unnamed", () => {
  throw new AppError("Forbidden", 403);
});

const refusal = async (
  path: string,
  lang: string,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      headers: { "accept-language": lang },
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

describe("a refusal over the wire", () => {
  test("carries the field the server refused, next to the sentence it localized", async () => {
    const { status, body } = await refusal("/__refusal/named", "en");
    expect(status).toBe(400);
    expect(body.field).toBe("guardrails.output.templateMessage");
    expect(body.error).toBe(
      "The text in guardrails.output.templateMessage is too long: 5000 characters (limit 2000).",
    );
  });

  test("the sentence follows Accept-Language and the field does not", async () => {
    const en = await refusal("/__refusal/named", "en");
    const pt = await refusal("/__refusal/named", "pt-BR");
    expect(pt.body.error).not.toBe(en.body.error);
    expect(pt.body.error).toContain("longo demais");
    // Named, not merely equal: two absent fields are also equal, and that is the state this test
    // exists to fail on.
    expect(en.body.field).toBe("guardrails.output.templateMessage");
    expect(pt.body.field).toBe("guardrails.output.templateMessage");
  });

  test("survives a route that DECLARES its error responses (normalize does not strip it)", async () => {
    const { status, body } = await refusal("/__refusal/declared", "en");
    expect(status).toBe(400);
    expect(body.field).toBe("kanban.instructions");
  });

  test("a refusal that names no field answers the same body it answers today", async () => {
    const { status, body } = await refusal("/__refusal/unnamed", "en");
    expect(status).toBe(403);
    expect(body).toEqual({ error: "Forbidden" });
  });
});
