import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { playgroundDraftSchema } from "@/api/v1/agents.controller";

// Regression for the playground audio/file endpoints. Elysia's multipart parser auto-parses any
// form field whose value starts with `{`/`[` and is valid JSON into an object (see
// adapter/web-standard formData). The live-edit `draft` rides multipart as `JSON.stringify(...)`,
// so it arrives ALREADY as an object — typing it `t.String()` 422s ("Expected string but found
// [object Object]"). The body schema must accept the object (union with string for the malformed-
// JSON degrade path).
//
// The REAL schema is imported, never mirrored. A copy here validated its own fields and told us
// nothing about the endpoint's: a draft field declared in TypeScript but missing from the schema is
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

describe("playground multipart draft schema", () => {
  test("a JSON-stringified draft validates and arrives as an object (auto-parsed)", async () => {
    const res = await app.handle(
      new Request("http://localhost/upload", {
        method: "POST",
        body: buildForm({
          systemPrompt: "",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          settings: { tts: { mode: "mirror" } },
        }),
      }),
    );
    expect(res.status).toBe(200);
    // The parser turned the `{`-leading field into an object before validation — exactly why
    // t.String() would reject it.
    expect((await res.json()).draftType).toBe("object");
  });

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
    const res = await app.handle(
      new Request("http://localhost/upload", {
        method: "POST",
        body: buildForm(undefined),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).draftType).toBe("undefined");
  });
});

// The two-step audio flow sends the step-1 transcription to the step-2 turn so STT runs once. The
// transcription is arbitrary speech text that might start with `{`/`[`; sent raw, the multipart
// parser would auto-parse it into an object and the t.String() field would 422. The client
// JSON-encodes it (always a quoted string ⇒ never auto-parsed), and the server JSON.parses it back.
const decode = (raw: unknown): string | undefined => {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
};

const turnApp = new Elysia().post(
  "/turn",
  ({ body }) => ({
    transcription: decode((body as { transcription?: string }).transcription),
  }),
  {
    body: t.Object({
      file: t.File(),
      transcription: t.Optional(t.String()),
    }),
  },
);

function turnForm(transcription?: string): FormData {
  const fd = new FormData();
  fd.append(
    "file",
    new File([new Uint8Array([1])], "note.webm", { type: "audio/webm" }),
  );
  // Mirrors the client: JSON-encode the transcription so a bracket-leading value isn't auto-parsed.
  if (transcription !== undefined) {
    fd.append("transcription", JSON.stringify(transcription));
  }
  return fd;
}

describe("playground multipart transcription field", () => {
  test("a bracket-leading transcription round-trips intact (JSON-encoded ⇒ not auto-parsed)", async () => {
    const original = "[música] olá, tudo bem?";
    const res = await turnApp.handle(
      new Request("http://localhost/turn", {
        method: "POST",
        body: turnForm(original),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).transcription).toBe(original);
  });

  test("absent transcription decodes to undefined (server then transcribes)", async () => {
    const res = await turnApp.handle(
      new Request("http://localhost/turn", {
        method: "POST",
        body: turnForm(undefined),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).transcription).toBeUndefined();
  });
});

// The file flow's step-2 turn carries a precomputed extraction: `kind` (a known enum, safe as a
// plain field) + `extracted` (arbitrary text, JSON-encoded like the transcription).
const fileTurnApp = new Elysia().post(
  "/file-turn",
  ({ body }) => {
    const b = body as { kind?: string; extracted?: string };
    const kind =
      b.kind === "image" || b.kind === "document" || b.kind === "unsupported"
        ? b.kind
        : undefined;
    return { kind, extracted: decode(b.extracted) };
  },
  {
    body: t.Object({
      file: t.File(),
      kind: t.Optional(t.String()),
      extracted: t.Optional(t.String()),
    }),
  },
);

describe("playground multipart file extraction fields", () => {
  test("kind passes through and a bracket-leading extraction round-trips", async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new File([new Uint8Array([1])], "doc.pdf", { type: "application/pdf" }),
    );
    fd.append("kind", "document");
    fd.append("extracted", JSON.stringify("[tabela] total: 10"));
    const res = await fileTurnApp.handle(
      new Request("http://localhost/file-turn", { method: "POST", body: fd }),
    );
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.kind).toBe("document");
    expect(out.extracted).toBe("[tabela] total: 10");
  });
});
