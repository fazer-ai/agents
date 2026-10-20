/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import {
  type CallFloor,
  CallFloorContext,
  CallFloorLine,
  FieldSize,
  InstructionsTokens,
  KnowledgeTokens,
  SourceTokens,
  ToolTokens,
} from "@/client/pages/agents/CallFloor";
import { estimateTokens } from "@/lib/token-estimate";

// The line next to the history ceiling (agents#1510): the server measures the saved tools and what
// the runtime appends, the editor counts the instructions as typed, and the Tools tab shows the same
// per-tool number on each row.

afterEach(() => {
  cleanup();
});

async function inLanguage(lng: "en" | "pt-BR", ui: ReactNode) {
  const i = i18next.createInstance();
  await i.init({
    lng,
    resources: {
      en: { translation: clientEn },
      "pt-BR": { translation: clientPt },
    },
    interpolation: { escapeValue: false },
  });
  const wrap = (node: ReactNode) => (
    <I18nextProvider i18n={i}>{node}</I18nextProvider>
  );
  const r = render(wrap(ui));
  return { ...r, rerenderIn: (node: ReactNode) => r.rerender(wrap(node)) };
}

const FLOOR: CallFloor = {
  engine: "llm",
  instructions: 999,
  instructionsAdded: 120,
  instructionsAddedBy: { grounding: 100, mcp: 20 },
  tools: [
    {
      name: "consultar_pedido",
      category: "http",
      estimatedTokens: 812,
      label: "Consultar pedido",
    },
    {
      name: "mcp__loja__estoque",
      category: "mcp",
      estimatedTokens: 300,
      mcp: { connectionId: "7", tool: "estoque" },
    },
    { name: "handoff_to_human", category: "native", estimatedTokens: 255 },
    { name: "somar", category: "code", estimatedTokens: 64, label: "Somar" },
    {
      name: "resend_email_status",
      category: "integration",
      estimatedTokens: 40,
      integrationInstanceId: "3",
    },
  ],
  total: 0,
};

const PROMPT = "Você atende a loja e responde sobre pedidos. ".repeat(30);

describe("CallFloorLine", () => {
  test("the total is the draft instructions plus what the server measured, and moves as they are typed", async () => {
    const tools = 812 + 300 + 255 + 64 + 40;
    const { rerenderIn } = await inLanguage(
      "en",
      <CallFloorLine floor={FLOOR} draftPrompt={PROMPT} />,
    );
    const first = estimateTokens(PROMPT) + 120 + tools;
    expect(
      screen.getByText(
        `Every call already sends ~${first.toLocaleString("en")} tokens before the history`,
      ),
    ).toBeTruthy();
    // The saved instructions on the server (999) are not what is counted: the draft is.
    const longer = `${PROMPT}${"Mais uma regra sobre trocas e devoluções. ".repeat(40)}`;
    rerenderIn(<CallFloorLine floor={FLOOR} draftPrompt={longer} />);
    const second = estimateTokens(longer) + 120 + tools;
    expect(second).toBeGreaterThan(first);
    expect(
      screen.getByText(
        `Every call already sends ~${second.toLocaleString("en")} tokens before the history`,
      ),
    ).toBeTruthy();
  });

  // By the names the Tools tab shows, never the model-facing identifier, and the instructions as the
  // model receives them: the operator's text plus what the system appends, in one entry.
  test("opening it lists the instructions as sent and each tool by its Tools-tab name, largest first", async () => {
    await inLanguage(
      "pt-BR",
      <CallFloorLine floor={FLOOR} draftPrompt={PROMPT} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cada chamada/ }));
    const items = screen
      .getAllByRole("listitem")
      .map((li) => li.textContent?.replace(/\d+%$/, ""));
    expect(items).toEqual([
      `~${(estimateTokens(PROMPT) + 120).toLocaleString("pt-BR")}Instruções do agenteinclui ~120 que o sistema acrescenta (regras da base de conhecimento, servidores MCP)`,
      "~812Consultar pedido",
      "~300estoque",
      "~255Transferir para humano",
      "~64Somar",
      "~40Status do e-mail",
    ]);
  });

  test("with no tools and nothing appended, the total is the instructions alone", async () => {
    await inLanguage(
      "en",
      <CallFloorLine
        floor={{
          ...FLOOR,
          instructionsAdded: 0,
          instructionsAddedBy: { grounding: 0, mcp: 0 },
          tools: [],
        }}
        draftPrompt={PROMPT}
      />,
    );
    expect(
      screen.getByText(
        `Every call already sends ~${estimateTokens(PROMPT).toLocaleString("en")} tokens before the history`,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Every call/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  test("a decisions-engine observer gets no number, and the line says why", async () => {
    await inLanguage(
      "pt-BR",
      <CallFloorLine floor={{ engine: "decisions" }} draftPrompt={PROMPT} />,
    );
    expect(screen.queryByText(/tokens/)).toBeNull();
    expect(screen.getByText(/não se aplicam/)).toBeTruthy();
  });
});

// The row of an MCP server or an integration sums its own turned-on tools, and only its own.
describe("SourceTokens", () => {
  test("a source's row sums its tools; another source's tools, and a source with none on, add nothing", async () => {
    const floor: CallFloor = {
      ...FLOOR,
      tools: [
        ...(FLOOR.engine === "llm" ? FLOOR.tools : []),
        {
          name: "mcp__loja__reservar",
          category: "mcp",
          estimatedTokens: 120,
          mcp: { connectionId: "7", tool: "reservar" },
        },
        {
          name: "mcp__outra__buscar",
          category: "mcp",
          estimatedTokens: 999,
          mcp: { connectionId: "8", tool: "buscar" },
        },
        {
          name: "resend_send_email",
          category: "integration",
          estimatedTokens: 260,
          integrationInstanceId: "3",
        },
      ],
    } as CallFloor;
    await inLanguage(
      "pt-BR",
      <CallFloorContext.Provider value={floor}>
        <div data-testid="mcp">
          <SourceTokens source={{ mcp: "7" }} />
        </div>
        <div data-testid="pack">
          <SourceTokens source={{ integration: "3" }} />
        </div>
        <div data-testid="off">
          <SourceTokens source={{ mcp: "9" }} />
        </div>
      </CallFloorContext.Provider>,
    );
    expect(screen.getByTestId("mcp").textContent).toBe(
      "~420 tokens por chamada no total",
    );
    expect(screen.getByTestId("pack").textContent).toBe(
      "~300 tokens por chamada no total",
    );
    expect(screen.getByTestId("off").textContent).toBe("");
  });
});

describe("ToolTokens", () => {
  test("a row shows its own tool's number, by name or by MCP grant; an unmeasured row shows none", async () => {
    await inLanguage(
      "en",
      <CallFloorContext.Provider value={FLOOR}>
        <div data-testid="http">
          <ToolTokens tool={{ name: "consultar_pedido", kind: "http" }} />
        </div>
        <div data-testid="mcp">
          <ToolTokens tool={{ mcp: { connectionId: "7", tool: "estoque" } }} />
        </div>
        <div data-testid="other-server">
          <ToolTokens tool={{ mcp: { connectionId: "8", tool: "estoque" } }} />
        </div>
        <div data-testid="pack">
          <ToolTokens
            tool={{
              integration: { instanceId: "3", tool: "resend_email_status" },
            }}
          />
        </div>
        <div data-testid="pack-shadowed">
          <ToolTokens
            tool={{
              integration: { instanceId: "4", tool: "resend_email_status" },
            }}
          />
        </div>
        <div data-testid="same-name-other-kind">
          <ToolTokens tool={{ name: "resend_email_status", kind: "http" }} />
        </div>
        <div data-testid="legacy">
          <ToolTokens tool={{ name: "Somar", kind: "code" }} />
        </div>
        <div data-testid="unsaved">
          <ToolTokens tool={{ name: "nao_salva", kind: "http" }} />
        </div>
      </CallFloorContext.Provider>,
    );
    expect(screen.getByTestId("http").textContent).toBe("~812 tokens per call");
    expect(screen.getByTestId("mcp").textContent).toBe("~300 tokens per call");
    expect(screen.getByTestId("other-server").textContent).toBe("");
    expect(screen.getByTestId("unsaved").textContent).toBe("");
    // A row whose stored name the build normalizes ("Somar" is offered as "somar") still finds it.
    expect(screen.getByTestId("legacy").textContent).toBe(
      "~64 tokens per call",
    );
    // An operator's HTTP tool named like a pack's tool is another row, and the number is the pack's.
    expect(screen.getByTestId("same-name-other-kind").textContent).toBe("");
    // The second instance of a pack contributes nothing: its row shows no number.
    expect(screen.getByTestId("pack").textContent).toBe("~40 tokens per call");
    expect(screen.getByTestId("pack-shadowed").textContent).toBe("");
  });
});

// The same estimate where the instructions are written and where knowledge is switched on.
describe("InstructionsTokens and KnowledgeTokens", () => {
  const KB: CallFloor = {
    ...FLOOR,
    tools: [
      ...(FLOOR.engine === "llm" ? FLOOR.tools : []),
      { name: "search_knowledge", category: "knowledge", estimatedTokens: 90 },
      { name: "suggest_kb_entry", category: "knowledge", estimatedTokens: 70 },
    ],
  };

  test("under the instructions: the draft's cost and what the system appends, live", async () => {
    await inLanguage(
      "pt-BR",
      <CallFloorContext.Provider value={KB}>
        <InstructionsTokens draftPrompt={PROMPT} />
      </CallFloorContext.Provider>,
    );
    expect(
      screen.getByText(
        `Estas instruções somam ~${estimateTokens(PROMPT).toLocaleString("pt-BR")} tokens a cada chamada, e o sistema acrescenta mais ~120 (regras da base de conhecimento, servidores MCP).`,
      ),
    ).toBeTruthy();
  });

  test("the search switch costs its tool plus the grounding rules; the suggest switch its tool", async () => {
    await inLanguage(
      "pt-BR",
      <CallFloorContext.Provider value={KB}>
        <div data-testid="search">
          <KnowledgeTokens part="search" />
        </div>
        <div data-testid="suggest">
          <KnowledgeTokens part="suggest" />
        </div>
      </CallFloorContext.Provider>,
    );
    expect(screen.getByTestId("search").textContent).toBe(
      "~190 tokens por chamada, entre a busca e as regras que ela acrescenta às instruções",
    );
    expect(screen.getByTestId("suggest").textContent).toBe(
      "~70 tokens por chamada",
    );
  });

  test("not granted (as saved): no number on the switch", async () => {
    await inLanguage(
      "en",
      <CallFloorContext.Provider value={FLOOR}>
        <div data-testid="search">
          <KnowledgeTokens part="search" />
        </div>
      </CallFloorContext.Provider>,
    );
    expect(screen.getByTestId("search").textContent).toBe("");
  });

  test("the breakdown names the knowledge tools after what they do", async () => {
    await inLanguage(
      "pt-BR",
      <CallFloorLine floor={KB} draftPrompt={PROMPT} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cada chamada/ }));
    const items = screen
      .getAllByRole("listitem")
      .map((li) => li.textContent?.replace(/\d+%$/, ""));
    expect(items).toContain("~90Busca no conhecimento");
    expect(items).toContain("~70Sugestão de entradas no conhecimento");
  });
});

// Each line carries the icon its row has on the Tools or Knowledge tab, so the two read as one thing.
describe("breakdown icons", () => {
  test("each line shows its kind's icon", async () => {
    const floor: CallFloor = {
      ...FLOOR,
      tools: [
        ...(FLOOR.engine === "llm" ? FLOOR.tools : []),
        { name: "search_knowledge", category: "knowledge", estimatedTokens: 9 },
      ],
    };
    await inLanguage(
      "en",
      <CallFloorLine floor={floor} draftPrompt={PROMPT} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Every call/ }));
    const icons = screen
      .getAllByRole("listitem")
      .map((li) =>
        [...(li.querySelector("svg")?.classList ?? [])].find(
          (c) => c.startsWith("lucide-") && c !== "lucide",
        ),
      );
    expect(icons).toEqual([
      "lucide-scroll-text",
      "lucide-webhook",
      "lucide-plug",
      expect.stringMatching(/^lucide-/),
      "lucide-code-xml",
      expect.stringMatching(/^lucide-/),
      "lucide-book-open",
    ]);
  });
});

// Each line as its share of the call: a bar whose full width is the whole call, and the percent
// written at the end, so the bar has a unit a reader can name.
describe("breakdown shares", () => {
  test("each line's bar and percent are its share of the total", async () => {
    await inLanguage("en", <CallFloorLine floor={FLOOR} draftPrompt="" />);
    fireEvent.click(screen.getByRole("button", { name: /Every call/ }));
    const items = screen.getAllByRole("listitem");
    // Instructions 0 + 120 added, then 812, 300, 255, 64, 40: 1591 in all.
    expect(
      items.map(
        (li) =>
          (li.querySelector("span[style]") as HTMLElement | null)?.style.width,
      ),
    ).toEqual(["8%", "51%", "19%", "16%", "4%", "3%"]);
    expect(items.map((li) => li.textContent?.match(/\d+%$/)?.[0])).toEqual([
      "8%",
      "51%",
      "19%",
      "16%",
      "4%",
      "3%",
    ]);
  });
});

describe("FieldSize", () => {
  const POLICY = "Nunca prometa prazo de entrega sem consultar o pedido. "
    .repeat(8)
    .trim();

  test("says the size as typed and which call it goes to, and moves with the draft", async () => {
    const { rerenderIn } = await inLanguage(
      "en",
      <FieldSize text={POLICY} sentWith="guardrail" />,
    );
    const first = `~${estimateTokens(POLICY).toLocaleString("en")} tokens · ${POLICY.length.toLocaleString("en")} characters, sent on each guardrail check`;
    expect(screen.getByText(first)).toBeTruthy();
    const longer = `${POLICY}Cite o número do pedido.`;
    rerenderIn(<FieldSize text={longer} sentWith="guardrail" />);
    expect(
      screen.getByText(
        `~${estimateTokens(longer).toLocaleString("en")} tokens · ${longer.length.toLocaleString("en")} characters, sent on each guardrail check`,
      ),
    ).toBeTruthy();
  });

  test("each destination names its call, and a tool note says it is already in the tool's number", async () => {
    const lines: Record<string, string> = {
      toolDescription:
        "part of this tool's description (counted in its tokens per call)",
      followUp: "sent on each call of this follow-up step",
      redirectFollowUp: "sent on the chat follow-up's call",
      guardrail: "sent on each guardrail check",
      vision: "sent on each image or PDF read",
      spokenNotice: "sent on each turn answered by audio",
    };
    for (const [sentWith, where] of Object.entries(lines)) {
      await inLanguage(
        "en",
        <FieldSize
          text="abc"
          sentWith={sentWith as Parameters<typeof FieldSize>[0]["sentWith"]}
        />,
      );
      expect(
        screen.getByText(
          new RegExp(`characters, ${where.replace(/[()]/g, "\\$&")}$`),
        ),
      ).toBeTruthy();
      cleanup();
    }
  });

  test("in Portuguese, with the operator's number format", async () => {
    await inLanguage("pt-BR", <FieldSize text={POLICY} sentWith="vision" />);
    expect(
      screen.getByText(
        `~${estimateTokens(POLICY).toLocaleString("pt-BR")} tokens · ${POLICY.length.toLocaleString("pt-BR")} caracteres, enviados a cada leitura de imagem ou PDF`,
      ),
    ).toBeTruthy();
  });

  test("past its cap, it counts what the reader keeps", async () => {
    const long = "a".repeat(120);
    await inLanguage(
      "en",
      <FieldSize text={long} sentWith="followUp" max={100} />,
    );
    expect(
      screen.getByText(
        `~${estimateTokens("a".repeat(100)).toLocaleString("en")} tokens · 100 characters, sent on each call of this follow-up step`,
      ),
    ).toBeTruthy();
  });

  test("it counts the text trimmed, and a blank field as the default it sends", async () => {
    const { rerenderIn } = await inLanguage(
      "en",
      <FieldSize text="  abc  " sentWith="vision" fallback="Describe it." />,
    );
    expect(screen.getByText(/· 3 characters, /)).toBeTruthy();
    rerenderIn(
      <FieldSize text="   " sentWith="vision" fallback="Describe it." />,
    );
    expect(screen.getByText(/· 12 characters, /)).toBeTruthy();
  });

  test("an empty field still shows its line, at zero", async () => {
    await inLanguage("en", <FieldSize text="  " sentWith="followUp" />);
    expect(
      screen.getByText(
        "~0 tokens · 0 characters, sent on each call of this follow-up step",
      ),
    ).toBeTruthy();
  });
});

describe("reply_as_text", () => {
  const withReply: CallFloor = {
    ...FLOOR,
    tools: [
      ...FLOOR.tools,
      { name: "reply_as_text", category: "external", estimatedTokens: 95 },
    ],
  };

  test("its number shows by its own name, and the breakdown names it after what it does", async () => {
    await inLanguage(
      "en",
      <CallFloorContext.Provider value={withReply}>
        <ToolTokens tool={{ system: "reply_as_text" }} />
        <CallFloorLine floor={withReply} draftPrompt="" />
      </CallFloorContext.Provider>,
    );
    expect(screen.getByText("~95 tokens per call")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Every call/ }));
    expect(screen.getByText("Reply in text (voice replies)")).toBeTruthy();
  });

  test("off (not in the floor), no number", async () => {
    await inLanguage(
      "en",
      <CallFloorContext.Provider value={FLOOR}>
        <ToolTokens tool={{ system: "reply_as_text" }} />
      </CallFloorContext.Provider>,
    );
    expect(screen.queryByText(/tokens per call/)).toBeNull();
  });
});
