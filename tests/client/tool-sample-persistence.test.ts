/// <reference lib="dom" />

import { beforeEach, describe, expect, it } from "bun:test";
import {
  forgetToolSample,
  forgetToolSamples,
  recallToolSample,
  rememberToolSample,
  sampleEpoch,
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
    rememberToolSample("42", { text: RESPONSE, status: 404 }, sampleEpoch());
    const form = formFromTool(toolRow());
    expect(form.sample).toBe(RESPONSE);
    expect(form.sampleStatus).toBe(404);
  });

  it("is per tool, so one tool's response is never offered for another", () => {
    rememberToolSample("42", { text: RESPONSE, status: null }, sampleEpoch());
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
    rememberToolSample("42", { text: RESPONSE, status: 200 }, sampleEpoch());
    forgetToolSamples();
    rememberToolSample("42", { text: RESPONSE, status: 200 }, sampleEpoch());
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
    rememberToolSample("7", { text: RESPONSE, status: 200 }, sampleEpoch());
    expect(recallToolSample("7")).toEqual({ text: RESPONSE, status: 200 });
  });

  it("drops rather than keeping a previous response when the new one is too large", () => {
    rememberToolSample("7", { text: RESPONSE, status: null }, sampleEpoch());
    rememberToolSample(
      "7",
      { text: "x".repeat(600_000), status: null },
      sampleEpoch(),
    );
    expect(recallToolSample("7")).toBeNull();
  });

  it("drops on an empty sample, and on one that is only whitespace", () => {
    rememberToolSample("7", { text: RESPONSE, status: null }, sampleEpoch());
    rememberToolSample("7", null, sampleEpoch());
    expect(recallToolSample("7")).toBeNull();
    // Whitespace is the same thing to the operator and a different thing to `null`, and the module
    // owns that judgement rather than trusting its one caller to keep making it.
    rememberToolSample("7", { text: RESPONSE, status: null }, sampleEpoch());
    rememberToolSample("7", { text: "  \n ", status: 200 }, sampleEpoch());
    expect(recallToolSample("7")).toBeNull();
  });

  // BOUNDED, because this holds response bodies for the life of the tab. The entry that goes is the
  // least recently SAVED, not the first one ever saved: re-saving a tool has to keep it alive, or
  // the tool being worked on is the one evicted while seven abandoned ones stay.
  it("keeps the working set and evicts the least recently saved", () => {
    for (let i = 1; i <= 8; i++)
      rememberToolSample(
        String(i),
        { text: `{"i":${i}}`, status: null },
        sampleEpoch(),
      );
    // Tool 1 is the oldest; saving it again makes tool 2 the oldest instead.
    rememberToolSample("1", { text: '{"i":1}', status: null }, sampleEpoch());
    rememberToolSample("9", { text: '{"i":9}', status: null }, sampleEpoch());
    expect(recallToolSample("2")).toBeNull();
    expect(recallToolSample("1")).toEqual({ text: '{"i":1}', status: null });
    expect(recallToolSample("9")).toEqual({ text: '{"i":9}', status: null });
  });

  // A SUPER_ADMIN switches tenants without reloading, and the tool ids of two tenants are two
  // sequences that overlap. Keyed by the id alone, tool 7 of the tenant just left would be offered
  // as tool 7 of the one just entered.
  it("does not offer one tenant's response under another tenant's tool", () => {
    localStorage.setItem("@app:active-tenant", "3");
    rememberToolSample("7", { text: RESPONSE, status: 200 }, sampleEpoch());
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
        rememberToolSample(
          "7",
          { text: RESPONSE, status: null },
          sampleEpoch(),
        ),
      ).not.toThrow();
      expect(recallToolSample("7")).toEqual({ text: RESPONSE, status: null });
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
    }
  });

  it("is emptied when the session ends, so a signed-out tab holds no customer data", () => {
    rememberToolSample("7", { text: RESPONSE, status: 200 }, sampleEpoch());
    forgetToolSamples();
    expect(recallToolSample("7")).toBeNull();
  });

  it("drops one tool's entry when that tool is gone", () => {
    rememberToolSample("7", { text: RESPONSE, status: 200 }, sampleEpoch());
    rememberToolSample("8", { text: RESPONSE, status: 200 }, sampleEpoch());
    forgetToolSample("7");
    expect(recallToolSample("7")).toBeNull();
    expect(recallToolSample("8")).not.toBeNull();
  });
});

// A SAVE IS IN FLIGHT FOR AS LONG AS THE OPERATOR'S API TAKES, and both things that end a sample's
// life can happen inside that window. The response then arrives and writes it back in, which is a
// deletion and a logout being undone by a request that was already on the wire.
describe("a save that lands after the sample's life ended", () => {
  it("does not put it back after the tool was deleted", () => {
    const epoch = sampleEpoch();
    forgetToolSample("7");
    rememberToolSample("7", { text: RESPONSE, status: 200 }, epoch);
    expect(recallToolSample("7")).toBeNull();
  });

  it("does not put it back after the session ended", () => {
    const epoch = sampleEpoch();
    forgetToolSamples();
    rememberToolSample("7", { text: RESPONSE, status: 200 }, epoch);
    expect(recallToolSample("7")).toBeNull();
  });

  it("still writes when nothing cleared while it was out", () => {
    const epoch = sampleEpoch();
    rememberToolSample("7", { text: RESPONSE, status: 200 }, epoch);
    expect(recallToolSample("7")?.text).toBe(RESPONSE);
  });
});

// TWO SOURCE FENCES, and they say so: what they can answer for is a grammar, not intent.
describe("the two seams that have to clear it", () => {
  const DELETE_CALL = /\.v1\.tools\(\s*\{[^}]*\}\s*\)\s*\.delete\(/;
  // The transition to unauthenticated, not the logout REQUEST: a 401 on any call and the socket's
  // auth-loss close both end the session without one, and they are the common paths. `setUser(null)`
  // is what all of them come down to, so that is what is counted.
  const SIGNS_OUT = /setUser\(\s*null\s*\)/;

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
  const CLEARS = /forgetToolSample\s*\(/;
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

  // And losing the session empties the whole map, because a tab left on the login screen would
  // otherwise still hold the responses of the operator who just signed out of it, and the next
  // sign-in on that tab would be offered them.
  it("every transition to unauthenticated empties what the tab remembers", async () => {
    const files = await clientFiles();
    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      const src = strip(await Bun.file(f).text());
      if (!SIGNS_OUT.test(src)) continue;
      sites++;
      if (!FORGETS.test(src)) offenders.push(f);
    }
    // ONE site, and that is the assertion, not a count that happens to be right: an explicit logout
    // that clears the user by itself, beside a `clearUser` that also does, is exactly how one of the
    // two paths ends up not clearing this. A 401 and the socket's auth-loss close both go through
    // the second one.
    expect(sites).toBe(1);
    expect(offenders).toEqual([]);
  });

  // THE EPOCH IS ONLY WORTH ANYTHING IF IT IS READ EARLY. Required by the signature, so `tsc`
  // catches a call that omits it; what `tsc` cannot see is a call that reads it AT THE WRITE, which
  // type-checks and always compares equal to itself. That is a question about ORDER, so it is asked
  // of the source, and asked of the SAVE rather than of the file: `.v1.tools` appears in this module
  // long before `save()` (the load, and the test-request dialog), so a whole-file index compares two
  // unrelated positions and answers about neither.
  it("reads the epoch before the request rather than at the write", async () => {
    const src = codeOnly(
      await Bun.file("src/client/pages/resources/ToolEditModal.tsx").text(),
    );
    const from = src.indexOf("async function save()");
    expect(from).toBeGreaterThan(-1);
    // To the end of that function: the next declaration at the same indent.
    const rest = src.slice(from + 1);
    const to = rest.search(/\n {2}(?:async )?function /);
    const save = to === -1 ? rest : rest.slice(0, to);

    const read = save.indexOf("sampleEpoch()");
    const request = save.indexOf(".v1.tools");
    const write = save.indexOf("rememberToolSample(");
    // All three are inside `save`, so a rename or a move fails here instead of passing on -1s.
    expect(read).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(read).toBeLessThan(request);
    // And the write is handed a NAME: `sampleEpoch()` inline would read it after everything the
    // request took, which is the same as not having it at all.
    const call = save.slice(
      write,
      save.indexOf(")", save.indexOf("epoch", write)),
    );
    expect(call).not.toInclude("sampleEpoch");
    expect(call).toInclude("epoch");
  });

  it("catches a delete that forgets, over the three ways it could look like it did not", () => {
    const forgets = `await api.api.v1.tools({ id: t.id }).delete();`;
    expect(DELETE_CALL.test(strip(forgets))).toBe(true);
    expect(CLEARS.test(strip(forgets))).toBe(false);
    // A comment that remembers is not a call.
    expect(
      CLEARS.test(strip(`${forgets}\n// forgetToolSample(t.id) here`)),
    ).toBe(false);
    // Neither is the import that survives deleting the call, the case the battery caught.
    const importOnly = `import { forgetToolSample } from "@/client/lib/toolSample";\n${forgets}`;
    expect(CLEARS.test(strip(importOnly))).toBe(false);
    // And a real call counts.
    expect(CLEARS.test(strip(`${forgets}\nforgetToolSample(t.id);`))).toBe(
      true,
    );
  });
});
