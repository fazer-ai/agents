/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  SheetsConfigEditor,
  type SheetsLoaders,
  spreadsheetIdFrom,
} from "@/client/pages/resources/SheetsConfigEditor";

afterEach(cleanup);

const SID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

function loaders(over: Partial<SheetsLoaders> = {}) {
  const calls: string[] = [];
  const l: SheetsLoaders = {
    spreadsheets: async () => {
      calls.push("list");
      return [
        { id: SID, name: "CRM" },
        { id: "2ZzZzZzZzZzZzZzZzZ", name: "Preços" },
      ];
    },
    tabs: async (_ref, id) => {
      calls.push(`tabs:${id}`);
      return {
        title: id === SID ? "CRM" : "Preços",
        tabs: [
          { sheetId: 0, title: "Leads", columns: ["Nome", "Telefone"] },
          { sheetId: 42, title: "Vazia", columns: [] },
        ],
      };
    },
    ...over,
  };
  return { l, calls };
}

// The editor owns no state of its own about the config: it lives in the modal's form, so the harness
// holds it the same way and exposes what was last stored.
function Harness({
  initial,
  l,
  onCfg,
}: {
  initial: Record<string, unknown>;
  l: SheetsLoaders;
  onCfg: (c: Record<string, unknown>) => void;
}) {
  const [cfg, setCfgState] = useState(initial);
  return (
    <SheetsConfigEditor
      credentialRef="vault:3"
      cfg={cfg}
      setCfg={(patch) =>
        setCfgState((c) => {
          const next = { ...c, ...patch };
          onCfg(next);
          return next;
        })
      }
      loaders={l}
    />
  );
}

describe("the id out of what the operator pastes", () => {
  test("a URL, a bare id, and things that are neither", () => {
    expect(
      spreadsheetIdFrom(
        `https://docs.google.com/spreadsheets/d/${SID}/edit#gid=0`,
      ),
    ).toBe(SID);
    expect(spreadsheetIdFrom(`  ${SID} `)).toBe(SID);
    expect(spreadsheetIdFrom("Leads")).toBeNull();
    expect(spreadsheetIdFrom("https://example.com/x")).toBeNull();
  });
});

describe("the Sheets settings", () => {
  test("pasting a URL picks the spreadsheet, lists its tabs with their columns, and a tab is stored by id", async () => {
    const { l } = loaders();
    let cfg: Record<string, unknown> = {};
    render(<Harness initial={{}} l={l} onCfg={(c) => (cfg = c)} />);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Spreadsheet URL or id" }),
      {
        target: {
          value: `https://docs.google.com/spreadsheets/d/${SID}/edit#gid=0`,
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() =>
      expect(screen.getByText("Columns: Nome, Telefone")).toBeTruthy(),
    );
    expect(cfg.spreadsheetId).toBe(SID);
    expect(cfg.spreadsheetName).toBe("CRM");
    expect(
      screen.getByText("No header row: row 1 must name the columns"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Leads/ }));
    expect(cfg.sheetId).toBe(0);
    expect(cfg.sheetTitle).toBe("Leads");
    expect(
      screen
        .getByRole("button", { name: /Leads/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("reopening shows the saved spreadsheet and tab without any action", async () => {
    const { l, calls } = loaders();
    render(
      <Harness
        initial={{
          spreadsheetId: SID,
          spreadsheetName: "CRM",
          sheetId: 42,
          sheetTitle: "Vazia",
        }}
        l={l}
        onCfg={() => {}}
      />,
    );
    expect(screen.getByTestId("sheets-current").textContent).toBe("CRM");
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /Vazia/ })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(calls).toEqual([`tabs:${SID}`]);
  });

  test("a saved tab that no longer exists is said, not silently dropped", async () => {
    const { l } = loaders();
    render(
      <Harness
        initial={{ spreadsheetId: SID, sheetId: 7, sheetTitle: "Antiga" }}
        l={l}
        onCfg={() => {}}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          'The saved tab "Antiga" is no longer in this spreadsheet. Choose a tab.',
        ),
      ).toBeTruthy(),
    );
  });

  test("choosing another spreadsheet from the account clears the tab", async () => {
    const { l } = loaders();
    let cfg: Record<string, unknown> = {};
    render(
      <Harness
        initial={{ spreadsheetId: SID, sheetId: 0, sheetTitle: "Leads" }}
        l={l}
        onCfg={(c) => (cfg = c)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Preços/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Preços/ }));
    expect(cfg.spreadsheetId).toBe("2ZzZzZzZzZzZzZzZzZ");
    expect(cfg.sheetId).toBeNull();
    expect(cfg.sheetTitle).toBe("");
  });

  test("a list the scope does not allow shows the server's sentence, and pasting still works", async () => {
    const { l } = loaders({
      spreadsheets: async () => {
        throw {
          status: 502,
          value: { error: "Reconnect with the Drive (read-only) scope." },
        };
      },
    });
    render(<Harness initial={{}} l={l} onCfg={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    await waitFor(() =>
      expect(
        screen.getByText("Reconnect with the Drive (read-only) scope."),
      ).toBeTruthy(),
    );
    expect(
      screen.getByRole("textbox", { name: "Spreadsheet URL or id" }),
    ).toBeTruthy();
  });

  test("the warning that the agent reads the whole tab is on screen", () => {
    const { l } = loaders();
    render(<Harness initial={{}} l={l} onCfg={() => {}} />);
    expect(screen.getByText(/can read every row of this tab/)).toBeTruthy();
  });
});
