import { t } from "elysia";

// What a client channel turn carries besides who the user is, shared by the proxy route (the host's
// server states the user) and the SDK's route (the app's token names them).
export const clientTurnFields = {
  message: t.Optional(t.String({ minLength: 1, maxLength: 10_000 })),
  // Checked here, before the graph: LangGraph persists a resume value, so a malformed answer
  // that reached it would fail every corrected retry of the same turn too.
  answers: t.Optional(
    t.Record(
      t.String(),
      t.Union([
        t.Object({
          ok: t.Literal(true),
          result: t.Optional(t.Unknown()),
        }),
        t.Object({ ok: t.Literal(false), error: t.String() }),
      ]),
    ),
  ),
  context: t.Optional(t.Record(t.String(), t.Unknown())),
  clientTools: t.Array(
    t.Object({
      name: t.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
      description: t.String({ minLength: 1, maxLength: 1024 }),
      parameters: t.Record(t.String(), t.Unknown()),
    }),
    { maxItems: 64 },
  ),
};
