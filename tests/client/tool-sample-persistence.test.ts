/// <reference lib="dom" />

import { beforeEach, describe, expect, it } from "bun:test";
import { readLocalSample, writeLocalSample } from "@/client/lib/toolSample";
import {
  formFromTool,
  payloadOf,
} from "@/client/pages/resources/ToolEditModal";
import { codeOnly } from "@/tests/utils/source-text";

// THE SAMPLE COMES BACK FROM THIS BROWSER, AND FROM NOWHERE ELSE (issue #566). What is asserted here
// is the seam: that the editor opens with what this machine kept, that the save keeps it, and, the
// one that matters most, that none of it reaches the server, which is the invariant the whole
// design exists to hold without qualification.

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
  localStorage.clear();
});

describe("what the editor opens with", () => {
  it("offers nothing when this browser kept nothing, which is what a second machine gets", () => {
    const form = formFromTool(toolRow());
    expect(form.sample).toBe("");
    expect(form.sampleStatus).toBeNull();
  });

  it("takes the response this browser kept, with the status it came back under", () => {
    writeLocalSample("42", { text: RESPONSE, status: 404 });
    const form = formFromTool(toolRow());
    expect(form.sample).toBe(RESPONSE);
    expect(form.sampleStatus).toBe(404);
  });

  it("is per tool, so one tool's response is never offered for another", () => {
    writeLocalSample("42", { text: RESPONSE, status: null });
    expect(formFromTool(toolRow({ id: "43" })).sample).toBe("");
  });
});

// THE INVARIANT. Not "the values are redacted": nothing about the sample is sent at all, which is
// what lets the module header say "we never store the customer's response" with no qualification.
describe("nothing about the sample reaches the server", () => {
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

describe("the browser's copy", () => {
  it("round-trips a response and its status", () => {
    writeLocalSample("7", { text: RESPONSE, status: 200 });
    expect(readLocalSample("7")).toEqual({ text: RESPONSE, status: 200 });
  });

  it("clears rather than keeping a previous response when the new one is too large", () => {
    writeLocalSample("7", { text: RESPONSE, status: null });
    writeLocalSample("7", { text: "x".repeat(600_000), status: null });
    expect(readLocalSample("7")).toBeNull();
  });

  it("clears on an empty sample, and on one that is only whitespace", () => {
    writeLocalSample("7", { text: RESPONSE, status: null });
    writeLocalSample("7", null);
    expect(readLocalSample("7")).toBeNull();
    // Whitespace is the same thing to the operator and a different thing to `null`, and the module
    // owns that judgement rather than trusting its one caller to keep making it.
    writeLocalSample("7", { text: RESPONSE, status: null });
    writeLocalSample("7", { text: "  \n ", status: 200 });
    expect(readLocalSample("7")).toBeNull();
  });

  // WHAT COMES BACK IS A `LocalSample`, WHATEVER IS IN THE STORE. The entry is a string another
  // version of this app, an extension, or the operator's own console can have written, and the two
  // fields are both read as their type downstream: `sample` goes into a text control and `status`
  // is compared numerically to decide whether the body is read verbatim. A string `"200"` there
  // would answer that comparison wrong rather than throw.
  it("reads nothing out of a value that is not a stored sample", () => {
    localStorage.setItem("@app:toolSample:7", "not json");
    expect(readLocalSample("7")).toBeNull();
    localStorage.setItem("@app:toolSample:7", JSON.stringify({ status: 200 }));
    expect(readLocalSample("7")).toBeNull();
    // A `text` that is not a string is not a sample either, and is refused rather than handed on.
    localStorage.setItem("@app:toolSample:7", JSON.stringify({ text: 42 }));
    expect(readLocalSample("7")).toBeNull();
    localStorage.setItem("@app:toolSample:7", JSON.stringify(["x"]));
    expect(readLocalSample("7")).toBeNull();
  });

  it("drops a status that is not a number rather than passing the string on", () => {
    localStorage.setItem(
      "@app:toolSample:7",
      JSON.stringify({ text: RESPONSE, status: "200" }),
    );
    expect(readLocalSample("7")).toEqual({ text: RESPONSE, status: null });
  });

  // ROUND 2 OF REVIEW: `setItem` can throw on a full origin quota, and the previous entry used to
  // survive that, so the next open restored ANOTHER response's values as though this save had
  // persisted. Degrading to no sample is honest; degrading to a stale one is not.
  //
  // The whole object is swapped rather than `localStorage.setItem = …`: happy-dom backs `Storage`
  // with a Proxy, so assigning the property STORES AN ITEM CALLED `setItem` and the real method
  // keeps running. Measured here: the stubbed version of this test passed with the write intact.
  it("leaves nothing behind when the write itself fails", () => {
    writeLocalSample("7", { text: RESPONSE, status: 200 });
    const kept = new Map<string, string>();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null) kept.set(k, localStorage.getItem(k) ?? "");
    }
    // Seeded from the real entry, so this reads back exactly what a quota failure would leave.
    expect(kept.size).toBe(1);
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const full = {
      getItem: (k: string) => kept.get(k) ?? null,
      removeItem: (k: string) => void kept.delete(k),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => full,
    });
    try {
      expect(() =>
        writeLocalSample("7", { text: '{"outro":"cliente"}', status: 200 }),
      ).not.toThrow();
      expect(readLocalSample("7")).toBeNull();
      // And it is gone from the store itself, not merely unreadable.
      expect(kept.size).toBe(0);
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
    }
  });

  it("survives a browser that refuses storage entirely", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(() =>
        writeLocalSample("7", { text: "x", status: null }),
      ).not.toThrow();
      expect(readLocalSample("7")).toBeNull();
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
    }
  });
});

// A SOURCE FENCE, and it says so: what it can answer for is a grammar, not intent. The invariant is
// that deleting an HTTP tool takes this browser's copy of its response with it. Left behind, a
// customer's response outlives the row it described, and tool ids come from a sequence, so a later
// tool could be handed the deleted one's values. There is one delete site today; the fence is for
// the next one.
describe("every place that deletes an HTTP tool clears the browser's copy", () => {
  const DELETE_CALL = /\.v1\.tools\(\s*\{[^}]*\}\s*\)\s*\.delete\(/;

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
  const CLEARS = /writeLocalSample\s*\(/;

  async function clientFiles(): Promise<string[]> {
    const out: string[] = [];
    for await (const f of new Bun.Glob("src/client/**/*.{ts,tsx}").scan("."))
      out.push(f);
    return out;
  }

  it("holds over the tree", async () => {
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

  it("catches a delete that forgets, over the three ways it could look like it did not", () => {
    const forgets = `await api.api.v1.tools({ id: t.id }).delete();`;
    expect(DELETE_CALL.test(strip(forgets))).toBe(true);
    expect(CLEARS.test(strip(forgets))).toBe(false);
    // A comment that remembers is not a call.
    expect(
      CLEARS.test(strip(`${forgets}\n// writeLocalSample(t.id, null) here`)),
    ).toBe(false);
    // Neither is the import that survives deleting the call, the case the battery caught.
    const importOnly = `import { writeLocalSample } from "@/client/lib/toolSample";\n${forgets}`;
    expect(CLEARS.test(strip(importOnly))).toBe(false);
    // And a real call counts.
    expect(
      CLEARS.test(strip(`${forgets}\nwriteLocalSample(t.id, null);`)),
    ).toBe(true);
  });
});
