/// <reference lib="dom" />

import { beforeEach, describe, expect, it } from "bun:test";
import {
  forgetToolSamples,
  recallToolSample,
  rememberToolSample,
} from "@/client/lib/toolSample";
import {
  formFromTool,
  payloadOf,
} from "@/client/pages/resources/ToolEditModal";
import { codeOnly } from "@/tests/utils/source-text";

// THE SAMPLE COMES BACK FROM THIS TAB, AND FROM NOWHERE ELSE (issue #566). What is asserted here is
// the seam: that the editor opens with what this tab remembers, that the save is what makes it
// remember, and, the one that matters most, that none of it is written down, in the request or in
// any store. That is the invariant the whole design exists to hold without qualification.

type AnyTool = Parameters<typeof formFromTool>[0];

function toolRow(over: Partial<Record<string, unknown>> = {}): AnyTool {
  return {
    id: "42",
    name: "consulta",
    label: "Consulta",
    description: null,
    method: "POST",
    urlTemplate: "https://api.example.com/x",
    allowedHosts: ["api.example.com"],
    headers: {},
    inputSchema: {},
    outputSchema: {},
    query: {},
    body: {},
    credentialRef: null,
    enabled: true,
    expectedStatuses: [],
    ackEnabled: false,
    ackMessage: null,
    appointment: null,
    ...over,
  } as unknown as AnyTool;
}

const RESPONSE = '{"cliente":{"nome":"Ana","cpf":"12345678901"}}';

beforeEach(() => {
  forgetToolSamples();
  localStorage.clear();
});

describe("what the editor opens with", () => {
  it("offers nothing when this tab remembers nothing, which is what a reload gets", () => {
    const form = formFromTool(toolRow());
    expect(form.sample).toBe("");
    expect(form.sampleStatus).toBeNull();
  });

  it("takes the response this tab kept, with the status it came back under", () => {
    rememberToolSample("42", { text: RESPONSE, status: 404 });
    const form = formFromTool(toolRow());
    expect(form.sample).toBe(RESPONSE);
    expect(form.sampleStatus).toBe(404);
  });

  it("is per tool, so one tool's response is never offered for another", () => {
    rememberToolSample("42", { text: RESPONSE, status: null });
    expect(formFromTool(toolRow({ id: "43" })).sample).toBe("");
  });
});

// THE INVARIANT, IN BOTH DIRECTIONS. Nothing about the sample is sent, and nothing about it is
// written down: a value kept only for the life of the tab is what lets "we never store the
// customer's response" stand with no qualification.
describe("nothing about the sample is sent or stored", () => {
  it("is absent from the body a save sends, response and all", () => {
    const form = {
      ...formFromTool(toolRow()),
      sample: RESPONSE,
      sampleStatus: 200,
    };
    const payload = payloadOf(form);
    const sent = JSON.stringify(payload);
    expect(sent).not.toInclude("Ana");
    expect(sent).not.toInclude("12345678901");
    expect(sent).not.toInclude("sample");
    // …and the fields the save DOES carry are still there, so this is not passing on an empty body.
    expect(payload?.label).toBe("Consulta");
  });

  // THE SECOND REFUSAL, and the reason this module is a Map and not a `localStorage` key: the
  // standing rule in `docs/ui.md` says localStorage is not admissible for product data, and it names
  // this case, "History, save, remember, resume". Asserted over BOTH stores rather than over the one
  // the module happens to use, because a value written to either outlives the session and every
  // deletion that does not go through this browser.
  it("writes nothing into browser storage", () => {
    // A SNAPSHOT ON BOTH SIDES, not "the store is empty": the suite shares one global environment
    // and other files leave entries behind, so asserting emptiness measures them and not this. What
    // this owns is the DIFFERENCE, which is nothing.
    const dump = (store: Storage) =>
      JSON.stringify(
        Array.from({ length: store.length }, (_, i) => {
          const k = store.key(i) ?? "";
          return [k, store.getItem(k) ?? ""];
        }).sort(),
      );
    const before = [dump(localStorage), dump(sessionStorage)];
    rememberToolSample("42", { text: RESPONSE, status: 200 });
    forgetToolSamples();
    rememberToolSample("42", { text: RESPONSE, status: 200 });
    const after = [dump(localStorage), dump(sessionStorage)];
    expect(after).toEqual(before);
    // And in case a future entry arrives carrying it, said plainly: no store holds the response.
    expect(after.join("")).not.toInclude("Ana");
    expect(after.join("")).not.toInclude("12345678901");
    // The value is there to be recalled, so this is not passing because nothing was remembered.
    expect(recallToolSample("42")?.text).toBe(RESPONSE);
  });

  it("is part of the form, and still changes nothing about what would be written", () => {
    const opened = formFromTool(toolRow());
    const pasted = { ...opened, sample: RESPONSE };
    // Pasting is an unsaved change the discard dialog can see…
    expect(JSON.stringify(pasted)).not.toBe(JSON.stringify(opened));
    // …and the body is identical either way.
    expect(JSON.stringify(payloadOf(pasted))).toBe(
      JSON.stringify(payloadOf(opened)),
    );
  });
});

describe("what the tab remembers", () => {
  it("round-trips a response and its status", () => {
    rememberToolSample("7", { text: RESPONSE, status: 200 });
    expect(recallToolSample("7")).toEqual({ text: RESPONSE, status: 200 });
  });

  it("drops rather than keeping a previous response when the new one is too large", () => {
    rememberToolSample("7", { text: RESPONSE, status: null });
    rememberToolSample("7", { text: "x".repeat(600_000), status: null });
    expect(recallToolSample("7")).toBeNull();
  });

  it("drops on an empty sample, and on one that is only whitespace", () => {
    rememberToolSample("7", { text: RESPONSE, status: null });
    rememberToolSample("7", null);
    expect(recallToolSample("7")).toBeNull();
    // Whitespace is the same thing to the operator and a different thing to `null`, and the module
    // owns that judgement rather than trusting its one caller to keep making it.
    rememberToolSample("7", { text: RESPONSE, status: null });
    rememberToolSample("7", { text: "  \n ", status: 200 });
    expect(recallToolSample("7")).toBeNull();
  });

  // BOUNDED, because this holds response bodies for the life of the tab. The entry that goes is the
  // least recently SAVED, not the first one ever saved: re-saving a tool has to keep it alive, or
  // the tool being worked on is the one evicted while seven abandoned ones stay.
  it("keeps the working set and evicts the least recently saved", () => {
    for (let i = 1; i <= 8; i++)
      rememberToolSample(String(i), { text: `{"i":${i}}`, status: null });
    // Tool 1 is the oldest; saving it again makes tool 2 the oldest instead.
    rememberToolSample("1", { text: '{"i":1}', status: null });
    rememberToolSample("9", { text: '{"i":9}', status: null });
    expect(recallToolSample("2")).toBeNull();
    expect(recallToolSample("1")).toEqual({ text: '{"i":1}', status: null });
    expect(recallToolSample("9")).toEqual({ text: '{"i":9}', status: null });
  });

  // A SUPER_ADMIN switches tenants without reloading, and the tool ids of two tenants are two
  // sequences that overlap. Keyed by the id alone, tool 7 of the tenant just left would be offered
  // as tool 7 of the one just entered.
  it("does not offer one tenant's response under another tenant's tool", () => {
    localStorage.setItem("@app:active-tenant", "3");
    rememberToolSample("7", { text: RESPONSE, status: 200 });
    localStorage.setItem("@app:active-tenant", "4");
    expect(recallToolSample("7")).toBeNull();
    localStorage.setItem("@app:active-tenant", "3");
    expect(recallToolSample("7")).toEqual({ text: RESPONSE, status: 200 });
  });

  it("still works in a browser that refuses storage entirely", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(() =>
        rememberToolSample("7", { text: RESPONSE, status: null }),
      ).not.toThrow();
      expect(recallToolSample("7")).toEqual({ text: RESPONSE, status: null });
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
    }
  });

  it("is emptied on logout, so a signed-out tab holds no customer data", () => {
    rememberToolSample("7", { text: RESPONSE, status: 200 });
    forgetToolSamples();
    expect(recallToolSample("7")).toBeNull();
  });
});

// TWO SOURCE FENCES, and they say so: what they can answer for is a grammar, not intent.
describe("the two seams that have to clear it", () => {
  const DELETE_CALL = /\.v1\.tools\(\s*\{[^}]*\}\s*\)\s*\.delete\(/;
  const LOGOUT = /auth\.logout\.post\(/;

  // `codeOnly` rather than a stripper written here: comments AND string contents out, which is the
  // spelling this repo's own fence over sweeps requires (`tests/lib/source-text.test.ts`), and it
  // caught this file for rolling its own. What is being matched is a code SHAPE, so a literal
  // spelling it is prose by another name.
  //
  // The IMPORT goes too, and that is not belt-and-braces: the mutation battery caught this fence
  // green after the call was deleted, because the file still imported the name. A fence that asks
  // "is it mentioned?" answers yes for the import that survives the deletion it exists to catch.
  const strip = (src: string) =>
    codeOnly(src).replace(/^\s*import\s[\s\S]*?from\s+"[^"]*";$/gm, "");
  const CLEARS = /rememberToolSample\s*\(/;
  const FORGETS = /forgetToolSamples\s*\(/;

  async function clientFiles(): Promise<string[]> {
    const out: string[] = [];
    for await (const f of new Bun.Glob("src/client/**/*.{ts,tsx}").scan("."))
      out.push(f);
    return out;
  }

  // Deleting the tool takes the tab's copy with it. A response left behind describes a row that is
  // gone, and it is the customer's data sitting in a tab nobody is using it in.
  it("every place that deletes an HTTP tool clears what the tab remembers", async () => {
    const files = await clientFiles();
    // A scan that reaches nothing is a broken matcher, not a clean tree.
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      const src = strip(await Bun.file(f).text());
      if (!DELETE_CALL.test(src)) continue;
      sites++;
      if (!CLEARS.test(src)) offenders.push(f);
    }
    // The site this round wired, so a matcher that stopped matching fails here instead of passing.
    expect(sites).toBe(1);
    expect(offenders).toEqual([]);
  });

  // And logging out empties it, because a tab left open on the login screen would otherwise still
  // hold the responses of the operator who just signed out of it.
  it("every place that logs out empties what the tab remembers", async () => {
    const files = await clientFiles();
    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      const src = strip(await Bun.file(f).text());
      if (!LOGOUT.test(src)) continue;
      sites++;
      if (!FORGETS.test(src)) offenders.push(f);
    }
    expect(sites).toBe(1);
    expect(offenders).toEqual([]);
  });

  it("catches a delete that forgets, over the three ways it could look like it did not", () => {
    const forgets = `await api.api.v1.tools({ id: t.id }).delete();`;
    expect(DELETE_CALL.test(strip(forgets))).toBe(true);
    expect(CLEARS.test(strip(forgets))).toBe(false);
    // A comment that remembers is not a call.
    expect(
      CLEARS.test(strip(`${forgets}\n// rememberToolSample(t.id, null) here`)),
    ).toBe(false);
    // Neither is the import that survives deleting the call, the case the battery caught.
    const importOnly = `import { rememberToolSample } from "@/client/lib/toolSample";\n${forgets}`;
    expect(CLEARS.test(strip(importOnly))).toBe(false);
    // And a real call counts.
    expect(
      CLEARS.test(strip(`${forgets}\nrememberToolSample(t.id, null);`)),
    ).toBe(true);
  });
});
