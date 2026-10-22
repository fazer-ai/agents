import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { getCatalogEntry } from "@/modules/integrations/catalog";
import {
  assertIntegrationWritable,
  createIntegrationInstance,
} from "@/modules/integrations/service";
import {
  getToolpackToolNames,
  getToolpackToolViews,
} from "@/modules/integrations/toolpacks";
import { googleSheetsToolpack } from "@/modules/integrations/toolpacks/google-sheets";
import type {
  IntegrationSelection,
  ToolpackCtx,
} from "@/modules/integrations/toolpacks/types";

// A stand-in for the Sheets REST API that behaves like it on the four calls the pack makes: the
// spreadsheet's tab list, a values read by A1 range, an append after the last row of the table, and a
// batch of single-cell writes. It answers 401 to any bearer but the one it was given, stores what it
// is sent as-is under RAW and EVALUATES a leading `=` under USER_ENTERED, which is the difference the
// pack's value mode exists for.
type Tab = {
  sheetId: number;
  title: string;
  rows: string[][];
  gridRows?: number;
  sheetType?: string;
};

const ORIGIN = "https://sheets.googleapis.com/v4/spreadsheets";

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseRange(range: string): {
  title: string;
  startRow: number;
  endRow: number | null;
  col: number | null;
} {
  const m = /^'((?:[^']|'')*)'!(.*)$/.exec(range);
  if (!m) throw new Error(`fake: unquoted range ${range}`);
  const title = (m[1] as string).replace(/''/g, "'");
  const ref = m[2] as string;
  const rows = /^(\d+):(\d+)$/.exec(ref);
  if (rows)
    return {
      title,
      startRow: Number(rows[1]),
      endRow: Number(rows[2]),
      col: null,
    };
  const span = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
  if (span)
    return {
      title,
      startRow: Number(span[2]),
      endRow: Number(span[4]),
      col: colIndex(span[1] as string),
    };
  const cell = /^([A-Z]+)(\d+)$/.exec(ref);
  if (cell)
    return {
      title,
      startRow: Number(cell[2]),
      endRow: Number(cell[2]),
      col: colIndex(cell[1] as string),
    };
  throw new Error(`fake: unsupported range ${range}`);
}

class FakeSheets {
  calls: Array<{
    method: string;
    url: string;
    auth: string | null;
    body: unknown;
  }> = [];
  writes = 0;
  constructor(
    readonly spreadsheetId: string,
    readonly tabs: Tab[],
    readonly token = "tok_live",
  ) {}

  tab(sheetId: number): Tab {
    const t = this.tabs.find((x) => x.sheetId === sheetId);
    if (!t) throw new Error("fake: no tab");
    return t;
  }

  private byTitle(title: string): Tab | undefined {
    return this.tabs.find((t) => t.title === title);
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private store(raw: unknown, mode: string | null): string {
    const s = String(raw);
    return mode === "USER_ENTERED" && s.startsWith("=") ? "#EVALUATED" : s;
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({
      method,
      url: String(input),
      auth: headers.get("authorization"),
      body,
    });
    if (headers.get("authorization") !== `Bearer ${this.token}`)
      return this.json(401, { error: { code: 401 } });
    const prefix = `/v4/spreadsheets/${this.spreadsheetId}`;
    if (url.origin !== "https://sheets.googleapis.com")
      return this.json(404, {});
    if (!url.pathname.startsWith(prefix)) return this.json(404, {});
    const rest = decodeURIComponent(url.pathname.slice(prefix.length));
    if (rest === "" && method === "GET") {
      return this.json(200, {
        properties: { title: "Spreadsheet" },
        sheets: this.tabs.map((t) => ({
          properties: {
            sheetId: t.sheetId,
            title: t.title,
            sheetType: t.sheetType ?? "GRID",
            gridProperties: {
              rowCount: t.gridRows ?? Math.max(t.rows.length, 1000),
            },
          },
        })),
      });
    }
    if (rest === ":batchUpdate" && method === "POST") {
      // appendCells: after the last row with data anywhere in the tab, cell N in column N. A
      // stringValue is stored as text; a formulaValue would be evaluated.
      const reqs = (body as { requests: Array<Record<string, unknown>> })
        .requests;
      for (const req of reqs) {
        const ac = req.appendCells as
          | {
              sheetId: number;
              fields: string;
              rows: Array<{ values: Array<Record<string, unknown>> }>;
            }
          | undefined;
        if (ac?.fields !== "userEnteredValue") return this.json(400, {});
        const tab = this.tabs.find((t) => t.sheetId === ac.sheetId);
        if (!tab) return this.json(400, {});
        while (
          tab.rows.length &&
          (tab.rows[tab.rows.length - 1] ?? []).every((c) => c === "")
        )
          tab.rows.pop();
        for (const r of ac.rows) {
          tab.rows.push(
            r.values.map((c) => {
              const v = c.userEnteredValue as
                | { stringValue?: string; formulaValue?: string }
                | undefined;
              if (v?.formulaValue !== undefined) return "#EVALUATED";
              return v?.stringValue ?? "";
            }),
          );
          this.writes++;
        }
      }
      return this.json(200, { replies: [{}] });
    }
    if (rest === "/values:batchUpdate" && method === "POST") {
      const b = body as {
        valueInputOption: string;
        data: Array<{ range: string; values: unknown[][] }>;
      };
      for (const d of b.data) {
        const r = parseRange(d.range);
        const tab = this.byTitle(r.title);
        if (!tab || r.col === null) return this.json(400, {});
        if (!tab.rows[r.startRow - 1]) tab.rows[r.startRow - 1] = [];
        const row = tab.rows[r.startRow - 1] as string[];
        while (row.length <= r.col) row.push("");
        row[r.col] = this.store(d.values[0]?.[0], b.valueInputOption);
        this.writes++;
      }
      return this.json(200, { totalUpdatedCells: b.data.length });
    }
    const values = /^\/values\/(.+?)(:append)?$/.exec(rest);
    if (!values) return this.json(404, {});
    const r = parseRange(values[1] as string);
    const tab = this.byTitle(r.title);
    if (!tab)
      return this.json(400, { error: { message: "Unable to parse range" } });
    const end = Math.min(r.endRow ?? tab.rows.length, tab.rows.length);
    const slice = tab.rows.slice(r.startRow - 1, end).map((row) => {
      const out = [...row];
      while (out.length && out[out.length - 1] === "") out.pop();
      return out;
    });
    return this.json(200, { range: values[1], values: slice });
  }) as unknown as typeof fetch;
}

const SID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

function leads(): Tab {
  return {
    sheetId: 0,
    title: "Leads",
    rows: [
      ["Nome", "Telefone", "Status", "Origem"],
      ["Ana", "5511999990001", "novo", "site"],
      ["Bruno", "5511999990002", "contatado", ""],
      ["ana", "5511999990003", "novo", "instagram"],
    ],
  };
}

function precos(): Tab {
  return {
    sheetId: 77,
    title: "Preços",
    rows: [
      ["Serviço", "Valor"],
      ["Consulta", "R$ 200,00"],
    ],
  };
}

function setup(
  tools: string[],
  over: {
    config?: Record<string, unknown>;
    tabs?: Tab[];
    credentialRef?: string | null;
    ctx?: Partial<ToolpackCtx>;
  } = {},
) {
  const fake = new FakeSheets(SID, over.tabs ?? [leads(), precos()]);
  const asserted: string[] = [];
  const sel: IntegrationSelection = {
    instanceId: 1n,
    catalogType: "GOOGLE_SHEETS",
    config: over.config ?? { spreadsheetId: SID, sheetId: 0 },
    credentialRef:
      over.credentialRef === undefined ? "vault:9" : over.credentialRef,
    enabledTools: tools,
  };
  const ctx: ToolpackCtx = {
    tenantId: 1n,
    base: undefined as unknown as PrismaClient,
    threadId: "1:1:1",
    resolveCredential: async () => "tok_live",
    assertSafe: async (u: string) => {
      asserted.push(u);
    },
    fetchImpl: fake.fetch,
    ...over.ctx,
  };
  const built = googleSheetsToolpack.build(sel, ctx);
  const tool = (name: string) => {
    const t = built.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not built`);
    return (input: unknown) => t.invoke(input as never) as Promise<string>;
  };
  return { fake, built, tool, asserted };
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("google sheets: catalog and grant", () => {
  test("the catalog has the entry, as a toolpack over a Google credential", () => {
    expect(getCatalogEntry("GOOGLE_SHEETS")?.kind).toBe("TOOLPACK");
    expect(getCatalogEntry("GOOGLE_SHEETS")?.supportsInbound).toBe(false);
  });

  test("three tools, each grantable alone, none of them taking a range or a tab", () => {
    expect(getToolpackToolNames("GOOGLE_SHEETS")).toEqual([
      "sheets_append_row",
      "sheets_find_rows",
      "sheets_update_row",
    ]);
    for (const v of getToolpackToolViews("GOOGLE_SHEETS")) {
      const names = v.args.map((a) => a.name.toLowerCase());
      for (const forbidden of [
        "range",
        "sheet",
        "sheetid",
        "spreadsheetid",
        "tab",
      ])
        expect(names).not.toContain(forbidden);
    }
  });

  test("only the granted tools are built", () => {
    expect(setup([]).built).toEqual([]);
    expect(setup(["sheets_append_row"]).built.map((t) => t.name)).toEqual([
      "sheets_append_row",
    ]);
    expect(setup(["bogus"]).built).toEqual([]);
  });
});

describe("google sheets: append", () => {
  test("values land under their header, by name and in any case; other columns stay blank", async () => {
    const { fake, tool } = setup(["sheets_append_row"]);
    const out = await tool("sheets_append_row")({
      values: [
        { column: "telefone", value: "5511988887777" },
        { column: " NOME ", value: "Carla" },
      ],
    });
    expect(out).toContain("Added the row");
    expect(fake.tab(0).rows[4]).toEqual(["Carla", "5511988887777", "", ""]);
  });

  test("a value that looks like a formula is stored as the text it is", async () => {
    const { fake, tool } = setup(["sheets_append_row"]);
    await tool("sheets_append_row")({
      values: [{ column: "Nome", value: '=IMPORTXML("http://x","//a")' }],
    });
    expect(fake.tab(0).rows[4]?.[0]).toBe('=IMPORTXML("http://x","//a")');
  });

  test("an unknown column is refused with the real ones named, and nothing is written", async () => {
    const { fake, tool } = setup(["sheets_append_row"]);
    const out = await tool("sheets_append_row")({
      values: [
        { column: "Nome", value: "Carla" },
        { column: "Email", value: "c@x.com" },
      ],
    });
    expect(out).toContain('"Email"');
    for (const h of ["Nome", "Telefone", "Status", "Origem"])
      expect(out).toContain(h);
    expect(fake.writes).toBe(0);
    expect(fake.tab(0).rows.length).toBe(4);
  });

  test("an unknown column on a tab with a huge header gets a bounded list of the real ones", async () => {
    const header = Array.from(
      { length: 1000 },
      (_, i) => `Coluna ${i} ${"x".repeat(i === 0 ? 5000 : 50)}`,
    );
    const { tool, fake } = setup(["sheets_append_row"], {
      tabs: [{ sheetId: 0, title: "Leads", rows: [header] }],
    });
    const out = await tool("sheets_append_row")({
      values: [{ column: "Email", value: "c@x.com" }],
    });
    expect(out).toContain('no column "Email"');
    expect(out).toContain("Coluna 1 ");
    expect(out).toMatch(/and \d+ more\.$/);
    expect(out.length).toBeLessThan(2_500);
    expect(fake.writes).toBe(0);
  });

  test("a header that starts after column A still gets each value under its own name", async () => {
    const { fake, tool } = setup(["sheets_append_row"], {
      tabs: [
        {
          sheetId: 0,
          title: "Leads",
          rows: [
            ["", "Nome", "Telefone"],
            ["", "Ana", "1"],
          ],
        },
      ],
    });
    await tool("sheets_append_row")({
      values: [
        { column: "Telefone", value: "2" },
        { column: "Nome", value: "Bia" },
      ],
    });
    expect(fake.tab(0).rows[2]).toEqual(["", "Bia", "2"]);
  });

  test("an unlabeled column A with data does not shift the values off their headers", async () => {
    const { fake, tool } = setup(["sheets_append_row"], {
      tabs: [
        {
          sheetId: 0,
          title: "Leads",
          rows: [
            ["", "Nome", "Telefone"],
            ["nota", "Ana", "1"],
          ],
        },
      ],
    });
    await tool("sheets_append_row")({
      values: [{ column: "Nome", value: "Bia" }],
    });
    expect(fake.tab(0).rows[2]).toEqual(["", "Bia", ""]);
  });

  test("the row goes to the configured tab and no other", async () => {
    const { fake, tool } = setup(["sheets_append_row"], {
      config: { spreadsheetId: SID, sheetId: 77 },
    });
    await tool("sheets_append_row")({
      values: [{ column: "Serviço", value: "Exame" }],
    });
    expect(fake.tab(77).rows[2]).toEqual(["Exame", ""]);
    expect(fake.tab(0).rows.length).toBe(4);
  });

  test("the tab is found by its id, so a renamed tab keeps working", async () => {
    const renamed = leads();
    renamed.title = "Leads 2026 (it's new)";
    const { fake, tool } = setup(["sheets_append_row"], { tabs: [renamed] });
    await tool("sheets_append_row")({
      values: [{ column: "Nome", value: "Davi" }],
    });
    expect(fake.tab(0).rows[4]).toEqual(["Davi", "", "", ""]);
  });

  test("a tab without a header row is refused before any write", async () => {
    const { fake, tool } = setup(["sheets_append_row"], {
      tabs: [{ sheetId: 0, title: "Leads", rows: [] }],
    });
    const out = await tool("sheets_append_row")({
      values: [{ column: "Nome", value: "x" }],
    });
    expect(out.toLowerCase()).toContain("header");
    expect(fake.writes).toBe(0);
  });
});

describe("google sheets: a header that names a column twice", () => {
  test("writing to that name is refused as ambiguous, and nothing is written", async () => {
    const { fake, tool } = setup(["sheets_append_row"], {
      tabs: [
        {
          sheetId: 0,
          title: "Leads",
          rows: [["Nome", "Status", "status"]],
        },
      ],
    });
    const out = await tool("sheets_append_row")({
      values: [{ column: "Status", value: "novo" }],
    });
    expect(out.toLowerCase()).toContain("more than once");
    expect(fake.writes).toBe(0);
  });
});

describe("google sheets: find", () => {
  test("filtering by a column matches the value regardless of case and edge spaces, with row numbers", async () => {
    const { tool } = setup(["sheets_find_rows"]);
    const out = parse(
      await tool("sheets_find_rows")({ column: "nome", value: " ANA " }),
    );
    expect(out.matched).toBe(2);
    expect(out.rows).toEqual([
      {
        row: 2,
        values: {
          Nome: "Ana",
          Telefone: "5511999990001",
          Status: "novo",
          Origem: "site",
        },
      },
      {
        row: 4,
        values: {
          Nome: "ana",
          Telefone: "5511999990003",
          Status: "novo",
          Origem: "instagram",
        },
      },
    ]);
  });

  test("a blank row in the middle of the tab is not listed as a row", async () => {
    const t = leads();
    t.rows.splice(2, 0, ["", "", "", ""]);
    const { tool } = setup(["sheets_find_rows"], { tabs: [t] });
    const out = parse(await tool("sheets_find_rows")({}));
    expect((out.rows as Array<{ row: number }>).map((r) => r.row)).toEqual([
      2, 4, 5,
    ]);
  });

  test("a column named __proto__ comes back with its value", async () => {
    const { tool } = setup(["sheets_find_rows"], {
      tabs: [
        {
          sheetId: 0,
          title: "Leads",
          rows: [
            ["Nome", "__proto__"],
            ["Ana", "valor"],
          ],
        },
      ],
    });
    const out = await tool("sheets_find_rows")({});
    expect(out).toContain('"__proto__":"valor"');
  });

  test("contains matches part of the cell", async () => {
    const { tool } = setup(["sheets_find_rows"]);
    const out = parse(
      await tool("sheets_find_rows")({
        column: "Telefone",
        value: "0002",
        match: "contains",
      }),
    );
    expect((out.rows as Array<{ row: number }>).map((r) => r.row)).toEqual([3]);
  });

  test("without a filter it pages through the whole tab", async () => {
    const { tool } = setup(["sheets_find_rows"]);
    const first = parse(await tool("sheets_find_rows")({ limit: 2 }));
    expect(first.matched).toBe(3);
    expect((first.rows as Array<{ row: number }>).map((r) => r.row)).toEqual([
      2, 3,
    ]);
    expect(first.nextOffset).toBe(2);
    const second = parse(
      await tool("sheets_find_rows")({ limit: 2, offset: 2 }),
    );
    expect((second.rows as Array<{ row: number }>).map((r) => r.row)).toEqual([
      4,
    ]);
    expect(second.nextOffset).toBeUndefined();
  });

  test("it reads the configured tab and no other", async () => {
    const { tool, fake } = setup(["sheets_find_rows"], {
      config: { spreadsheetId: SID, sheetId: 77 },
    });
    const out = parse(await tool("sheets_find_rows")({}));
    expect(out.rows).toEqual([
      { row: 2, values: { Serviço: "Consulta", Valor: "R$ 200,00" } },
    ]);
    const reads = fake.calls.filter((c) => c.url.includes("/values/"));
    expect(reads.length).toBeGreaterThan(0);
    for (const c of reads)
      expect(decodeURIComponent(c.url)).toContain("'Preços'!");
  });

  test("an unknown filter column is refused with the real ones named", async () => {
    const { tool } = setup(["sheets_find_rows"]);
    const out = await tool("sheets_find_rows")({
      column: "Cidade",
      value: "x",
    });
    expect(out).toContain('"Cidade"');
    expect(out).toContain("Telefone");
  });
});

describe("google sheets: update", () => {
  test("the row found by a unique value gets only the named cells written", async () => {
    const { fake, tool } = setup(["sheets_update_row"]);
    const out = await tool("sheets_update_row")({
      column: "Telefone",
      value: "5511999990002",
      values: [{ column: "status", value: "fechado" }],
    });
    expect(out).toContain("row 3");
    expect(fake.tab(0).rows[2]).toEqual([
      "Bruno",
      "5511999990002",
      "fechado",
      "",
    ]);
    const batch = fake.calls.find((c) => c.url.endsWith("values:batchUpdate"))
      ?.body as { valueInputOption: string; data: unknown[] } | undefined;
    expect(batch?.valueInputOption).toBe("RAW");
    expect(batch?.data.length).toBe(1);
  });

  test("a value matching several rows is refused naming them, and nothing is written", async () => {
    const { fake, tool } = setup(["sheets_update_row"]);
    const out = await tool("sheets_update_row")({
      column: "Nome",
      value: "ana",
      values: [{ column: "Status", value: "x" }],
    });
    expect(out).toContain("2");
    expect(out).toContain("4");
    expect(fake.writes).toBe(0);
  });

  test("a row number picks one of several matches, and a row that does not match is refused", async () => {
    const { fake, tool } = setup(["sheets_update_row"]);
    await tool("sheets_update_row")({
      column: "Nome",
      value: "ana",
      row: 4,
      values: [{ column: "Status", value: "x" }],
    });
    expect(fake.tab(0).rows[3]?.[2]).toBe("x");
    expect(fake.tab(0).rows[1]?.[2]).toBe("novo");
    const before = fake.writes;
    const refused = await tool("sheets_update_row")({
      column: "Nome",
      value: "ana",
      row: 3,
      values: [{ column: "Status", value: "y" }],
    });
    expect(refused).toContain("3");
    expect(fake.writes).toBe(before);
    expect(fake.tab(0).rows[2]?.[2]).toBe("contatado");
  });

  test("no matching row writes nothing", async () => {
    const { fake, tool } = setup(["sheets_update_row"]);
    const out = await tool("sheets_update_row")({
      column: "Nome",
      value: "Zé",
      values: [{ column: "Status", value: "x" }],
    });
    expect(out.toLowerCase()).toContain("no row");
    expect(fake.writes).toBe(0);
  });

  test("an unknown column to write is refused before anything is written", async () => {
    const { fake, tool } = setup(["sheets_update_row"]);
    await tool("sheets_update_row")({
      column: "Nome",
      value: "Bruno",
      values: [{ column: "Cidade", value: "x" }],
    });
    expect(fake.writes).toBe(0);
  });
});

describe("google sheets: long cells and long tabs", () => {
  test("a match is decided on the whole cell, not on the clipped text the model is shown", async () => {
    const t = leads();
    t.rows.push(["Longo", "", `${"x".repeat(1100)}agulha`, ""]);
    const { tool } = setup(["sheets_find_rows"], { tabs: [t] });
    const out = parse(
      await tool("sheets_find_rows")({
        column: "Status",
        value: "agulha",
        match: "contains",
      }),
    );
    expect((out.rows as Array<{ row: number }>).map((r) => r.row)).toEqual([5]);
  });

  test("one row wider than the output budget is refused instead of returned whole", async () => {
    const wide: string[][] = [
      Array.from({ length: 40 }, (_, i) => `c${i}`),
      Array.from({ length: 40 }, () => "y".repeat(1000)),
    ];
    const { tool } = setup(["sheets_find_rows"], {
      tabs: [{ sheetId: 0, title: "Leads", rows: wide }],
    });
    const out = await tool("sheets_find_rows")({});
    expect(out.length).toBeLessThanOrEqual(30_000);
    expect(out.toLowerCase()).toContain("too wide");
  });

  test("blank rows ending the scan do not hide data further down the grid", async () => {
    const t = leads();
    t.gridRows = 2500;
    const { fake, tool } = setup(["sheets_update_row", "sheets_find_rows"], {
      tabs: [t],
    });
    const refused = await tool("sheets_update_row")({
      column: "Nome",
      value: "Bruno",
      values: [{ column: "Status", value: "x" }],
    });
    expect(refused).toContain("row number");
    expect(fake.writes).toBe(0);
    const found = parse(await tool("sheets_find_rows")({}));
    expect(found.incomplete).toBe(true);
  });

  test("on a tab longer than the scan, an update needs the row number, and gets it", async () => {
    const big = leads();
    for (let i = 0; i < 2100; i++) big.rows.push([`n${i}`, "", "novo", ""]);
    const { fake, tool } = setup(["sheets_update_row"], { tabs: [big] });
    const refused = await tool("sheets_update_row")({
      column: "Nome",
      value: "Bruno",
      values: [{ column: "Status", value: "x" }],
    });
    expect(refused).toContain("row number");
    expect(fake.writes).toBe(0);
    await tool("sheets_update_row")({
      column: "Nome",
      value: "Bruno",
      row: 3,
      values: [{ column: "Status", value: "x" }],
    });
    expect(fake.tab(0).rows[2]?.[2]).toBe("x");
  });
});

describe("google sheets: what reaches Google", () => {
  test("every request goes to the fixed origin, past the SSRF check, with the bearer only in the header", async () => {
    const { fake, tool, asserted } = setup([
      "sheets_append_row",
      "sheets_find_rows",
      "sheets_update_row",
    ]);
    await tool("sheets_find_rows")({});
    await tool("sheets_append_row")({
      values: [{ column: "Nome", value: "E" }],
    });
    await tool("sheets_update_row")({
      column: "Nome",
      value: "E",
      values: [{ column: "Status", value: "s" }],
    });
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const c of fake.calls) {
      expect(c.url.startsWith(`${ORIGIN}/${SID}`)).toBe(true);
      expect(c.url).not.toContain("tok_live");
      expect(JSON.stringify(c.body ?? null)).not.toContain("tok_live");
      expect(c.auth).toBe("Bearer tok_live");
    }
    expect(asserted.sort()).toEqual(fake.calls.map((c) => c.url).sort());
  });

  test("a spreadsheet id that is not an id is never sent anywhere", async () => {
    const { fake, tool } = setup(["sheets_find_rows"], {
      config: { spreadsheetId: "../../drive/v3/files", sheetId: 0 },
    });
    const out = await tool("sheets_find_rows")({});
    expect(out.toLowerCase()).toContain("spreadsheet");
    expect(fake.calls).toEqual([]);
  });

  test("not connected, not configured and a deleted tab each say so without writing", async () => {
    const noCred = setup(["sheets_find_rows"], { credentialRef: null });
    expect((await noCred.tool("sheets_find_rows")({})).toLowerCase()).toContain(
      "not connected",
    );
    const noTab = setup(["sheets_find_rows"], {
      config: { spreadsheetId: SID },
    });
    expect((await noTab.tool("sheets_find_rows")({})).toLowerCase()).toContain(
      "tab",
    );
    const gone = setup(["sheets_append_row"], {
      config: { spreadsheetId: SID, sheetId: 5 },
    });
    const out = await gone.tool("sheets_append_row")({
      values: [{ column: "Nome", value: "x" }],
    });
    expect(out.toLowerCase()).toContain("tab");
    expect(gone.fake.writes).toBe(0);
  });

  test("a chart sheet configured as the tab is refused before any read or write", async () => {
    const chart: Tab = {
      sheetId: 0,
      title: "Leads",
      rows: [],
      sheetType: "OBJECT",
    };
    const { fake, tool } = setup(["sheets_append_row"], { tabs: [chart] });
    const out = await tool("sheets_append_row")({
      values: [{ column: "Nome", value: "x" }],
    });
    expect(out.toLowerCase()).toContain("chart");
    expect(fake.calls.filter((c) => c.url.includes("/values")).length).toBe(0);
    expect(fake.writes).toBe(0);
  });

  test("a tab longer than what is read says the search did not cover it", async () => {
    const big = leads();
    for (let i = 0; i < 2100; i++) big.rows.push([`n${i}`, "", "novo", ""]);
    const { tool } = setup(["sheets_find_rows"], { tabs: [big] });
    const out = parse(
      await tool("sheets_find_rows")({ column: "Status", value: "novo" }),
    );
    expect(out.incomplete).toBe(true);
  });
});

describe("google sheets: an answer past the read cap", () => {
  test("is refused, and the rest of it is never pulled", async () => {
    const fake = new FakeSheets(SID, [leads()]);
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const huge = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).includes("/values/")) return fake.fetch(input, init);
      return new Response(
        new ReadableStream({
          pull(c) {
            if (pulled >= 20 * 1024 * 1024) return c.close();
            pulled += chunk.byteLength;
            c.enqueue(chunk);
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { tool } = setup(["sheets_find_rows"], { ctx: { fetchImpl: huge } });
    const out = await tool("sheets_find_rows")({});
    expect(out.toLowerCase()).toContain("too large");
    expect(pulled).toBeLessThan(2 * 1024 * 1024);
  });
});

describe("google sheets: the config a write may store", () => {
  test("a create that sends no config at all is refused before anything is stored", async () => {
    // A client that is never reached: the refusal has to come before the row is written.
    const untouchable = new Proxy(
      {},
      {
        get() {
          throw new Error("the database was reached");
        },
      },
    ) as unknown as PrismaClient;
    const err = await createIntegrationInstance(
      { tenantId: 1n, userId: null, role: "TENANT_ADMIN" },
      { catalogType: "GOOGLE_SHEETS", name: "Leads" },
      untouchable,
    ).then(
      () => null,
      (e: { field?: string; translationKey?: string }) =>
        `${e.field} ${e.translationKey}`,
    );
    expect(err).toBe(
      "config.spreadsheetId errors.integrationSheetsConfigMissing",
    );
  });

  test("a spreadsheet URL in the id field is refused naming the field", () => {
    expect(() =>
      assertIntegrationWritable("GOOGLE_SHEETS", {
        config: {
          spreadsheetId: `https://docs.google.com/spreadsheets/d/${SID}/edit`,
        },
      }),
    ).toThrow(/spreadsheetId/);
  });

  test("a tab id that is not a whole number is refused naming the field", () => {
    expect(() =>
      assertIntegrationWritable("GOOGLE_SHEETS", {
        config: { spreadsheetId: SID, sheetId: "Leads" },
      }),
    ).toThrow(/sheetId/);
  });

  test("an id and a tab id are accepted", () => {
    expect(() =>
      assertIntegrationWritable("GOOGLE_SHEETS", {
        config: { spreadsheetId: SID, sheetId: 0, sheetTitle: "Leads" },
      }),
    ).not.toThrow();
  });

  test("a config without the spreadsheet or the tab is refused as missing, naming the field", () => {
    const refusal = (config: Record<string, unknown>) => {
      try {
        assertIntegrationWritable("GOOGLE_SHEETS", { config });
      } catch (e) {
        const err = e as { field?: string; translationKey?: string };
        return `${err.field} ${err.translationKey}`;
      }
      return "accepted";
    };
    for (const config of [
      { spreadsheetId: "", sheetId: 777 },
      { spreadsheetId: "  ", sheetId: 777 },
      { sheetId: 777 },
      { spreadsheetId: null, sheetId: 777 },
    ]) {
      expect(refusal(config)).toBe(
        "config.spreadsheetId errors.integrationSheetsConfigMissing",
      );
    }
    for (const config of [
      { spreadsheetId: SID, sheetId: null },
      { spreadsheetId: SID },
    ]) {
      expect(refusal(config)).toBe(
        "config.sheetId errors.integrationSheetsConfigMissing",
      );
    }
  });
});

// The 403 Google sends when the Sheets API is turned off in the OAuth client's Cloud project, in the
// current shape (`details[]`) and the older one (`errors[]`).
const ACTIVATION =
  "https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=123";
function disabled(activationUrl: string = ACTIVATION) {
  return {
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          metadata: { activationUrl },
        },
      ],
    },
  };
}
const legacyDisabled = {
  error: { code: 403, errors: [{ reason: "accessNotConfigured" }] },
};
function answering(body: unknown) {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("google sheets: an API turned off in the Cloud project", () => {
  test("says to enable the API, with Google's activation link, instead of reconnecting", async () => {
    const { tool } = setup(["sheets_find_rows"], {
      ctx: { fetchImpl: answering(disabled()) },
    });
    const out = await tool("sheets_find_rows")({});
    expect(out).toContain("turned off");
    expect(out).toContain(ACTIVATION);
    expect(out).not.toContain("Sheets scope");
  });

  test("the older accessNotConfigured shape points at the API's console page", async () => {
    const { tool } = setup(["sheets_append_row"], {
      ctx: { fetchImpl: answering(legacyDisabled) },
    });
    const out = await tool("sheets_append_row")({
      values: [{ column: "Nome", value: "E" }],
    });
    expect(out).toContain(
      "https://console.cloud.google.com/apis/library/sheets.googleapis.com",
    );
  });

  test("an activation link outside the Cloud console is not repeated", async () => {
    const { tool } = setup(["sheets_find_rows"], {
      ctx: { fetchImpl: answering(disabled("https://evil.example/enable")) },
    });
    const out = await tool("sheets_find_rows")({});
    expect(out).not.toContain("evil.example");
    expect(out).toContain(
      "https://console.cloud.google.com/apis/library/sheets.googleapis.com",
    );
  });

  test("any other 403 keeps the scope sentence", async () => {
    const { tool } = setup(["sheets_find_rows"], {
      ctx: { fetchImpl: answering({ error: { code: 403 } }) },
    });
    const out = await tool("sheets_find_rows")({});
    expect(out).toContain("Sheets scope");
    expect(out).not.toContain("turned off");
  });
});
