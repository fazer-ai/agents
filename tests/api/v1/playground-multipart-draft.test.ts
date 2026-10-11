import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Blob as NativeBlob } from "node:buffer";
import { Elysia, t } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import { playgroundDraftSchema } from "@/api/v1/agents.controller";
import {
  type MockUserEntity,
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// Elysia's multipart parser auto-parses any form field that starts with `{`/`[` and is valid JSON
// into an object, so the live-edit `draft` (sent as `JSON.stringify(...)`) arrives as an object and a
// `t.String()` field would 422. The body schema accepts the object (union with string for the
// malformed-JSON degrade path).
//
// The REAL schema is imported, never mirrored: a draft field missing from the endpoint's schema is
// stripped by Elysia's normalize before the handler runs, and a mirrored schema cannot see that.

const app = new Elysia().post(
  "/upload",
  ({ body }) => {
    const draft = (body as { draft?: unknown }).draft;
    return {
      draftType: draft === undefined ? "undefined" : typeof draft,
      // What actually survived normalization, which is the only thing the handler can act on.
      keys:
        draft && typeof draft === "object" ? Object.keys(draft).sort() : null,
    };
  },
  {
    body: t.Object({
      file: t.File(),
      threadId: t.Optional(t.String()),
      draft: t.Optional(t.Union([t.String(), playgroundDraftSchema])),
      forceAudio: t.Optional(t.String()),
    }),
  },
);

function buildForm(draft?: unknown): FormData {
  const fd = new FormData();
  fd.append(
    "file",
    new File([new Uint8Array([1, 2, 3])], "note.webm", { type: "audio/webm" }),
  );
  fd.append("threadId", "1:playground:2074:1e191d1b");
  fd.append("forceAudio", "undefined");
  if (draft !== undefined) fd.append("draft", JSON.stringify(draft));
  return fd;
}

// The step-2 turns through the REAL routes, with the two services stubbed: what a route hands its
// service is what the turn acts on, so that is what these assert.
setupPrismaMock();
const playground = await import("@/modules/playground/service");
const turns: Record<string, Record<string, unknown>> = {};
const capture = (name: string) => async (input: Record<string, unknown>) => {
  turns[name] = input;
  return {};
};
const audioTurn = spyOn(
  playground,
  "runPlaygroundAudioTurn",
).mockImplementation(
  capture("audio") as unknown as typeof playground.runPlaygroundAudioTurn,
);
const fileTurn = spyOn(playground, "runPlaygroundFileTurn").mockImplementation(
  capture("file") as unknown as typeof playground.runPlaygroundFileTurn,
);
const server = (await import("@/app")).default;
afterAll(() => {
  audioTurn.mockRestore();
  fileTurn.mockRestore();
});

const admin: MockUserEntity = { ...mockUser, role: "TENANT_ADMIN" };
mockFindUnique.mockImplementation(() => Promise.resolve(admin));
const { token } = (await (
  await new Elysia()
    .use(authPlugin)
    .post("/mint", async ({ setAuthCookie }) => ({
      token: await setAuthCookie(admin, admin.passwordHash),
    }))
    .handle(new Request("http://localhost/mint", { method: "POST" }))
).json()) as { token: string };
const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

// Written by hand because happy-dom's Request drops the session cookie and Bun's own
// Request does not serialize happy-dom's FormData.
async function postTurn(
  route: "audio" | "file",
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  delete turns[route];
  const boundary = "----turn-boundary";
  const parts = Object.entries(fields).map(
    ([k, v]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
  );
  const file = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.bin"\r\nContent-Type: application/octet-stream\r\n\r\nabc\r\n`;
  // `t.File` checks `instanceof Blob` against the global, which happy-dom replaced; Bun's
  // parser makes Bun's.
  const happyDomBlob = globalThis.Blob;
  globalThis.Blob = NativeBlob as unknown as typeof Blob;
  try {
    const res = await server.handle(
      new BunReq(`http://localhost/api/v1/agents/1/playground/${route}`, {
        method: "POST",
        headers: {
          cookie: `fazerai_auth_token=${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body: `${file}${parts.join("")}--${boundary}--\r\n`,
      }),
    );
    expect(res.status).toBe(200);
  } finally {
    globalThis.Blob = happyDomBlob;
  }
  return turns[route] ?? {};
}

describe("playground multipart draft schema", () => {
  test("every declared draft field survives normalization", async () => {
    // The failure this guards is silent: Elysia strips a field the schema does not declare, the
    // handler sees `undefined`, and the turn runs against the saved config while the operator
    // believes they are testing their unsaved edit. Asserting the type compiles proves nothing —
    // only what comes back out of the parser does.
    const sent = {
      systemPrompt: "p",
      businessHoursId: "42",
      modelConfig: { provider: "openai" },
      settings: { tts: { mode: "mirror" } },
      toolMocks: { t: "r" },
      promptVars: { nome_contato: "Maria" },
      promptNow: "2026-08-20T22:00",
    };
    const res = await app.handle(
      new Request("http://localhost/upload", {
        method: "POST",
        body: buildForm(sent),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).keys).toEqual(Object.keys(sent).sort());
    // And the fixture is checked against the schema itself, so this guard covers the fields added
    // after it was written: a new draft field fails here until it is exercised above.
    expect(Object.keys(sent).sort()).toEqual(
      Object.keys(playgroundDraftSchema.properties).sort(),
    );
  });

  test("absent draft still validates (override is optional)", async () => {
    const turn = await postTurn("audio", { threadId: "t" });
    expect(turn).toHaveProperty("overrides", undefined);
    expect(turn.threadId).toBe("t");
  });
});

// The two-step audio flow sends the step-1 transcription to the step-2 turn so STT runs once. The
// transcription is arbitrary speech text that might start with `{`/`[`; sent raw, the multipart
// parser would auto-parse it into an object and the t.String() field would 422. The client
// JSON-encodes it (always a quoted string ⇒ never auto-parsed), and the server JSON.parses it back.
describe("playground multipart transcription field", () => {
  test("a bracket-leading transcription round-trips intact (JSON-encoded ⇒ not auto-parsed)", async () => {
    const original = "[música] olá, tudo bem?";
    const turn = await postTurn("audio", {
      transcription: JSON.stringify(original),
    });
    expect(turn.transcription).toBe(original);
  });

  test("absent transcription decodes to undefined (server then transcribes)", async () => {
    const turn = await postTurn("audio", { threadId: "t" });
    expect(turn).toHaveProperty("transcription", undefined);
    expect(turn.threadId).toBe("t");
  });
});

// The file flow's step-2 turn carries a precomputed extraction: `kind` (a known enum, safe as a
// plain field) + `extracted` (arbitrary text, JSON-encoded like the transcription).
describe("playground multipart file extraction fields", () => {
  test("kind passes through and a bracket-leading extraction round-trips", async () => {
    const turn = await postTurn("file", {
      kind: "document",
      extracted: JSON.stringify("[tabela] total: 10"),
    });
    expect(turn.kind).toBe("document");
    expect(turn.extracted).toBe("[tabela] total: 10");
  });
});
