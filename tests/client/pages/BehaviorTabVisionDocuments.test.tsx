/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import { behaviorTabProps } from "./behaviorTabProps";

// Issue #324, second half: `openai` reads PDFs now, `openrouter` and `openai-compatible` still do
// not, and the operator who picks one of those has no way to learn it except from attachments that
// silently come back unextracted. The warning belongs where the choice is made.
//
// NOTE: every assertion reduces to a number or a boolean BEFORE expect. A failing expectation
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

function renderWithProvider(
  provider: string,
  { baseURL = "", credBaseUrl = null as string | null } = {},
): void {
  render(
    <BehaviorTab
      {...behaviorTabProps({
        vision: {
          enabled: true,
          provider,
          model: "",
          credentialRef: "",
          baseURL,
          extractionPrompt: "Leia.",
        },
        visionCredBaseUrl: credBaseUrl,
      })}
    />,
  );
}

const warnings = () =>
  screen.queryAllByText(/PDF attachments are skipped/i).length +
  screen.queryAllByText(/anexos em PDF são ignorados/i).length;

// The model field carried a STATIC sentence naming which providers read PDFs, which this change
// turns into a lie. It is counted separately because it is a different failure from a missing
// warning: nothing about it depends on the provider being rendered.
const staleClaims = () =>
  screen.queryAllByText(/reads images only/i).length +
  screen.queryAllByText(/lê apenas imagens/i).length;

describe("vision provider document support, at the point of choice", () => {
  // Installed in `beforeAll` rather than at module scope, and this is not style. `globalThis.fetch`
  // is the whole PROCESS's, and a swap made while the module loads is in force from that moment
  // until this describe finishes — a window that covers whatever else the runner is doing in
  // between. Every DB-backed test in the suite that reaches the network is inside it. Bracketing it
  // to the describe keeps the swap as short as the tests that need it.
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("openrouter is called out as image-only", () => {
    renderWithProvider("openrouter");
    expect(warnings() > 0).toBe(true);
  });

  // The endpoint is what has to be known, and a base URL survives the provider being switched: an
  // agent moved off `openai-compatible` keeps posting to the operator's own server under the name
  // `openai`. The warning has to follow the endpoint, not the name.
  test("openai pointed at someone else's endpoint is called out too", () => {
    renderWithProvider("openai", {
      baseURL: "https://llm.internal.example/v1",
    });
    expect(warnings() > 0).toBe(true);
  });

  // Same thing arriving the other way: a credential can carry its own base URL, and it OUTRANKS the
  // typed field (the field is rendered read-only when it does).
  test("openai on a credential that carries its own endpoint is called out too", () => {
    renderWithProvider("openai", {
      credBaseUrl: "https://llm.internal.example/v1",
    });
    expect(warnings() > 0).toBe(true);
  });

  test("openai spelled out as its own endpoint is not", () => {
    renderWithProvider("openai", { baseURL: "https://api.openai.com/v1" });
    expect(warnings()).toBe(0);
  });

  test("openai-compatible is called out as image-only", () => {
    renderWithProvider("openai-compatible");
    expect(warnings() > 0).toBe(true);
  });

  // The one the issue is about: openai reads PDFs now, so warning about it would be the new lie.
  test("openai carries no such warning", () => {
    renderWithProvider("openai");
    expect(warnings()).toBe(0);
    expect(staleClaims()).toBe(0);
  });

  test("gemini carries no such warning", () => {
    renderWithProvider("gemini");
    expect(warnings()).toBe(0);
    expect(staleClaims()).toBe(0);
  });
});
