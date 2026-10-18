/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TFunction } from "i18next";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import {
  contractExamples,
  contractMarkdown,
  contractParts,
  ExternalCheckContract,
} from "@/client/pages/agents/ExternalCheckContract";
import {
  buildExternalRequest,
  readExternalAnswer,
} from "@/modules/guardrails/external";

// The modal is the only place an operator reads the wire format from the console, so its examples
// are held to the code that sends and reads it: a field renamed there fails here instead of leaving
// the screen describing a request nobody sends, or an answer the reader turns into `malformed`.
const ID = "9f2c…e41a";
const keys = (o: object) => Object.keys(o).sort().join(",");
// A t that reads one catalog, so each language's examples are checked as that language renders them.
const tFrom = (catalog: object) =>
  ((key: string, fallback: string) => {
    const v = key
      .split(".")
      .reduce<unknown>(
        (o, k) => (o as Record<string, unknown> | undefined)?.[k],
        catalog,
      );
    return typeof v === "string" ? v : fallback;
  }) as unknown as TFunction;
const LANGS = [
  ["en", tFrom(en)],
  ["pt-BR", tFrom(ptBR)],
] as const;

describe.each(LANGS)("external check contract examples (%s)", (_, t) => {
  const ex = contractExamples(t);
  test("the request example has the fields the agent sends", () => {
    const example = JSON.parse(ex.request);
    const sent = buildExternalRequest(
      {
        tenantId: 1,
        agentId: 2,
        conversationId: 3,
        chatwootConversationId: 42,
        turnId: "t",
        customerMessage: "hi",
      } as never,
      {
        text: "x",
        attachments: [],
        model: "primary",
        toolCalls: [
          {
            name: "n",
            args: {},
            result: "r",
            argsSize: 2,
            resultSize: 1,
            isError: false,
          },
        ],
      },
    ) as Record<string, unknown> & {
      candidate: object;
      toolCalls: object[];
    };
    expect(keys(example)).toBe(keys(sent));
    expect(keys(example.candidate)).toBe(keys(sent.candidate));
    expect(keys(example.toolCalls[0])).toBe(keys(sent.toolCalls[0] ?? {}));
    expect(example.type).toBe(sent.type);
    expect(example.version).toBe(sent.version);
  });

  test("each answer example is read as the decision it shows", () => {
    const read = (body: string) => {
      const a = readExternalAnswer(200, body, ID);
      return a.ok ? a.decision : `failed:${a.cause}`;
    };
    expect(read(ex.allow)).toBe("allow");
    expect(read(ex.replace)).toBe("replace");
    expect(read(ex.block)).toBe("block");
  });

  test("the Markdown copy carries every example in a fence", () => {
    const md = contractMarkdown("T", contractParts(t));
    for (const code of [ex.request, ex.allow, ex.replace, ex.block])
      expect(md.includes(`\`\`\`json\n${code}\n\`\`\``)).toBe(true);
    expect(md.includes(`\`\`\`js\n${ex.verify}\n\`\`\``)).toBe(true);
  });
});

test("the pt-BR examples are in Portuguese, with the wire keys untouched", () => {
  const pt = JSON.parse(contractExamples(tFrom(ptBR)).request);
  const enEx = JSON.parse(contractExamples(tFrom(en)).request);
  expect(pt.customerMessage === enEx.customerMessage).toBe(false);
  expect(keys(pt)).toBe(keys(enEx));
});

describe("external check contract modal", () => {
  afterEach(cleanup);

  test("the button opens the format with the request and the three answers", () => {
    render(<ExternalCheckContract />);
    const before = screen.queryByTestId("gr-external-contract") !== null;
    fireEvent.click(screen.getByTestId("gr-external-contract-open"));
    const shown = (id: string) => screen.queryByTestId(id)?.textContent ?? "";
    expect(before).toBe(false);
    expect(shown("gr-external-contract-request")).toContain('"candidateId"');
    expect(shown("gr-external-contract-allow")).toContain('"allow"');
    expect(shown("gr-external-contract-replace")).toContain('"replace"');
    expect(shown("gr-external-contract-block")).toContain('"block"');
  });
});
