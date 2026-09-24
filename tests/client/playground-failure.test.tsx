/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import { ErrorLogsLink } from "@/client/pages/agents/PlaygroundChat";
import { playgroundFailure } from "@/client/pages/agents/usePlaygroundChat";

// Issue #841: the error bubble says what the server said, and where the cause is when it could not.
// The old one read only a JSON `error` and otherwise told the operator to check the model, which was
// wrong for the failure that prompted this (a database error with the model configured).

afterEach(cleanup);

async function i18n(lng: "en" | "pt-BR") {
  const i = i18next.createInstance();
  await i.init({
    lng,
    resources: {
      en: { translation: clientEn },
      "pt-BR": { translation: clientPt },
    },
    interpolation: { escapeValue: false },
  });
  return i;
}

const TURN = "0b6f1c3e-5a4e-4d7a-9c1e-2f3a4b5c6d7e";

describe("playgroundFailure", () => {
  test("a refusal's reason and turn id are what the bubble shows", async () => {
    const t = (await i18n("en")).t.bind(null) as never;
    expect(
      playgroundFailure(
        {
          status: 500,
          value: { error: "The turn failed on the server.", turnId: TURN },
        },
        t,
      ),
    ).toEqual({ text: "The turn failed on the server.", turnId: TURN });
  });

  test("a plain-text body is the reason, unless it is the catch-all's placeholder", async () => {
    const t = (await i18n("en")).t.bind(null) as never;
    expect(
      playgroundFailure({ status: 500, value: `  ${"relation x"}  ` }, t),
    ).toEqual({ text: "relation x" });
    expect(
      playgroundFailure({ status: 500, value: "Something went wrong" }, t).text,
    ).toBe("The server answered with an error and did not say why.");
  });

  test("no reason says so, and no longer points at the model", async () => {
    const t = (await i18n("pt-BR")).t.bind(null) as never;
    const text = playgroundFailure({ status: 500, value: {} }, t).text;
    expect(text).toBe("O servidor respondeu com erro e não disse o motivo.");
    expect(text).not.toMatch(/modelo|Geral/);
  });

  test("a call that got no answer is a failure to reach the server", async () => {
    const t = (await i18n("en")).t.bind(null) as never;
    expect(playgroundFailure(undefined, t).text).toBe(
      "Could not reach the server. Check the connection and try again.",
    );
  });
});

describe("ErrorLogsLink", () => {
  test("links the turn's playground lines on the Logs page, and names the id", async () => {
    render(
      <I18nextProvider i18n={await i18n("pt-BR")}>
        <MemoryRouter>
          <ErrorLogsLink turnId={TURN} />
        </MemoryRouter>
      </I18nextProvider>,
    );
    const link = screen.getByTestId("playground-error-logs");
    expect(link.getAttribute("href")).toBe(
      `/logs?source=playground&turnId=${TURN}`,
    );
    expect(link.textContent).toBe(`Ver este turno nos Logs (${TURN})`);
  });
});
