/// <reference lib="dom" />

import { beforeEach, describe, expect, it } from "bun:test";
import { readLocalSample, writeLocalSample } from "@/client/lib/toolSample";
import {
  formFromTool,
  payloadOf,
} from "@/client/pages/resources/ToolEditModal";
import { fingerprintShape } from "@/modules/tool-definitions/sample-shape";
import { codeOnly } from "@/tests/utils/source-text";

// THE SAMPLE SURVIVES A REOPEN IN TWO HALVES (issue #566): the SHAPE from the row, which every
// machine gets, and the response itself from this browser's storage, which only the machine that
// captured it has. What is asserted here is the seam between them — which half answers when, and
// the one way this could quietly destroy something: a save from a machine that does not have the
// response must not read as "the operator removed the sample".

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
    sampleShape: null,
    ...over,
  } as unknown as AnyTool;
}

// Already redacted, and a FIXED POINT of the redaction: the service runs it again on the way
// in, so a fixture that still moves would be testing the fixture.
const SHAPE = { status: 200, body: { cliente: { nome: "xxx" }, n: 9 } };

beforeEach(() => {
  localStorage.clear();
});

describe("what the editor opens with", () => {
  it("takes the shape from the row when this browser has no response", () => {
    const form = formFromTool(toolRow({ sampleShape: SHAPE }));
    expect(form.sample).toBe("");
    expect(form.sampleStatus).toBeNull();
    expect(form.sampleShape).toEqual(SHAPE);
  });

  it("takes the response itself when this browser kept one, with its status", () => {
    writeLocalSample("42", {
      text: '{"cliente":{"nome":"Ana"}}',
      status: 404,
      shape: fingerprintShape(SHAPE),
    });
    const form = formFromTool(toolRow({ sampleShape: SHAPE }));
    expect(form.sample).toBe('{"cliente":{"nome":"Ana"}}');
    expect(form.sampleStatus).toBe(404);
  });

  // ROUND 1 OF REVIEW: the local entry used to win on tool id alone, so a sample saved from another
  // machine left this one previewing values the tool no longer describes — and its next save would
  // derive a shape from them and overwrite the newer one.
  it("ignores its own copy once the row carries a different shape", () => {
    writeLocalSample("42", {
      text: '{"cliente":{"nome":"Ana"}}',
      status: 200,
      shape: fingerprintShape(SHAPE),
    });
    const newer = { status: 200, body: { cliente: { nome: "xxx" }, novo: 9 } };
    const form = formFromTool(toolRow({ sampleShape: newer }));
    expect(form.sample).toBe("");
    expect(form.sampleShape).toEqual(newer);
  });

  // The jsonb column reorders an object's keys (by length, then bytes), measured on the row this
  // feature writes. Comparing the two sides with a plain JSON.stringify would call every restored
  // sample stale, which is the same defect wearing the opposite sign.
  it("matches a row whose keys came back from jsonb in another order", () => {
    const asWritten = {
      status: 200,
      body: { nome: "xxx", cpf: "xxxxxxxxxxx" },
    };
    const asStored = { status: 200, body: { cpf: "xxxxxxxxxxx", nome: "xxx" } };
    writeLocalSample("42", {
      text: '{"nome":"Ana","cpf":"12345678901"}',
      status: 200,
      shape: fingerprintShape(asWritten),
    });
    expect(formFromTool(toolRow({ sampleShape: asStored })).sample).toBe(
      '{"nome":"Ana","cpf":"12345678901"}',
    );
  });

  it("reads a row that carries no shape, and one that carries something else, as no sample", () => {
    expect(formFromTool(toolRow()).sampleShape).toBeNull();
    expect(
      formFromTool(toolRow({ sampleShape: { nope: 1 } })).sampleShape,
    ).toBeNull();
  });
});

describe("what the editor saves", () => {
  it("derives the shape from the response on screen, storing none of it", () => {
    const form = {
      ...formFromTool(toolRow()),
      sample: '{"cliente":{"nome":"Ana"},"preco":150}',
      sampleStatus: 200,
    };
    expect(payloadOf(form)?.sampleShape).toEqual({
      status: 200,
      body: { cliente: { nome: "xxx" }, preco: 999 },
    });
  });

  it("does NOT erase the stored shape when the response is not on this machine", () => {
    const form = formFromTool(toolRow({ sampleShape: SHAPE }));
    expect(form.sample).toBe("");
    expect(payloadOf(form)?.sampleShape).toEqual(SHAPE);
  });

  it("keeps the stored shape while the operator is mid-paste and the text does not parse", () => {
    const form = {
      ...formFromTool(toolRow({ sampleShape: SHAPE })),
      sample: '{"cliente":{"nome":',
    };
    expect(payloadOf(form)?.sampleShape).toEqual(SHAPE);
  });

  it("is a change the discard dialog can see, because it is part of the form", () => {
    const opened = formFromTool(toolRow({ sampleShape: SHAPE }));
    const pasted = { ...opened, sample: '{"a":"b"}' };
    expect(JSON.stringify(pasted)).not.toBe(JSON.stringify(opened));
  });
});

describe("the browser's half", () => {
  it("round-trips a response and its status", () => {
    writeLocalSample("7", { text: '{"a":1}', status: 200, shape: "f1" });
    expect(readLocalSample("7", "f1")).toEqual({
      text: '{"a":1}',
      status: 200,
      shape: "f1",
    });
  });

  it("is per tool, so one tool's response is never offered for another", () => {
    writeLocalSample("7", { text: '{"a":1}', status: null, shape: "f1" });
    expect(readLocalSample("8", "f1")).toBeNull();
  });

  it("clears rather than keeping a previous response when the new one is too large", () => {
    writeLocalSample("7", { text: '{"a":1}', status: null, shape: "f1" });
    writeLocalSample("7", {
      text: "x".repeat(600_000),
      status: null,
      shape: "f1",
    });
    expect(readLocalSample("7", "f1")).toBeNull();
  });

  it("clears on an empty sample", () => {
    writeLocalSample("7", { text: '{"a":1}', status: null, shape: "f1" });
    writeLocalSample("7", null);
    expect(readLocalSample("7", "f1")).toBeNull();
  });

  it("reads nothing out of a value that is not a stored sample", () => {
    localStorage.setItem("@app:toolSample:7", "not json");
    expect(readLocalSample("7", "f1")).toBeNull();
    localStorage.setItem("@app:toolSample:7", JSON.stringify({ status: 200 }));
    expect(readLocalSample("7", "f1")).toBeNull();
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
        writeLocalSample("7", { text: "x", status: null, shape: "f1" }),
      ).not.toThrow();
      expect(readLocalSample("7", "f1")).toBeNull();
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
    }
  });
});

// A SOURCE FENCE, and it says so: what it can answer for is a grammar, not intent. The invariant is
// that deleting an HTTP tool takes this browser's copy of its response with it — left behind, a
// customer's response outlives the row it described, and tool ids come from a sequence, so a later
// tool could be handed the deleted one's values (round 1 of review). There is one delete site today;
// the fence is for the next one.
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
    // Neither is the import that survives deleting the call — the case the battery caught.
    const importOnly = `import { writeLocalSample } from "@/client/lib/toolSample";\n${forgets}`;
    expect(CLEARS.test(strip(importOnly))).toBe(false);
    // And a real call counts.
    expect(
      CLEARS.test(strip(`${forgets}\nwriteLocalSample(t.id, null);`)),
    ).toBe(true);
  });
});
