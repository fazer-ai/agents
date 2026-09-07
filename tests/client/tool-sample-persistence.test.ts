/// <reference lib="dom" />

import { beforeEach, describe, expect, it } from "bun:test";
import { readLocalSample, writeLocalSample } from "@/client/lib/toolSample";
import {
  formFromTool,
  payloadOf,
} from "@/client/pages/resources/ToolEditModal";

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

const SHAPE = { status: 200, body: { cliente: { nome: "xxx" }, n: 0 } };

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
    writeLocalSample("42", { text: '{"cliente":{"nome":"Ana"}}', status: 404 });
    const form = formFromTool(toolRow({ sampleShape: SHAPE }));
    expect(form.sample).toBe('{"cliente":{"nome":"Ana"}}');
    expect(form.sampleStatus).toBe(404);
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
      body: { cliente: { nome: "xxx" }, preco: 0 },
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
    writeLocalSample("7", { text: '{"a":1}', status: 200 });
    expect(readLocalSample("7")).toEqual({ text: '{"a":1}', status: 200 });
  });

  it("is per tool, so one tool's response is never offered for another", () => {
    writeLocalSample("7", { text: '{"a":1}', status: null });
    expect(readLocalSample("8")).toBeNull();
  });

  it("clears rather than keeping a previous response when the new one is too large", () => {
    writeLocalSample("7", { text: '{"a":1}', status: null });
    writeLocalSample("7", { text: "x".repeat(600_000), status: null });
    expect(readLocalSample("7")).toBeNull();
  });

  it("clears on an empty sample", () => {
    writeLocalSample("7", { text: '{"a":1}', status: null });
    writeLocalSample("7", null);
    expect(readLocalSample("7")).toBeNull();
  });

  it("reads nothing out of a value that is not a stored sample", () => {
    localStorage.setItem("@app:toolSample:7", "not json");
    expect(readLocalSample("7")).toBeNull();
    localStorage.setItem("@app:toolSample:7", JSON.stringify({ status: 200 }));
    expect(readLocalSample("7")).toBeNull();
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
