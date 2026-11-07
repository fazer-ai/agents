/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { ToolPreconditionsEditor } from "@/client/pages/agents/ToolPreconditionsEditor";

afterEach(cleanup);

describe("the Tools tab's wording", () => {
  test("the note under the native tools carries no dash, in either language", () => {
    for (const cat of [en, ptBR]) {
      expect(/[—–]/.test(cat.editor.tools.nativeContextNote)).toBe(false);
    }
  });

  // On questions and rules nobody is told why a tool was refused: the rule's action does not run and
  // the refusal is in the logs. The help says that, not what a model would hear.
  test("the preconditions' help says what happens on each engine", () => {
    render(
      <ToolPreconditionsEditor
        agentId="1"
        rows={[]}
        onChange={() => {}}
        guardableTools={[]}
        assembledTools={new Set()}
        decides
      />,
    );
    const decides = document.body.textContent ?? "";
    expect(decides.includes("is told why")).toBe(false);
    expect(decides.includes("does not run")).toBe(true);
    cleanup();
    render(
      <ToolPreconditionsEditor
        agentId="1"
        rows={[]}
        onChange={() => {}}
        guardableTools={[]}
        assembledTools={new Set()}
      />,
    );
    expect(screen.queryAllByText(/is told why/).length).toBeGreaterThan(0);
  });

  // A rule's action carries no transcript, so a choice condition there refuses every time: the kind
  // is not offered on questions and rules.
  test("the customer's choice is offered only where a model turn calls the tool", () => {
    const rows = [
      {
        tool: "t",
        conditions: [{ scope: "conversation" as const, key: "k", equals: "" }],
      },
    ];
    const choiceOption = () =>
      screen.queryAllByRole("option", {
        name: "the customer has chosen the values of the call",
      });
    render(
      <ToolPreconditionsEditor
        agentId="1"
        rows={rows}
        onChange={() => {}}
        guardableTools={[]}
        assembledTools={new Set(["t"])}
        decides
      />,
    );
    expect(choiceOption()).toHaveLength(0);
    cleanup();
    render(
      <ToolPreconditionsEditor
        agentId="1"
        rows={rows}
        onChange={() => {}}
        guardableTools={[]}
        assembledTools={new Set(["t"])}
      />,
    );
    expect(choiceOption()).toHaveLength(1);
    cleanup();
    // A call's tools run with no transcript, so the rule would refuse every call.
    render(
      <ToolPreconditionsEditor
        agentId="1"
        rows={rows}
        onChange={() => {}}
        guardableTools={[]}
        assembledTools={new Set(["t"])}
        voice
      />,
    );
    expect(choiceOption()).toHaveLength(0);
    cleanup();
    // A rule already saved on a voice agent stays visible as what it is.
    render(
      <ToolPreconditionsEditor
        agentId="1"
        rows={[
          {
            tool: "t",
            conditions: [
              {
                kind: "customer_choice" as const,
                scope: "conversation" as const,
                key: "",
                equals: "",
              },
            ],
          },
        ]}
        onChange={() => {}}
        guardableTools={[]}
        assembledTools={new Set(["t"])}
        voice
      />,
    );
    expect(choiceOption()).toHaveLength(1);
  });
});
