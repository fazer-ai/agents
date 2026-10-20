/// <reference lib="dom" />
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import type { FazerAiAgent } from "@/sdk/agent";

// <fazer-ai-agent> in a page, with the network replaced: it fetches the app's token, runs a turn
// over SSE, runs the tool the page registered and resumes with its answer, renders the reply, keeps
// the thread for the same user, renews a token the instance refused, and offers the built-in
// highlight only when the page marks a target.
//
// Every assertion reduces to a plain value before expect: a failing expectation holding a DOM node
// serializes a cyclic happy-dom tree and stalls the runner.

const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;
const realFetch = globalThis.fetch;

const INSTANCE = "http://instancia.test";
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims: object) =>
  `h.${btoa(JSON.stringify(claims)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.s`;

interface Sent {
  url: string;
  auth: string | null;
  body: Record<string, unknown> | null;
  form?: FormData;
}
let sent: Sent[] = [];
let turnAnswers: Array<() => Response> = [];
let tokens: string[] = [];

function sse(...events: Array<[string, unknown]>): Response {
  const text = events
    .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    .join("");
  return new BunResponse(text, {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    sent.push({
      url,
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      ...(init?.body instanceof FormData ? { form: init.body } : {}),
    });
    if (url.startsWith("/token")) return new BunResponse(tokens.shift() ?? "");
    const next = turnAnswers.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return next();
  }) as typeof fetch;
  await import("@/sdk/agent");
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sent = [];
  turnAnswers = [];
  tokens = [];
});

function mount(): FazerAiAgent {
  const el = document.createElement("fazer-ai-agent") as FazerAiAgent;
  el.setAttribute("app", "app_teste");
  el.setAttribute("token-url", "/token");
  el.setAttribute("instance", INSTANCE);
  el.setAttribute("lang", "pt-BR");
  document.body.appendChild(el);
  return el;
}

async function ask(el: FazerAiAgent, text: string) {
  const root = el.shadowRoot as ShadowRoot;
  el.open();
  const input = root.querySelector("textarea") as HTMLTextAreaElement;
  input.value = text;
  input.dispatchEvent(new Event("input"));
  (root.querySelector("form") as HTMLFormElement).dispatchEvent(
    new Event("submit", { cancelable: true }),
  );
}

async function until(check: () => boolean, tries = 200) {
  for (let i = 0; i < tries && !check(); i++)
    await new Promise((r) => setTimeout(r, 5));
  if (!check()) throw new Error("timed out");
}

const EMPTY =
  "Pergunte sobre o que você vê aqui. O assistente lê o que você pode ler e leva você até onde precisa ir.";

// A browser that refuses storage: every read and write throws. The global is replaced rather than
// its methods spied, since a spy on `Storage.prototype` stops reaching the page's `localStorage` once
// other tests of the file have run.
function denyStorage(): () => void {
  const real = Object.getOwnPropertyDescriptor(window, "localStorage");
  const denied = () => {
    throw new Error("denied");
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: denied,
      setItem: denied,
      removeItem: denied,
      clear: denied,
    },
  });
  return () => {
    if (real) Object.defineProperty(window, "localStorage", real);
  };
}

const logText = (el: FazerAiAgent) =>
  (el.shadowRoot as ShadowRoot).querySelector(".log")?.textContent ?? "";

describe("<fazer-ai-agent>", () => {
  test("a turn that calls the page's tool resumes with its answer and renders the reply", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    const ran: unknown[] = [];
    el.tool({
      name: "ler_nota",
      description: "Lê uma nota",
      parameters: { type: "object", properties: { id: { type: "string" } } },
      run: async (args) => {
        ran.push(args);
        return { numero: 7 };
      },
    });
    el.context(() => ({ tela: "nota", id: "9" }));
    turnAnswers = [
      () =>
        sse(
          ["tool", { type: "tool", phase: "start", name: "knowledge_search" }],
          [
            "tool",
            { type: "tool", phase: "end", name: "knowledge_search", ok: true },
          ],
          [
            "pending",
            {
              threadId: "t1",
              status: "pending",
              calls: [
                { toolCallId: "c1", name: "ler_nota", args: { id: "9" } },
              ],
            },
          ],
        ),
      () =>
        sse([
          "done",
          {
            threadId: "t1",
            status: "done",
            reply: "A nota **7** foi rejeitada.",
          },
        ]),
    ];
    await ask(el, "por que foi rejeitada?");
    await until(() => logText(el).includes("foi rejeitada."));
    const [token, first, second] = sent;
    expect({
      token: token?.url,
      first: {
        url: first?.url,
        auth: first?.auth?.startsWith("Bearer h."),
        message: first?.body?.message,
        context: first?.body?.context,
        tools: (
          (first?.body?.clientTools ?? []) as Array<{ name: string }>
        ).map((t) => t.name),
      },
      ran,
      second: {
        threadId: second?.body?.threadId,
        answers: second?.body?.answers,
      },
      bold: (el.shadowRoot as ShadowRoot).querySelector(".agent strong")
        ?.textContent,
      step: logText(el).includes("✓ knowledge_search"),
      stored: localStorage.getItem("fazer-ai-agent:app_teste:42"),
    }).toEqual({
      token: "/token",
      first: {
        url: `${INSTANCE}/api/v1/sdk/app_teste/turn`,
        auth: true,
        message: "por que foi rejeitada?",
        context: { tela: "nota", id: "9" },
        tools: ["ler_nota"],
      },
      ran: [{ id: "9" }],
      second: {
        threadId: "t1",
        answers: { c1: { ok: true, result: { numero: 7 } } },
      },
      bold: "7",
      step: true,
      stored: "t1",
    });
  });

  test("a refused token is renewed once and the turn retried", async () => {
    tokens = [
      jwt({ sub: "42", exp: now() + 600 }),
      jwt({ sub: "42", exp: now() + 900 }),
    ];
    const el = mount();
    turnAnswers = [
      () =>
        new BunResponse(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      () => sse(["done", { threadId: "t2", status: "done", reply: "oi" }]),
    ];
    await ask(el, "oi");
    await until(
      () => (el.shadowRoot as ShadowRoot).querySelector(".agent") !== null,
    );
    expect(sent.map((s) => s.url)).toEqual([
      "/token",
      `${INSTANCE}/api/v1/sdk/app_teste/turn`,
      "/token",
      `${INSTANCE}/api/v1/sdk/app_teste/turn`,
    ]);
  });

  test("a stored thread the instance no longer knows is dropped and a new one started", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    localStorage.setItem("fazer-ai-agent:app_teste:42", "velha");
    const el = mount();
    turnAnswers = [
      () =>
        new BunResponse(JSON.stringify({ error: "thread not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      () => sse(["done", { threadId: "nova", status: "done", reply: "oi" }]),
    ];
    await ask(el, "oi");
    await until(
      () => (el.shadowRoot as ShadowRoot).querySelector(".agent") !== null,
    );
    expect({
      threads: sent.slice(1).map((s) => s.body?.threadId ?? null),
      stored: localStorage.getItem("fazer-ai-agent:app_teste:42"),
    }).toEqual({ threads: ["velha", null], stored: "nova" });
  });

  test("the highlight is offered only when the page marks a target, and outlines it", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const button = document.createElement("button");
    button.setAttribute("data-fazer-ai-target", "emitir");
    document.body.appendChild(button);
    const el = mount();
    turnAnswers = [
      () =>
        sse([
          "pending",
          {
            threadId: "t3",
            status: "pending",
            calls: [
              {
                toolCallId: "h1",
                name: "highlight_element",
                args: { target: "emitir" },
              },
            ],
          },
        ]),
      () =>
        sse(["done", { threadId: "t3", status: "done", reply: "Clique ali." }]),
    ];
    await ask(el, "como emito?");
    await until(() => logText(el).includes("Clique ali."));
    const offered = (
      (sent[1]?.body?.clientTools ?? []) as Array<{
        name: string;
        parameters: { properties: { target: { enum: string[] } } };
      }>
    ).find((t) => t.name === "highlight_element");
    expect({
      enum: offered?.parameters.properties.target.enum,
      answer: ((sent[2]?.body?.answers ?? {}) as Record<string, unknown>).h1,
      outlined:
        document.querySelector('[data-fazer-ai-highlight="emitir"]') !== null,
    }).toEqual({
      enum: ["emitir"],
      answer: { ok: true, result: { shown: "emitir" } },
      outlined: true,
    });
  });

  test("the built-in highlight name cannot be taken by a page tool", () => {
    const el = mount();
    expect(() =>
      el.tool({ name: "highlight_element", description: "x", run: () => null }),
    ).toThrow();
  });

  test("an error from the turn is shown, and the panel speaks the page's language", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    turnAnswers = [
      () => sse(["error", { status: 429, error: "Limite atingido" }]),
    ];
    await ask(el, "oi");
    await until(() => logText(el).includes("Limite atingido"));
    const root = el.shadowRoot as ShadowRoot;
    expect({
      send: root.querySelector(".send")?.textContent,
      reset: root.querySelector(".reset")?.textContent,
    }).toEqual({ send: "Enviar", reset: "Nova conversa" });
  });

  test("a renewal that names another user resumes that user's thread, saves under them, and clears the other's messages", async () => {
    tokens = [
      jwt({ sub: "42", exp: now() + 600 }),
      jwt({ sub: "99", exp: now() + 600 }),
    ];
    localStorage.setItem("fazer-ai-agent:app_teste:42", "t42");
    localStorage.setItem("fazer-ai-agent:app_teste:99", "t99");
    const el = mount();
    turnAnswers = [
      () =>
        sse([
          "done",
          { threadId: "t42", status: "done", reply: "resposta a 42" },
        ]),
      () =>
        new BunResponse(JSON.stringify({ error: "x" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      () =>
        sse([
          "done",
          { threadId: "t99b", status: "done", reply: "resposta a 99" },
        ]),
    ];
    await ask(el, "primeira");
    await until(() => logText(el).includes("resposta a 42"));
    await ask(el, "segunda");
    await until(() => logText(el).includes("resposta a 99"));
    const root = el.shadowRoot as ShadowRoot;
    expect({
      threads: sent
        .filter((x) => x.url.endsWith("/turn"))
        .map((x) => x.body?.threadId),
      stored42: localStorage.getItem("fazer-ai-agent:app_teste:42"),
      stored99: localStorage.getItem("fazer-ai-agent:app_teste:99"),
      shown: [...root.querySelectorAll(".msg")].map((m) => m.textContent),
    }).toEqual({
      threads: ["t42", "t42", "t99"],
      stored42: "t42",
      stored99: "t99b",
      shown: ["segunda", "resposta a 99"],
    });
  });

  test("answering a call re-declares its tool when the page stopped offering it", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const button = document.createElement("button");
    button.setAttribute("data-fazer-ai-target", "emitir");
    document.body.appendChild(button);
    const el = mount();
    el.tool({
      name: "sair",
      description: "navega",
      run: () => {
        button.remove();
        return null;
      },
    });
    turnAnswers = [
      () =>
        sse([
          "pending",
          {
            threadId: "t",
            status: "pending",
            calls: [
              {
                toolCallId: "a",
                name: "highlight_element",
                args: { target: "emitir" },
              },
              { toolCallId: "b", name: "sair", args: {} },
            ],
          },
        ]),
      () => sse(["done", { threadId: "t", status: "done", reply: "ok" }]),
    ];
    await ask(el, "x");
    await until(() => logText(el).includes("ok"));
    const second = (sent[2]?.body?.clientTools ?? []) as Array<{
      name: string;
    }>;
    expect(second.map((t) => t.name).sort()).toEqual([
      "highlight_element",
      "sair",
    ]);
  });

  test("a context callback that throws is reported and leaves the panel usable", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    el.context(() => {
      throw new Error("boom");
    });
    await ask(el, "oi");
    await until(() =>
      logText(el).includes("O assistente não conseguiu responder."),
    );
    expect(
      (el.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>(".reset")
        ?.disabled,
    ).toBe(false);
  });

  test("a network failure is reported and leaves the panel usable", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    turnAnswers = [
      () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    await ask(el, "oi");
    await until(() =>
      logText(el).includes("O assistente não conseguiu responder."),
    );
    expect(
      (el.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>(".reset")
        ?.disabled,
    ).toBe(false);
  });

  test("with storage denied, the open conversation still keeps its thread", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const restore = denyStorage();
    try {
      expect(() => localStorage.getItem("x")).toThrow("denied");
      const el = mount();
      turnAnswers = [
        () => sse(["done", { threadId: "t1", status: "done", reply: "um" }]),
        () => sse(["done", { threadId: "t1", status: "done", reply: "dois" }]),
      ];
      await ask(el, "a");
      await until(() => logText(el).includes("um"));
      await ask(el, "b");
      await until(() => logText(el).includes("dois"));
      expect(
        sent
          .filter((x) => x.url.endsWith("/turn"))
          .map((x) => x.body?.threadId ?? null),
      ).toEqual([null, "t1"]);
    } finally {
      restore();
    }
  });

  test("New conversation pressed before any token still forgets the stored thread", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    localStorage.setItem("fazer-ai-agent:app_teste:42", "velha");
    const el = mount();
    el.reset();
    turnAnswers = [
      () =>
        sse(["done", { threadId: "nova", status: "done", reply: "resposta" }]),
    ];
    await ask(el, "olá");
    await until(() => logText(el).includes("resposta"));
    expect({
      thread: sent[1]?.body?.threadId ?? null,
      stored: localStorage.getItem("fazer-ai-agent:app_teste:42"),
    }).toEqual({ thread: null, stored: "nova" });
  });

  test("the outline follows the element while it moves", async () => {
    const button = document.createElement("button");
    button.setAttribute("data-fazer-ai-target", "emitir");
    document.body.appendChild(button);
    let top = 900;
    button.getBoundingClientRect = () =>
      ({
        left: 10,
        top,
        width: 100,
        height: 40,
        right: 110,
        bottom: top + 40,
        x: 10,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const { highlight } = await import("@/sdk/agent");
    highlight("emitir");
    const box = document.querySelector<HTMLElement>(
      '[data-fazer-ai-highlight="emitir"]',
    );
    const before = box?.style.top;
    top = 300;
    await until(() => box?.style.top !== before);
    const moved = box?.style.top;
    top = 500;
    await until(() => box?.style.top !== moved);
    expect([before, moved, box?.style.top]).toEqual([
      "894px",
      "294px",
      "494px",
    ]);
  });

  test("a turn still asking for tools on its last round runs nothing more and abandons the thread", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    let runs = 0;
    el.tool({ name: "passo", description: "um passo", run: () => ++runs });
    const pending = (i: number) => () =>
      sse([
        "pending",
        {
          threadId: "t",
          status: "pending",
          calls: [{ toolCallId: `c${i}`, name: "passo", args: {} }],
        },
      ]);
    turnAnswers = Array.from({ length: 8 }, (_, i) => pending(i));
    await ask(el, "vai");
    await until(() =>
      logText(el).includes("O assistente deu passos demais e parou."),
    );
    expect({
      requests: sent.filter((x) => x.url.endsWith("/turn")).length,
      runs,
      stored: localStorage.getItem("fazer-ai-agent:app_teste:42"),
    }).toEqual({ requests: 8, runs: 7, stored: null });
  });

  test("answers are not sent to another user's thread when a renewal changes the owner", async () => {
    tokens = [
      jwt({ sub: "42", exp: now() + 600 }),
      jwt({ sub: "99", exp: now() + 600 }),
    ];
    localStorage.setItem("fazer-ai-agent:app_teste:99", "t99");
    const el = mount();
    el.tool({ name: "ler", description: "lê", run: () => 1 });
    turnAnswers = [
      () =>
        sse([
          "pending",
          {
            threadId: "t42",
            status: "pending",
            calls: [{ toolCallId: "c1", name: "ler", args: {} }],
          },
        ]),
      () =>
        new BunResponse(JSON.stringify({ error: "x" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ];
    await ask(el, "lê aí");
    await until(() =>
      logText(el).includes("O assistente não conseguiu responder."),
    );
    expect({
      requests: sent.map((x) => x.url),
      stored99: localStorage.getItem("fazer-ai-agent:app_teste:99"),
      stored42: localStorage.getItem("fazer-ai-agent:app_teste:42"),
    }).toEqual({
      requests: [
        "/token",
        `${INSTANCE}/api/v1/sdk/app_teste/turn`,
        `${INSTANCE}/api/v1/sdk/app_teste/turn`,
        "/token",
      ],
      stored99: "t99",
      stored42: null,
    });
    turnAnswers = [
      () => sse(["done", { threadId: "t99", status: "done", reply: "oi 99" }]),
    ];
    await ask(el, "de novo");
    await until(() => logText(el).includes("oi 99"));
    expect(sent.at(-1)?.body?.threadId).toBe("t99");
  });

  test("answers are not sent when a token renewed near its expiry names another user", async () => {
    tokens = [
      jwt({ sub: "42", exp: now() + 61 }),
      jwt({ sub: "99", exp: now() + 600 }),
    ];
    const el = mount();
    // NOTE: the tool runs across the renewal margin: the clock moves past it while it runs.
    el.tool({
      name: "demora",
      description: "leva mais de um segundo",
      run: () => {
        setSystemTime(new Date(Date.now() + 2_000));
        return 1;
      },
    });
    turnAnswers = [
      () =>
        sse([
          "pending",
          {
            threadId: "t42",
            status: "pending",
            calls: [{ toolCallId: "c1", name: "demora", args: {} }],
          },
        ]),
    ];
    try {
      await ask(el, "vai");
      await until(
        () => logText(el).includes("O assistente não conseguiu responder."),
        600,
      );
    } finally {
      setSystemTime();
    }
    expect(sent.map((x) => x.url)).toEqual([
      "/token",
      `${INSTANCE}/api/v1/sdk/app_teste/turn`,
      "/token",
    ]);
  });

  test("the same user in another organization has another conversation", async () => {
    tokens = [
      jwt({ sub: "42", scope: "org1", exp: now() + 600 }),
      jwt({ sub: "42", scope: "org2", exp: now() + 600 }),
    ];
    localStorage.setItem("fazer-ai-agent:app_teste:42:org1", "t1");
    localStorage.setItem("fazer-ai-agent:app_teste:42:org2", "t2");
    const el = mount();
    turnAnswers = [
      () =>
        sse([
          "done",
          { threadId: "t1", status: "done", reply: "resposta org1" },
        ]),
      () =>
        new BunResponse(JSON.stringify({ error: "x" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      () =>
        sse([
          "done",
          { threadId: "t2", status: "done", reply: "resposta org2" },
        ]),
    ];
    await ask(el, "primeira");
    await until(() => logText(el).includes("resposta org1"));
    await ask(el, "segunda");
    await until(() => logText(el).includes("resposta org2"));
    expect({
      threads: sent
        .filter((x) => x.url.endsWith("/turn"))
        .map((x) => x.body?.threadId),
      shown: [...(el.shadowRoot as ShadowRoot).querySelectorAll(".msg")].map(
        (m) => m.textContent,
      ),
    }).toEqual({
      threads: ["t1", "t1", "t2"],
      shown: ["segunda", "resposta org2"],
    });
  });

  test("a stale thread refused inside the stream is dropped and a new one started", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    localStorage.setItem("fazer-ai-agent:app_teste:42", "velha");
    const el = mount();
    turnAnswers = [
      () =>
        sse(
          ["ping", ""],
          ["error", { status: 404, error: "thread not found" }],
        ),
      () =>
        sse(["done", { threadId: "nova", status: "done", reply: "resposta" }]),
    ];
    await ask(el, "olá");
    await until(() => logText(el).includes("resposta"));
    expect({
      threads: sent.slice(1).map((x) => x.body?.threadId ?? null),
      stored: localStorage.getItem("fazer-ai-agent:app_teste:42"),
    }).toEqual({ threads: ["velha", null], stored: "nova" });
  });

  test("on a phone the panel steps aside while it highlights the page", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const realMatch = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("max-width"),
      media: q,
    })) as typeof window.matchMedia;
    try {
      const button = document.createElement("button");
      button.setAttribute("data-fazer-ai-target", "emitir");
      document.body.appendChild(button);
      const el = mount();
      turnAnswers = [
        () =>
          sse([
            "pending",
            {
              threadId: "t",
              status: "pending",
              calls: [
                {
                  toolCallId: "h",
                  name: "highlight_element",
                  args: { target: "emitir" },
                },
              ],
            },
          ]),
        () => sse(["done", { threadId: "t", status: "done", reply: "ali" }]),
      ];
      await ask(el, "onde?");
      await until(() => logText(el).includes("ali"));
      const root = el.shadowRoot as ShadowRoot;
      expect({
        panelHidden: (root.querySelector(".panel") as HTMLElement).hidden,
        fabHidden: (root.querySelector(".fab") as HTMLElement).hidden,
      }).toEqual({ panelHidden: true, fabHidden: false });
    } finally {
      window.matchMedia = realMatch;
    }
  });

  test("answers that never reached the instance abandon the suspended thread", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    el.tool({ name: "passo", description: "um passo", run: () => "ok" });
    turnAnswers = [
      () =>
        sse([
          "pending",
          {
            threadId: "susp",
            status: "pending",
            calls: [{ toolCallId: "c", name: "passo", args: {} }],
          },
        ]),
      () => {
        throw new TypeError("network down");
      },
      () =>
        sse(["done", { threadId: "nova", status: "done", reply: "de novo" }]),
    ];
    await ask(el, "primeira");
    await until(() => logText(el).includes("não conseguiu responder"));
    await ask(el, "segunda");
    await until(() => logText(el).includes("de novo"));
    expect(
      sent
        .filter((x) => x.url.endsWith("/turn"))
        .map((x) => x.body?.threadId ?? null),
    ).toEqual([null, "susp", null]);
  });

  test("Enter that confirms an IME composition does not send", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    el.open();
    const root = el.shadowRoot as ShadowRoot;
    const input = root.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "にほ";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        cancelable: true,
      }),
    );
    await Bun.sleep(20);
    expect({
      sent: sent.filter((x) => x.url.endsWith("/turn")).length,
      value: input.value,
    }).toEqual({
      sent: 0,
      value: "にほ",
    });
  });

  test("a host that signs another user in drops the cached token and the conversation on screen", async () => {
    const alice = jwt({ sub: "alice", exp: now() + 600 });
    const bob = jwt({ sub: "bob", exp: now() + 600 });
    localStorage.setItem("fazer-ai-agent:app_teste:bob", "tbob");
    const el = mount();
    el.tokenProvider = () => alice;
    turnAnswers = [
      () =>
        sse([
          "done",
          { threadId: "talice", status: "done", reply: "oi alice" },
        ]),
      () =>
        sse(["done", { threadId: "tbob", status: "done", reply: "oi bob" }]),
    ];
    await ask(el, "eu sou a alice");
    await until(() => logText(el).includes("oi alice"));
    el.tokenProvider = () => bob;
    const cleared = logText(el);
    await ask(el, "eu sou o bob");
    await until(() => logText(el).includes("oi bob"));
    const turns = sent.filter((x) => x.url.endsWith("/turn"));
    expect({
      cleared,
      auth: turns.map((x) => x.auth),
      threads: turns.map((x) => x.body?.threadId ?? null),
      shown: logText(el).includes("alice"),
    }).toEqual({
      cleared: EMPTY,
      auth: [`Bearer ${alice}`, `Bearer ${bob}`],
      threads: [null, "tbob"],
      shown: false,
    });
  });

  test("a new token-url is a new identity", async () => {
    tokens = [
      jwt({ sub: "42", exp: now() + 600 }),
      jwt({ sub: "43", exp: now() + 600 }),
    ];
    const el = mount();
    turnAnswers = [
      () => sse(["done", { threadId: "a", status: "done", reply: "um" }]),
      () => sse(["done", { threadId: "b", status: "done", reply: "dois" }]),
    ];
    await ask(el, "primeira");
    await until(() => logText(el).includes("um"));
    el.setAttribute("token-url", "/token?org=2");
    await ask(el, "segunda");
    await until(() => logText(el).includes("dois"));
    expect(sent.map((x) => x.url.replace(INSTANCE, ""))).toEqual([
      "/token",
      "/api/v1/sdk/app_teste/turn",
      "/token?org=2",
      "/api/v1/sdk/app_teste/turn",
    ]);
  });

  test("a turn still running when the identity changes writes nothing for the new user", async () => {
    const el = mount();
    el.tokenProvider = () => jwt({ sub: "alice", exp: now() + 600 });
    let release: (r: Response) => void = () => {};
    turnAnswers = [
      () =>
        new Promise<Response>((done) => {
          release = done;
        }) as unknown as Response,
    ];
    await ask(el, "pergunta da alice");
    await until(() => sent.some((x) => x.url.endsWith("/turn")));
    el.tokenProvider = () => jwt({ sub: "bob", exp: now() + 600 });
    release(
      sse(
        ["tool", { type: "tool", phase: "start", name: "knowledge_search" }],
        [
          "done",
          { threadId: "talice", status: "done", reply: "segredo da alice" },
        ],
      ),
    );
    await Bun.sleep(30);
    expect({
      log: logText(el),
      stored: Object.keys(localStorage).filter((k) => k.includes("bob")),
      sendable: !(el.shadowRoot as ShadowRoot).querySelector("textarea")
        ?.disabled,
    }).toEqual({ log: EMPTY, stored: [], sendable: true });
  });

  test("a token asked for the previous user and arriving after the change is not kept", async () => {
    const alice = jwt({ sub: "alice", exp: now() + 600 });
    const bob = jwt({ sub: "bob", exp: now() + 600 });
    const el = mount();
    let giveAlice: (t: string) => void = () => {};
    el.tokenProvider = () =>
      new Promise<string>((done) => {
        giveAlice = done;
      });
    await ask(el, "pergunta da alice");
    el.tokenProvider = () => bob;
    giveAlice(alice);
    await Bun.sleep(20);
    turnAnswers = [
      () =>
        sse(["done", { threadId: "tbob", status: "done", reply: "oi bob" }]),
    ];
    await ask(el, "pergunta do bob");
    await until(() => logText(el).includes("oi bob"));
    expect(
      sent.filter((x) => x.url.endsWith("/turn")).map((x) => x.auth),
    ).toEqual([`Bearer ${bob}`]);
  });

  test("a turn refused with 401 after the identity changed is not retried as the new user", async () => {
    const el = mount();
    el.tokenProvider = () => jwt({ sub: "alice", exp: now() + 600 });
    let release: (r: Response) => void = () => {};
    turnAnswers = [
      () =>
        new Promise<Response>((done) => {
          release = done;
        }) as unknown as Response,
    ];
    await ask(el, "pergunta da alice");
    await until(() => sent.some((x) => x.url.endsWith("/turn")));
    el.tokenProvider = () => jwt({ sub: "bob", exp: now() + 600 });
    release(
      new BunResponse(JSON.stringify({ error: "x" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await Bun.sleep(30);
    expect(sent.filter((x) => x.url.endsWith("/turn")).length).toBe(1);
  });

  test("a turn stopped by a change of identity while its tool runs forgets the suspended thread", async () => {
    const el = mount();
    el.tokenProvider = () => jwt({ sub: "alice", exp: now() + 600 });
    let finish: () => void = () => {};
    el.tool({
      name: "lento",
      description: "lento",
      run: () =>
        new Promise<string>((done) => {
          finish = () => done("ok");
        }),
    });
    turnAnswers = [
      () =>
        sse([
          "pending",
          {
            threadId: "talice",
            status: "pending",
            calls: [{ toolCallId: "c", name: "lento", args: {} }],
          },
        ]),
    ];
    await ask(el, "pergunta da alice");
    await until(
      () => localStorage.getItem("fazer-ai-agent:app_teste:alice") === "talice",
    );
    el.tokenProvider = () => jwt({ sub: "bob", exp: now() + 600 });
    finish();
    await Bun.sleep(20);
    expect({
      turns: sent.filter((x) => x.url.endsWith("/turn")).length,
      alice: localStorage.getItem("fazer-ai-agent:app_teste:alice"),
    }).toEqual({ turns: 1, alice: null });
  });

  test("answers that completed the turn as the identity changed keep that user's conversation", async () => {
    const el = mount();
    el.tokenProvider = () => jwt({ sub: "alice", exp: now() + 600 });
    el.tool({ name: "ler", description: "lê", run: () => 1 });
    let release: (r: Response) => void = () => {};
    turnAnswers = [
      () =>
        sse([
          "pending",
          {
            threadId: "talice",
            status: "pending",
            calls: [{ toolCallId: "c", name: "ler", args: {} }],
          },
        ]),
      () =>
        new Promise<Response>((done) => {
          release = done;
        }) as unknown as Response,
    ];
    await ask(el, "pergunta da alice");
    await until(() => sent.filter((x) => x.url.endsWith("/turn")).length === 2);
    el.tokenProvider = () => jwt({ sub: "bob", exp: now() + 600 });
    release(
      sse(["done", { threadId: "talice", status: "done", reply: "pronto" }]),
    );
    await Bun.sleep(20);
    expect(localStorage.getItem("fazer-ai-agent:app_teste:alice")).toBe(
      "talice",
    );
  });

  test("a draft typed by the previous user is not left for the next", () => {
    const el = mount();
    el.tokenProvider = () => jwt({ sub: "alice", exp: now() + 600 });
    el.open();
    const root = el.shadowRoot as ShadowRoot;
    const input = root.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "rascunho da alice";
    input.dispatchEvent(new Event("input"));
    el.identityChanged();
    expect({
      value: input.value,
      send: (root.querySelector(".send") as HTMLButtonElement).disabled,
    }).toEqual({ value: "", send: true });
  });

  test("a stored thread that comes back pending after the identity changed is forgotten", async () => {
    localStorage.setItem("fazer-ai-agent:app_teste:alice", "talice");
    const el = mount();
    el.tokenProvider = () => jwt({ sub: "alice", exp: now() + 600 });
    el.tool({ name: "ler", description: "lê", run: () => 1 });
    let release: (r: Response) => void = () => {};
    turnAnswers = [
      () =>
        new Promise<Response>((done) => {
          release = done;
        }) as unknown as Response,
    ];
    await ask(el, "pergunta da alice");
    await until(() => sent.some((x) => x.url.endsWith("/turn")));
    el.tokenProvider = () => jwt({ sub: "bob", exp: now() + 600 });
    release(
      sse([
        "pending",
        {
          threadId: "talice",
          status: "pending",
          calls: [{ toolCallId: "c", name: "ler", args: {} }],
        },
      ]),
    );
    await Bun.sleep(20);
    expect({
      body: sent.find((x) => x.url.endsWith("/turn"))?.body?.threadId,
      alice: localStorage.getItem("fazer-ai-agent:app_teste:alice"),
    }).toEqual({ body: "talice", alice: null });
  });

  test("a stored thread still suspended from a page that reloaded is dropped and a new one started", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    localStorage.setItem("fazer-ai-agent:app_teste:42", "presa");
    const el = mount();
    turnAnswers = [
      () =>
        new BunResponse(JSON.stringify({ error: "esperando respostas" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      () =>
        sse(["done", { threadId: "nova", status: "done", reply: "resposta" }]),
    ];
    await ask(el, "olá");
    await until(() => logText(el).includes("resposta"));
    expect({
      threads: sent.slice(1).map((x) => x.body?.threadId ?? null),
      stored: localStorage.getItem("fazer-ai-agent:app_teste:42"),
    }).toEqual({ threads: ["presa", null], stored: "nova" });
  });

  test("texts assigned after the widget is on the page are shown", () => {
    const el = mount();
    el.setAttribute("mode", "inline");
    el.texts = { placeholder: "Pergunte sobre a nota", title: "Ajuda" };
    const root = el.shadowRoot as ShadowRoot;
    expect({
      placeholder: (root.querySelector("textarea") as HTMLTextAreaElement)
        .placeholder,
      title: root.textContent?.includes("Ajuda"),
    }).toEqual({ placeholder: "Pergunte sobre a nota", title: true });
  });

  test("the tag's title attribute stays the browser's tooltip and does not name the panel", () => {
    const el = mount();
    el.setAttribute("title", "Dica do navegador");
    el.texts = { empty: "vazio" }; // repaints the panel
    expect((el.shadowRoot as ShadowRoot).querySelector("h2")?.textContent).toBe(
      "Assistente",
    );
  });

  test("a page tool shows a progress line with its label while it runs, and how it ended", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    const target = document.createElement("div");
    target.setAttribute("data-fazer-ai-target", "nota");
    document.body.appendChild(target);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    el.tool({
      name: "abrir_nota",
      label: "Abrindo a nota",
      description: "Abre uma nota",
      run: async () => {
        await gate;
        return { aberta: true };
      },
    });
    el.tool({
      name: "falhar",
      description: "Sempre falha",
      run: () => {
        throw new Error("não deu");
      },
    });
    turnAnswers = [
      () =>
        sse([
          "pending",
          {
            threadId: "t1",
            status: "pending",
            calls: [
              { toolCallId: "c1", name: "abrir_nota", args: {} },
              { toolCallId: "c2", name: "falhar", args: {} },
              {
                toolCallId: "c3",
                name: "highlight_element",
                args: { target: "nota" },
              },
            ],
          },
        ]),
      () => sse(["done", { threadId: "t1", status: "done", reply: "Pronto." }]),
    ];
    await ask(el, "abre a nota");
    await until(() => logText(el).includes("… Abrindo a nota"));
    const running = logText(el);
    release();
    await until(() => logText(el).includes("Pronto."));
    const steps = [
      ...(el.shadowRoot as ShadowRoot).querySelectorAll(".step"),
    ].map((p) => p.textContent);
    expect({ running: running.includes("falhar"), steps }).toEqual({
      running: false,
      steps: ["✓ Abrindo a nota", "✗ falhar"],
    });
  });

  test("a turn that loses its claim inside the stream is not sent again", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    localStorage.setItem("fazer-ai-agent:app_teste:42", "t");
    const el = mount();
    turnAnswers = [
      () =>
        sse(["ping", ""], ["error", { status: 409, error: "perdeu o claim" }]),
    ];
    await ask(el, "emite a nota");
    await until(() => logText(el).includes("perdeu o claim"));
    expect(sent.filter((x) => x.url.endsWith("/turn")).length).toBe(1);
  });

  test("an inline mode set after the widget is on the page shows the panel", () => {
    const el = mount();
    el.setAttribute("mode", "inline");
    expect(
      ((el.shadowRoot as ShadowRoot).querySelector(".panel") as HTMLElement)
        .hidden,
    ).toBe(false);
  });

  test("no turn is posted after the identity changed, wherever in the request the change lands", async () => {
    for (let depth = 0; depth < 12; depth++) {
      document.body.replaceChildren();
      sent = [];
      const el = mount();
      el.tokenProvider = () => jwt({ sub: "alice", exp: now() + 600 });
      turnAnswers = [
        () => sse(["done", { threadId: "t", status: "done", reply: "um" }]),
        () => sse(["done", { threadId: "t", status: "done", reply: "dois" }]),
      ];
      await ask(el, "primeira");
      await until(() => logText(el).includes("um"));
      const before = sent.length;
      let changedAt = -1;
      const change = (left: number) => {
        if (left === 0) {
          changedAt = sent.length;
          el.tokenProvider = () => jwt({ sub: "bob", exp: now() + 600 });
        } else queueMicrotask(() => change(left - 1));
      };
      const root = el.shadowRoot as ShadowRoot;
      const input = root.querySelector("textarea") as HTMLTextAreaElement;
      input.value = "segunda";
      input.dispatchEvent(new Event("input"));
      (root.querySelector("form") as HTMLFormElement).dispatchEvent(
        new Event("submit", { cancelable: true }),
      );
      change(depth);
      await Bun.sleep(10);
      expect({
        depth,
        late: sent.slice(Math.max(before, changedAt)).length,
      }).toEqual({ depth, late: 0 });
    }
  });

  test("a context callback that signs another user in stops the turn before it is posted", async () => {
    const el = mount();
    el.tokenProvider = () => jwt({ sub: "alice", exp: now() + 600 });
    el.context(() => {
      el.tokenProvider = () => jwt({ sub: "bob", exp: now() + 600 });
      return { tela: "x" };
    });
    await ask(el, "pergunta da alice");
    await Bun.sleep(20);
    expect(sent.filter((x) => x.url.endsWith("/turn")).length).toBe(0);
  });

  test("a renewal that names another user clears the draft being typed", async () => {
    tokens = [
      jwt({ sub: "42", exp: now() + 600 }),
      jwt({ sub: "99", exp: now() + 600 }),
    ];
    const el = mount();
    let release: (r: Response) => void = () => {};
    turnAnswers = [
      () =>
        new Promise<Response>((done) => {
          release = done;
        }) as unknown as Response,
      () => sse(["done", { threadId: "t99", status: "done", reply: "oi 99" }]),
    ];
    await ask(el, "primeira");
    await until(() => sent.some((x) => x.url.endsWith("/turn")));
    const input = (el.shadowRoot as ShadowRoot).querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    input.value = "rascunho do 42";
    input.dispatchEvent(new Event("input"));
    release(
      new BunResponse(JSON.stringify({ error: "x" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await until(() => logText(el).includes("oi 99"));
    expect(input.value).toBe("");
  });

  test("with no way to sign a user in, the widget opens an anonymous session and keeps it for the next load", async () => {
    const token = jwt({ sub: "AAAAAAAAAAAAAAAAAAAAAA", exp: now() + 600 });
    const session = "anon_AAAAAAAAAAAAAAAAAAAAAA.sig";
    const first = mount();
    first.removeAttribute("token-url");
    turnAnswers = [
      () => new BunResponse(JSON.stringify({ session, token })),
      () =>
        sse([
          "done",
          { threadId: "t", status: "done", reply: "olá, visitante" },
        ]),
    ];
    await ask(first, "oi");
    await until(() => logText(first).includes("olá, visitante"));
    document.body.replaceChildren();
    const second = mount();
    second.removeAttribute("token-url");
    turnAnswers = [
      () => new BunResponse(JSON.stringify({ session, token })),
      () => sse(["done", { threadId: "t", status: "done", reply: "de volta" }]),
    ];
    await ask(second, "voltei");
    await until(() => logText(second).includes("de volta"));
    const sessions = sent.filter((x) => x.url.endsWith("/session"));
    expect({
      sessions: sessions.map((x) => x.body?.session ?? null),
      auth: sent.filter((x) => x.url.endsWith("/turn")).map((x) => x.auth),
      resumed: sent.filter((x) => x.url.endsWith("/turn")).at(-1)?.body
        ?.threadId,
    }).toEqual({
      sessions: [null, session],
      auth: [`Bearer ${token}`, `Bearer ${token}`],
      resumed: "t",
    });
  });

  test("opening the panel with a credential the instance no longer knows only asks to renew it, and opens no new session", async () => {
    localStorage.setItem("fazer-ai-agent:app_teste#session", "anon_velha.s");
    const el = mount();
    el.removeAttribute("token-url");
    turnAnswers = [
      () =>
        new BunResponse(JSON.stringify({ error: "unknown" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    ];
    el.open();
    await until(() => sent.some((x) => x.url.endsWith("/session")));
    await new Promise((r) => setTimeout(r, 10));
    expect({
      sessions: sent
        .filter((x) => x.url.endsWith("/session"))
        .map((x) => x.body),
      log: logText(el),
    }).toEqual({
      sessions: [{ session: "anon_velha.s", renew: true }],
      log: EMPTY,
    });
  });

  test("signing in after an anonymous conversation hands it over once and continues it as the user", async () => {
    const anon = jwt({ sub: "AAAAAAAAAAAAAAAAAAAAAA", exp: now() + 600 });
    const user = jwt({ sub: "42", exp: now() + 600 });
    const el = mount();
    el.removeAttribute("token-url");
    turnAnswers = [
      () =>
        new BunResponse(JSON.stringify({ session: "anon_x.y", token: anon })),
      () =>
        sse(["done", { threadId: "ta", status: "done", reply: "visitante" }]),
      () => new BunResponse(JSON.stringify({ threadIds: ["ta"] })),
      () => sse(["done", { threadId: "ta", status: "done", reply: "usuário" }]),
    ];
    await ask(el, "oi");
    await until(() => logText(el).includes("visitante"));
    tokens = [user];
    el.setAttribute("token-url", "/token");
    await ask(el, "entrei");
    await until(() => logText(el).includes("usuário"));
    const claim = sent.find((x) => x.url.endsWith("/session/claim"));
    const turns = sent.filter((x) => x.url.endsWith("/turn"));
    expect({
      claim: [claim?.auth, claim?.body],
      auth: turns.map((x) => x.auth),
      continued: turns.at(-1)?.body?.threadId,
      credential: localStorage.getItem("fazer-ai-agent:app_teste#session"),
      stored: localStorage.getItem("fazer-ai-agent:app_teste:42"),
    }).toEqual({
      claim: [`Bearer ${user}`, { session: "anon_x.y" }],
      auth: [`Bearer ${anon}`, `Bearer ${user}`],
      continued: "ta",
      credential: null,
      stored: "ta",
    });
  });

  test("a hand-over that fails keeps the credential and does not stop the signed-in turn", async () => {
    localStorage.setItem("fazer-ai-agent:app_teste#session", "anon_x.y");
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    turnAnswers = [
      () => new BunResponse(JSON.stringify({ error: "x" }), { status: 500 }),
      () => sse(["done", { threadId: "t", status: "done", reply: "segue" }]),
    ];
    await ask(el, "oi");
    await until(() => logText(el).includes("segue"));
    expect({
      threadId:
        sent.filter((x) => x.url.endsWith("/turn")).at(-1)?.body?.threadId ??
        null,
      credential: localStorage.getItem("fazer-ai-agent:app_teste#session"),
    }).toEqual({ threadId: null, credential: "anon_x.y" });
  });

  test("a session credential lost from storage is still renewed from memory", async () => {
    const token = jwt({ sub: "AAAAAAAAAAAAAAAAAAAAAA", exp: now() + 600 });
    const el = mount();
    el.removeAttribute("token-url");
    turnAnswers = [
      () => new BunResponse(JSON.stringify({ session: "anon_x.y", token })),
      () => sse(["done", { threadId: "t", status: "done", reply: "um" }]),
      () =>
        new BunResponse(JSON.stringify({ error: "x" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      () => new BunResponse(JSON.stringify({ session: "anon_x.y", token })),
      () => sse(["done", { threadId: "t", status: "done", reply: "renovado" }]),
    ];
    await ask(el, "primeira");
    await until(() => logText(el).includes("um"));
    localStorage.clear();
    await ask(el, "segunda");
    await until(() => logText(el).includes("renovado"));
    expect(
      sent
        .filter((x) => x.url.endsWith("/session"))
        .map((x) => x.body?.session ?? null),
    ).toEqual([null, "anon_x.y"]);
  });

  test("an anonymous session that answers after a change of identity is not kept", async () => {
    const token = jwt({ sub: "AAAAAAAAAAAAAAAAAAAAAA", exp: now() + 600 });
    const el = mount();
    el.removeAttribute("token-url");
    let releaseOld: (r: Response) => void = () => {};
    turnAnswers = [
      () =>
        new Promise<Response>((done) => {
          releaseOld = done;
        }) as unknown as Response,
      () => new BunResponse(JSON.stringify({ session: "anon_nova.s", token })),
      () => sse(["done", { threadId: "t", status: "done", reply: "nova" }]),
    ];
    await ask(el, "primeira");
    await until(() => sent.some((x) => x.url.endsWith("/session")));
    el.identityChanged();
    await ask(el, "segunda");
    await until(() => logText(el).includes("nova"));
    releaseOld(
      new BunResponse(JSON.stringify({ session: "anon_velha.s", token })),
    );
    await Bun.sleep(20);
    expect(localStorage.getItem("fazer-ai-agent:app_teste#session")).toBe(
      "anon_nova.s",
    );
  });

  test("New conversation pressed before signing in is not undone by the hand-over", async () => {
    localStorage.setItem("fazer-ai-agent:app_teste#session", "anon_x.y");
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    el.reset();
    turnAnswers = [
      () => new BunResponse(JSON.stringify({ threadIds: ["ta"] })),
      () =>
        sse(["done", { threadId: "nova", status: "done", reply: "do zero" }]),
    ];
    await ask(el, "oi");
    await until(() => logText(el).includes("do zero"));
    expect(
      sent.filter((x) => x.url.endsWith("/turn")).at(-1)?.body?.threadId ??
        null,
    ).toBeNull();
  });

  test("New conversation pressed after a failed hand-over is not undone when it is retried", async () => {
    localStorage.setItem("fazer-ai-agent:app_teste#session", "anon_x.y");
    tokens = [
      jwt({ sub: "42", exp: now() + 600 }),
      jwt({ sub: "42", exp: now() + 600 }),
    ];
    const el = mount();
    turnAnswers = [
      () => new BunResponse(JSON.stringify({ error: "x" }), { status: 500 }),
      () =>
        sse(["done", { threadId: "t1", status: "done", reply: "primeira" }]),
    ];
    await ask(el, "oi");
    await until(() => logText(el).includes("primeira"));
    el.reset();
    turnAnswers = [
      () =>
        new BunResponse(JSON.stringify({ error: "x" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      () => new BunResponse(JSON.stringify({ threadIds: ["ta"] })),
      () =>
        sse(["done", { threadId: "nova", status: "done", reply: "do zero" }]),
    ];
    await ask(el, "de novo");
    await until(() => logText(el).includes("do zero"));
    expect(
      sent.filter((x) => x.url.endsWith("/turn")).at(-1)?.body?.threadId ??
        null,
    ).toBeNull();
  });

  test("New conversation pressed while anonymous does not stop the hand-over of the conversation that followed it", async () => {
    const anon = jwt({ sub: "AAAAAAAAAAAAAAAAAAAAAA", exp: now() + 600 });
    const el = mount();
    el.removeAttribute("token-url");
    turnAnswers = [
      () =>
        new BunResponse(JSON.stringify({ session: "anon_x.y", token: anon })),
      () => sse(["done", { threadId: "ta", status: "done", reply: "antes" }]),
      () => sse(["done", { threadId: "tb", status: "done", reply: "depois" }]),
      () => new BunResponse(JSON.stringify({ threadIds: ["tb", "ta"] })),
      () => sse(["done", { threadId: "tb", status: "done", reply: "logado" }]),
    ];
    await ask(el, "oi");
    await until(() => logText(el).includes("antes"));
    el.reset();
    await ask(el, "outra");
    await until(() => logText(el).includes("depois"));
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    el.setAttribute("token-url", "/token");
    await ask(el, "entrei");
    await until(() => logText(el).includes("logado"));
    expect(
      sent.filter((x) => x.url.endsWith("/turn")).at(-1)?.body?.threadId,
    ).toBe("tb");
  });

  test("a renewal that names another user lets that user take the hand-over, whatever the previous one reset", async () => {
    localStorage.setItem("fazer-ai-agent:app_teste#session", "anon_x.y");
    tokens = [
      jwt({ sub: "42", exp: now() + 600 }),
      jwt({ sub: "99", exp: now() + 600 }),
    ];
    const el = mount();
    turnAnswers = [
      () => new BunResponse(JSON.stringify({ error: "x" }), { status: 500 }),
      () => sse(["done", { threadId: "t42", status: "done", reply: "do 42" }]),
    ];
    await ask(el, "oi");
    await until(() => logText(el).includes("do 42"));
    el.reset();
    turnAnswers = [
      () =>
        new BunResponse(JSON.stringify({ error: "x" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      () => new BunResponse(JSON.stringify({ threadIds: ["ta"] })),
      () => sse(["done", { threadId: "ta", status: "done", reply: "do 99" }]),
    ];
    await ask(el, "agora");
    await until(() => logText(el).includes("do 99"));
    expect(
      sent.filter((x) => x.url.endsWith("/turn")).at(-1)?.body?.threadId,
    ).toBe("ta");
  });

  // A page with its own fixed bar at the bottom (a phone's tab bar) moves the button and its panel
  // above it; with nothing set, both keep their 24px from the corner.
  test("the floating button and its panel follow the page's offsets, and keep the corner without them", () => {
    const el = mount();
    const css = [...(el.shadowRoot as ShadowRoot).querySelectorAll("style")]
      .map((s) => s.textContent ?? "")
      .join("\n");
    const rule = (selector: string) =>
      css.match(
        new RegExp(
          `(^|\\n)${selector.replace(/[.[\]()"=]/g, "\\$&")} \\{([^}]*)\\}`,
        ),
      )?.[2] ?? "";
    expect({
      fab: rule(".fab").replace(/\s+/g, " "),
      panel: rule(".panel").replace(/\s+/g, " "),
    }).toMatchObject({
      fab: expect.stringContaining(
        "bottom: var(--fazer-ai-offset-bottom, 24px); right: var(--fazer-ai-offset-side, 24px)",
      ),
      panel: expect.stringMatching(
        /bottom: calc\(var\(--fazer-ai-offset-bottom, 24px\) \+ 64px\).*width: min\(400px, calc\(100vw - var\(--fazer-ai-offset-side, 24px\) - 16px\)\)/,
      ),
    });
  });

  describe("the conversation shown again after a reload", () => {
    // A page that reloaded: the element is gone and a new one mounts, with only storage left.
    async function talkThenReload(sub: string): Promise<FazerAiAgent> {
      tokens = [jwt({ sub, exp: now() + 600 })];
      const before = mount();
      turnAnswers = [
        () =>
          sse([
            "done",
            { threadId: "t1", status: "done", reply: "a resposta" },
          ]),
      ];
      await ask(before, "a pergunta");
      await until(() => logText(before).includes("a resposta"));
      before.remove();
      sent = [];
      return before;
    }

    test("opening the panel shows the earlier messages before anything is sent", async () => {
      await talkThenReload("42");
      tokens = [jwt({ sub: "42", exp: now() + 600 })];
      const el = mount();
      el.open();
      await until(() => logText(el).includes("a resposta"));
      const msgs = [
        ...(el.shadowRoot as ShadowRoot).querySelectorAll(".msg"),
      ].map(
        (m) =>
          `${m.classList.contains("user") ? "user" : "agent"}:${m.textContent}`,
      );
      expect({
        msgs,
        turns: sent.filter((x) => x.url.endsWith("/turn")).length,
      }).toEqual({ msgs: ["user:a pergunta", "agent:a resposta"], turns: 0 });
    });

    test("another user signed in on the same browser sees none of it", async () => {
      await talkThenReload("42");
      tokens = [jwt({ sub: "99", exp: now() + 600 })];
      const el = mount();
      el.open();
      await until(() => sent.some((x) => x.url.startsWith("/token")));
      await new Promise((r) => setTimeout(r, 10));
      expect(logText(el)).toBe(EMPTY);
    });

    test("New conversation forgets what would be shown again", async () => {
      const before = await talkThenReload("42");
      document.body.appendChild(before);
      before.reset();
      before.remove();
      tokens = [jwt({ sub: "42", exp: now() + 600 })];
      const el = mount();
      el.open();
      await until(() => sent.some((x) => x.url.startsWith("/token")));
      await new Promise((r) => setTimeout(r, 10));
      expect(logText(el)).toBe(EMPTY);
    });

    test("a message sent while the panel restores asks for the token once and follows the earlier messages", async () => {
      await talkThenReload("42");
      tokens = [jwt({ sub: "42", exp: now() + 600 })];
      const el = mount();
      turnAnswers = [
        () =>
          sse(["done", { threadId: "t1", status: "done", reply: "segunda" }]),
      ];
      await ask(el, "outra");
      await until(() => logText(el).includes("segunda"));
      const msgs = [
        ...(el.shadowRoot as ShadowRoot).querySelectorAll(".msg"),
      ].map((m) => m.textContent);
      expect({
        msgs,
        tokenAsks: sent.filter((x) => x.url.startsWith("/token")).length,
        thread: sent.find((x) => x.url.endsWith("/turn"))?.body?.threadId,
      }).toEqual({
        msgs: ["a pergunta", "a resposta", "outra", "segunda"],
        tokenAsks: 1,
        thread: "t1",
      });
    });

    test("a thread the instance no longer knows keeps none of its messages for the one that replaces it", async () => {
      await talkThenReload("42");
      tokens = [jwt({ sub: "42", exp: now() + 600 })];
      const el = mount();
      turnAnswers = [
        () =>
          new BunResponse(JSON.stringify({ error: "thread not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        () => sse(["done", { threadId: "t2", status: "done", reply: "nova" }]),
      ];
      await ask(el, "de novo");
      await until(() => logText(el).includes("nova"));
      el.remove();
      tokens = [jwt({ sub: "42", exp: now() + 600 })];
      const reloaded = mount();
      reloaded.open();
      await until(() => logText(reloaded).includes("nova"));
      expect(
        [...(reloaded.shadowRoot as ShadowRoot).querySelectorAll(".msg")].map(
          (m) => m.textContent,
        ),
      ).toEqual(["de novo", "nova"]);
    });

    test("signing in takes the anonymous conversation along, and a message sent during the hand-over continues it", async () => {
      const anon = jwt({ sub: "AAAAAAAAAAAAAAAAAAAAAA", exp: now() + 600 });
      const anonymous = mount();
      anonymous.removeAttribute("token-url");
      turnAnswers = [
        () =>
          new BunResponse(JSON.stringify({ session: "anon_x.y", token: anon })),
        () =>
          sse(["done", { threadId: "ta", status: "done", reply: "visitante" }]),
      ];
      await ask(anonymous, "oi");
      await until(() => logText(anonymous).includes("visitante"));
      anonymous.remove();
      let handOver = () => {};
      const handedOver = new Promise<Response>((r) => {
        handOver = () =>
          r(new BunResponse(JSON.stringify({ threadIds: ["ta"] })));
      });
      tokens = [jwt({ sub: "42", exp: now() + 600 })];
      turnAnswers = [
        () => handedOver as unknown as Response,
        () =>
          sse(["done", { threadId: "ta", status: "done", reply: "logado" }]),
      ];
      sent = [];
      const el = mount();
      el.open();
      await until(() => sent.some((x) => x.url.endsWith("/session/claim")));
      await ask(el, "entrei");
      handOver();
      await until(() => logText(el).includes("logado"));
      expect({
        msgs: [...(el.shadowRoot as ShadowRoot).querySelectorAll(".msg")].map(
          (m) => m.textContent,
        ),
        continued: sent.find((x) => x.url.endsWith("/turn"))?.body?.threadId,
        moved: JSON.parse(
          localStorage.getItem("fazer-ai-agent:app_teste:42#log") ?? "{}",
        ).messages?.length,
      }).toEqual({
        msgs: ["oi", "visitante", "entrei", "logado"],
        continued: "ta",
        moved: 4,
      });
    });

    test("an anonymous visitor with no session yet opens none by opening the panel", async () => {
      const el = mount();
      el.removeAttribute("token-url");
      el.open();
      await new Promise((r) => setTimeout(r, 20));
      expect(sent.length).toBe(0);
    });
  });

  describe("the Turnstile challenge before a new anonymous session", () => {
    // Cloudflare's widget replaced on `window.turnstile`, which the element uses when the page already
    // loaded it: each render answers the next outcome, and records where it was put.
    let outcomes: Array<"error" | "pending" | string> = [];
    let rendered: Array<{ sitekey: string; slot: string; inHost: boolean }> =
      [];
    let removed = 0;
    beforeAll(() => {
      (window as unknown as { turnstile: unknown }).turnstile = {
        render(
          el: HTMLElement,
          o: {
            sitekey: string;
            callback: (t: string) => void;
            "error-callback": () => void;
          },
        ) {
          rendered.push({
            sitekey: o.sitekey,
            slot: el.slot,
            inHost: el.parentElement?.tagName === "FAZER-AI-AGENT",
          });
          const next = outcomes.shift() ?? "error";
          if (next !== "pending")
            setTimeout(() =>
              next === "error" ? o["error-callback"]() : o.callback(next),
            );
          return `w${rendered.length}`;
        },
        remove() {
          removed++;
        },
      };
    });
    afterAll(() => {
      delete (window as unknown as { turnstile?: unknown }).turnstile;
    });
    afterEach(() => {
      outcomes = [];
      rendered = [];
      removed = 0;
    });

    const anonToken = () =>
      jwt({ sub: "AAAAAAAAAAAAAAAAAAAAAA", exp: now() + 600 });
    const SESSION = "anon_AAAAAAAAAAAAAAAAAAAAAA.sig";
    function mountChallenged(): FazerAiAgent {
      const el = mount();
      el.removeAttribute("token-url");
      el.setAttribute("turnstile-site-key", "0x4AAAAAAAchave");
      return el;
    }
    const challengeLeft = (el: FazerAiAgent) =>
      el.querySelectorAll('[slot="challenge"]').length;

    test("a new session is opened with the solved challenge, shown in the panel and gone after", async () => {
      outcomes = ["tok-1"];
      const el = mountChallenged();
      turnAnswers = [
        () =>
          new BunResponse(
            JSON.stringify({ session: SESSION, token: anonToken() }),
          ),
        () => sse(["done", { threadId: "t", status: "done", reply: "olá" }]),
      ];
      await ask(el, "oi");
      await until(() => logText(el).includes("olá"));
      const slot = (el.shadowRoot as ShadowRoot).querySelector(
        '.panel slot[name="challenge"]',
      );
      expect({
        rendered,
        removed,
        left: challengeLeft(el),
        slotInPanel: slot !== null,
        body: sent.find((x) => x.url.endsWith("/session"))?.body,
      }).toEqual({
        rendered: [
          { sitekey: "0x4AAAAAAAchave", slot: "challenge", inHost: true },
        ],
        removed: 1,
        left: 0,
        slotInPanel: true,
        body: { turnstile: "tok-1" },
      });
    });

    test("a held session renews with no challenge, and one the instance refuses for it asks the challenge once", async () => {
      localStorage.setItem("fazer-ai-agent:app_teste#session", SESSION);
      outcomes = ["tok-2"];
      const el = mountChallenged();
      // Opening the panel only asks to renew, and the instance that no longer knows the credential
      // says so; the message then asks with it, and the refusal for the challenge asks it once.
      turnAnswers = [
        () =>
          new BunResponse(JSON.stringify({ error: "unknown" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        () =>
          new BunResponse(JSON.stringify({ error: "x", field: "turnstile" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
        () =>
          new BunResponse(
            JSON.stringify({ session: "anon_BBBB.sig", token: anonToken() }),
          ),
        () => sse(["done", { threadId: "t", status: "done", reply: "nova" }]),
      ];
      await ask(el, "oi");
      await until(() => logText(el).includes("nova"));
      expect({
        bodies: sent
          .filter((x) => x.url.endsWith("/session"))
          .map((x) => x.body),
        rendered: rendered.length,
        stored: localStorage.getItem("fazer-ai-agent:app_teste#session"),
      }).toEqual({
        bodies: [
          { session: SESSION, renew: true },
          { session: SESSION },
          { turnstile: "tok-2" },
        ],
        rendered: 1,
        stored: "anon_BBBB.sig",
      });
    });

    test("a refused credential is forgotten even when the retry fails, so the next attempt solves first", async () => {
      localStorage.setItem("fazer-ai-agent:app_teste#session", SESSION);
      outcomes = ["error"];
      const el = mountChallenged();
      turnAnswers = [
        () =>
          new BunResponse(JSON.stringify({ error: "x", field: "turnstile" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ];
      await ask(el, "oi");
      await until(() => logText(el).includes("Não foi possível entrar"));
      expect({
        stored: localStorage.getItem("fazer-ai-agent:app_teste#session"),
        sessions: sent.filter((x) => x.url.endsWith("/session")).length,
      }).toEqual({ stored: null, sessions: 1 });
    });

    test("a refusal that is not about the challenge does not show it", async () => {
      localStorage.setItem("fazer-ai-agent:app_teste#session", SESSION);
      const el = mountChallenged();
      turnAnswers = [
        () =>
          new BunResponse(JSON.stringify({ error: "origin" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ];
      await ask(el, "oi");
      await until(() => logText(el).includes("Não foi possível entrar"));
      expect({
        sessions: sent.filter((x) => x.url.endsWith("/session")).length,
        rendered: rendered.length,
      }).toEqual({ sessions: 1, rendered: 0 });
    });

    test("a change of identity takes down a pending challenge, and it opens no session", async () => {
      outcomes = ["pending"];
      const el = mountChallenged();
      await ask(el, "oi");
      await until(() => rendered.length === 1);
      const shownBefore = challengeLeft(el);
      el.identityChanged();
      await until(() => challengeLeft(el) === 0);
      await new Promise((r) => setTimeout(r, 20));
      expect({
        shownBefore,
        removed,
        sessions: sent.filter((x) => x.url.endsWith("/session")).length,
      }).toEqual({ shownBefore: 1, removed: 1, sessions: 0 });
    });

    test("a voice message cancelled while its challenge is pending takes the challenge down, and the next message asks anew", async () => {
      outcomes = ["pending", "tok-2"];
      const g = globalThis as { MediaRecorder?: unknown };
      const realRecorder = g.MediaRecorder;
      const realDevices = Object.getOwnPropertyDescriptor(
        navigator,
        "mediaDevices",
      );
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => ({ getTracks: () => [new FakeTrack()] }),
        },
      });
      g.MediaRecorder = FakeRecorder;
      try {
        const el = mountChallenged();
        const root = el.shadowRoot as ShadowRoot;
        el.open();
        (root.querySelector(".mic") as HTMLButtonElement).click();
        await until(
          () =>
            (root.querySelector(".rec") as HTMLElement).dataset.state ===
            "recording",
        );
        setSystemTime(new Date(Date.now() + 2_000));
        (root.querySelector(".rec-send") as HTMLButtonElement).click();
        await until(() => rendered.length === 1);
        (root.querySelector(".rec-cancel") as HTMLButtonElement).click();
        await until(() => challengeLeft(el) === 0);
        turnAnswers = [
          () =>
            new BunResponse(
              JSON.stringify({ session: SESSION, token: anonToken() }),
            ),
          () => sse(["done", { threadId: "t", status: "done", reply: "olá" }]),
        ];
        await ask(el, "oi");
        await until(() => logText(el).includes("olá"));
        expect({
          rendered: rendered.length,
          sessions: sent
            .filter((x) => x.url.endsWith("/session"))
            .map((x) => x.body),
          transcriptions: sent.filter((x) => x.url.endsWith("/transcribe"))
            .length,
        }).toEqual({
          rendered: 2,
          sessions: [{ turnstile: "tok-2" }],
          transcriptions: 0,
        });
      } finally {
        setSystemTime();
        if (realDevices)
          Object.defineProperty(navigator, "mediaDevices", realDevices);
        else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
        g.MediaRecorder = realRecorder;
      }
    });

    test("a voice message cancelled while its session is asked for shows no challenge when the instance then wants one", async () => {
      outcomes = ["tok-3"];
      localStorage.setItem("fazer-ai-agent:app_teste#session", SESSION);
      const g = globalThis as { MediaRecorder?: unknown };
      const realRecorder = g.MediaRecorder;
      const realDevices = Object.getOwnPropertyDescriptor(
        navigator,
        "mediaDevices",
      );
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => ({ getTracks: () => [new FakeTrack()] }),
        },
      });
      g.MediaRecorder = FakeRecorder;
      let answerSession: (r: Response) => void = () => {};
      try {
        const el = mountChallenged();
        const root = el.shadowRoot as ShadowRoot;
        // NOTE: the panel's quiet renewal on open is answered first, as a session the instance lost.
        turnAnswers = [
          () =>
            new BunResponse(JSON.stringify({ error: "x" }), { status: 404 }),
        ];
        el.open();
        await until(() => turnAnswers.length === 0);
        await new Promise((r) => setTimeout(r, 20));
        localStorage.setItem("fazer-ai-agent:app_teste#session", SESSION);
        (root.querySelector(".mic") as HTMLButtonElement).click();
        await until(
          () =>
            (root.querySelector(".rec") as HTMLElement).dataset.state ===
            "recording",
        );
        setSystemTime(new Date(Date.now() + 2_000));
        turnAnswers = [
          () =>
            new Promise<Response>((r) => {
              answerSession = r;
            }) as unknown as Response,
        ];
        (root.querySelector(".rec-send") as HTMLButtonElement).click();
        await until(() => turnAnswers.length === 0);
        (root.querySelector(".rec-cancel") as HTMLButtonElement).click();
        answerSession(
          new BunResponse(JSON.stringify({ error: "x", field: "turnstile" }), {
            status: 403,
          }),
        );
        // The refusal forgets the credential just before the challenge would be asked for.
        await until(
          () =>
            localStorage.getItem("fazer-ai-agent:app_teste#session") === null,
        );
        await new Promise((r) => setTimeout(r, 20));
        expect({
          rendered: rendered.length,
          left: challengeLeft(el),
          transcriptions: sent.filter((x) => x.url.endsWith("/transcribe"))
            .length,
        }).toEqual({ rendered: 0, left: 0, transcriptions: 0 });
      } finally {
        setSystemTime();
        if (realDevices)
          Object.defineProperty(navigator, "mediaDevices", realDevices);
        else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
        g.MediaRecorder = realRecorder;
      }
    });

    test("a message typed while a cancelled voice message's session is still asked for asks again, with a challenge of its own", async () => {
      outcomes = ["tok-4"];
      localStorage.setItem("fazer-ai-agent:app_teste#session", SESSION);
      const g = globalThis as { MediaRecorder?: unknown };
      const realRecorder = g.MediaRecorder;
      const realDevices = Object.getOwnPropertyDescriptor(
        navigator,
        "mediaDevices",
      );
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => ({ getTracks: () => [new FakeTrack()] }),
        },
      });
      g.MediaRecorder = FakeRecorder;
      let answerSession: (r: Response) => void = () => {};
      try {
        const el = mountChallenged();
        const root = el.shadowRoot as ShadowRoot;
        turnAnswers = [
          () =>
            new BunResponse(JSON.stringify({ error: "x" }), { status: 404 }),
        ];
        el.open();
        await until(() => turnAnswers.length === 0);
        await new Promise((r) => setTimeout(r, 20));
        localStorage.setItem("fazer-ai-agent:app_teste#session", SESSION);
        (root.querySelector(".mic") as HTMLButtonElement).click();
        await until(
          () =>
            (root.querySelector(".rec") as HTMLElement).dataset.state ===
            "recording",
        );
        setSystemTime(new Date(Date.now() + 2_000));
        turnAnswers = [
          () =>
            new Promise<Response>((r) => {
              answerSession = r;
            }) as unknown as Response,
        ];
        (root.querySelector(".rec-send") as HTMLButtonElement).click();
        await until(() => turnAnswers.length === 0);
        (root.querySelector(".rec-cancel") as HTMLButtonElement).click();
        turnAnswers = [
          () =>
            new BunResponse(
              JSON.stringify({ session: SESSION, token: anonToken() }),
            ),
          () => sse(["done", { threadId: "t", status: "done", reply: "olá" }]),
        ];
        await ask(el, "oi");
        answerSession(
          new BunResponse(JSON.stringify({ error: "x", field: "turnstile" }), {
            status: 403,
          }),
        );
        await until(() => logText(el).includes("olá"));
        expect({
          rendered: rendered.length,
          signInFailed: logText(el).includes("Não foi possível entrar"),
          lastSession: sent.filter((x) => x.url.endsWith("/session")).at(-1)
            ?.body,
        }).toEqual({
          rendered: 1,
          signInFailed: false,
          lastSession: { turnstile: "tok-4" },
        });
      } finally {
        setSystemTime();
        if (realDevices)
          Object.defineProperty(navigator, "mediaDevices", realDevices);
        else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
        g.MediaRecorder = realRecorder;
      }
    });

    test("a voice message sent during the panel's quiet renewal and cancelled shows no challenge when the renewal falls through", async () => {
      outcomes = ["tok-5"];
      localStorage.setItem("fazer-ai-agent:app_teste#session", SESSION);
      const g = globalThis as { MediaRecorder?: unknown };
      const realRecorder = g.MediaRecorder;
      const realDevices = Object.getOwnPropertyDescriptor(
        navigator,
        "mediaDevices",
      );
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => ({ getTracks: () => [new FakeTrack()] }),
        },
      });
      g.MediaRecorder = FakeRecorder;
      let answerRenewal: (r: Response) => void = () => {};
      try {
        const el = mountChallenged();
        const root = el.shadowRoot as ShadowRoot;
        turnAnswers = [
          () =>
            new Promise<Response>((r) => {
              answerRenewal = r;
            }) as unknown as Response,
          // What a loud ask after the renewal would get: a challenge for a new session.
          () =>
            new BunResponse(
              JSON.stringify({ error: "x", field: "turnstile" }),
              { status: 403 },
            ),
        ];
        el.open();
        (root.querySelector(".mic") as HTMLButtonElement).click();
        await until(
          () =>
            (root.querySelector(".rec") as HTMLElement).dataset.state ===
            "recording",
        );
        setSystemTime(new Date(Date.now() + 2_000));
        (root.querySelector(".rec-send") as HTMLButtonElement).click();
        await until(
          () =>
            (root.querySelector(".rec") as HTMLElement).dataset.state ===
            "transcribing",
        );
        el.close();
        answerRenewal(
          new BunResponse(JSON.stringify({ error: "x" }), { status: 404 }),
        );
        await new Promise((r) => setTimeout(r, 20));
        expect({
          rendered: rendered.length,
          left: challengeLeft(el),
          sessions: sent.filter((x) => x.url.endsWith("/session")).length,
          transcriptions: sent.filter((x) => x.url.endsWith("/transcribe"))
            .length,
        }).toEqual({ rendered: 0, left: 0, sessions: 1, transcriptions: 0 });
      } finally {
        setSystemTime();
        if (realDevices)
          Object.defineProperty(navigator, "mediaDevices", realDevices);
        else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
        g.MediaRecorder = realRecorder;
      }
    });

    test("a challenge that fails asks the instance nothing and says the sign-in failed", async () => {
      outcomes = ["error"];
      const el = mountChallenged();
      await ask(el, "oi");
      await until(() => logText(el).includes("Não foi possível entrar"));
      expect({
        sent: sent.length,
        removed,
        left: challengeLeft(el),
      }).toEqual({ sent: 0, removed: 1, left: 0 });
    });
  });
});

// The browser's microphone, replaced: `getUserMedia` answers what the test says, and the recorder
// hands back one chunk when stopped. The tracks it gave out say whether they were stopped.
class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class FakeRecorder extends EventTarget {
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
  static last: FakeRecorder | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  bytes = 4096;
  constructor(_stream: unknown, opts: { mimeType?: string } = {}) {
    super();
    this.mimeType = opts.mimeType ?? "";
    FakeRecorder.last = this;
  }
  static failStart = false;
  start() {
    if (FakeRecorder.failStart) {
      const e = new Error("cannot record this stream");
      e.name = "NotSupportedError";
      throw e;
    }
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const chunk = new Event("dataavailable") as Event & { data: Blob };
    Object.defineProperty(chunk, "data", {
      value: new Blob([new Uint8Array(this.bytes)], { type: "audio/webm" }),
    });
    this.dispatchEvent(chunk);
    this.dispatchEvent(new Event("stop"));
  }
}

describe("the voice message", () => {
  let tracks: FakeTrack[] = [];
  // How the browser answers the next ask for the microphone; held, so a test can answer late.
  let micAnswer: () => Promise<unknown> = async () => stream();
  const realDevices = Object.getOwnPropertyDescriptor(
    navigator,
    "mediaDevices",
  );
  const g = globalThis as { MediaRecorder?: unknown };
  const realRecorder = g.MediaRecorder;

  function stream() {
    const track = new FakeTrack();
    tracks.push(track);
    return { getTracks: () => [track] };
  }

  function installMic() {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => micAnswer() },
    });
    g.MediaRecorder = FakeRecorder;
  }

  function removeMic() {
    if (realDevices)
      Object.defineProperty(navigator, "mediaDevices", realDevices);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    g.MediaRecorder = realRecorder;
  }

  beforeEach(() => {
    tracks = [];
    micAnswer = async () => stream();
    FakeRecorder.last = null;
    FakeRecorder.failStart = false;
    installMic();
  });
  afterEach(() => {
    setSystemTime();
    removeMic();
  });

  const q = <T extends Element>(el: FazerAiAgent, s: string) =>
    (el.shadowRoot as ShadowRoot).querySelector(s) as T;
  const json =
    (body: unknown, status = 200) =>
    () =>
      new BunResponse(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
  const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));
  const transcriptions = () =>
    sent.filter((x) => x.url.endsWith("/transcribe"));

  function voice(el: FazerAiAgent) {
    const rec = q<HTMLElement>(el, ".rec");
    return {
      state: rec.hidden ? "idle" : rec.dataset.state,
      label: q<HTMLElement>(el, ".rec .label").textContent,
      live: q<HTMLElement>(el, ".voice-status").textContent,
      time: q<HTMLElement>(el, ".rec .time").hidden
        ? null
        : q<HTMLElement>(el, ".rec .time").textContent,
      textarea: !q<HTMLElement>(el, "textarea").hidden,
    };
  }

  async function record(el: FazerAiAgent) {
    el.open();
    q<HTMLButtonElement>(el, ".mic").click();
    await until(() => voice(el).state === "recording");
  }

  test("the button shows only where the browser can record", () => {
    const el = mount();
    const shown = !q<HTMLElement>(el, ".mic").hidden;
    removeMic();
    el.texts = {};
    const withoutApi = !q<HTMLElement>(el, ".mic").hidden;
    expect({
      shown,
      withoutApi,
      label: q<HTMLElement>(el, ".mic").getAttribute("aria-label"),
    }).toEqual({
      shown: true,
      withoutApi: false,
      label: "Gravar mensagem de voz",
    });
  });

  test("recorded, transcribed and sent: the transcription is the person's bubble, with a voice mark, and the turn's message", async () => {
    const token = jwt({ sub: "42", exp: now() + 600 });
    tokens = [token];
    const el = mount();
    let answerMic: (s: unknown) => void = () => {};
    micAnswer = () => new Promise((r) => (answerMic = r));
    el.open();
    q<HTMLButtonElement>(el, ".mic").click();
    await until(() => voice(el).state === "asking");
    const asking = voice(el);
    answerMic(stream());
    await until(() => voice(el).state === "recording");
    const recording = voice(el);
    later(3_400);
    await until(() => voice(el).time === "00:03");
    turnAnswers = [
      json({ text: "  quero ver minhas notas " }),
      () =>
        sse(["done", { threadId: "t", status: "done", reply: "Aqui estão." }]),
    ];
    q<HTMLButtonElement>(el, ".rec-send").click();
    const transcribing = voice(el);
    await until(() => logText(el).includes("Aqui estão."));
    const form = transcriptions()[0]?.form;
    const tokenSent = `Bearer ${token}`;
    const audio = form?.get("audio") as File | null;
    const bubble = q<HTMLElement>(el, ".msg.user");
    const turn = sent.find((x) => x.url.endsWith("/turn"));
    expect({
      asking,
      recording,
      transcribing,
      after: voice(el),
      request: {
        url: transcriptions()[0]?.url,
        auth: transcriptions()[0]?.auth,
        name: audio?.name,
        size: audio?.size,
      },
      bubble: {
        text: bubble.textContent,
        mark: bubble.querySelector(".voice-mark")?.getAttribute("aria-label"),
      },
      message: turn?.body?.message,
      tracksStopped: tracks.map((t) => t.stopped),
    }).toEqual({
      asking: {
        state: "asking",
        label: "Aguardando o microfone…",
        live: "Aguardando o microfone…",
        time: null,
        textarea: false,
      },
      recording: {
        state: "recording",
        label: "Gravando",
        live: "Gravando",
        time: "00:00",
        textarea: false,
      },
      transcribing: {
        state: "transcribing",
        label: "Transcrevendo…",
        live: "Transcrevendo…",
        time: null,
        textarea: false,
      },
      after: { state: "idle", label: "", live: "", time: null, textarea: true },
      request: {
        url: `${INSTANCE}/api/v1/sdk/app_teste/transcribe`,
        auth: tokenSent,
        name: "voice.webm",
        size: 4096,
      },
      bubble: { text: "quero ver minhas notas", mark: "Mensagem de voz" },
      message: "quero ver minhas notas",
      tracksStopped: [true],
    });
  });

  test("cancelled by its button or by Esc, nothing is sent and the microphone is released", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    await record(el);
    q<HTMLButtonElement>(el, ".rec-cancel").click();
    const byButton = voice(el).state;
    await record(el);
    q<HTMLElement>(el, ".rec-send").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    // A recording cancelled sends nothing later either, when the recorder's `stop` arrives.
    await new Promise((r) => setTimeout(r, 20));
    expect({
      byButton,
      byEsc: voice(el).state,
      tracksStopped: tracks.map((t) => t.stopped),
      requests: transcriptions().length,
      log: logText(el),
    }).toEqual({
      byButton: "idle",
      byEsc: "idle",
      tracksStopped: [true, true],
      requests: 0,
      log: EMPTY,
    });
  });

  test("a microphone the browser opens after the cancel is closed at once", async () => {
    const el = mount();
    let answerMic: (s: unknown) => void = () => {};
    micAnswer = () => new Promise((r) => (answerMic = r));
    el.open();
    q<HTMLButtonElement>(el, ".mic").click();
    await until(() => voice(el).state === "asking");
    q<HTMLButtonElement>(el, ".rec-cancel").click();
    answerMic(stream());
    await until(() => tracks[0]?.stopped === true);
    expect({ state: voice(el).state, recorder: FakeRecorder.last }).toEqual({
      state: "idle",
      recorder: null,
    });
  });

  test("closing the panel or changing the identity ends the recording and releases the microphone", async () => {
    const el = mount();
    await record(el);
    el.close();
    const closed = voice(el).state;
    await record(el);
    el.identityChanged();
    expect({
      closed,
      changed: voice(el).state,
      tracksStopped: tracks.map((t) => t.stopped),
    }).toEqual({
      closed: "idle",
      changed: "idle",
      tracksStopped: [true, true],
    });
  });

  test("a panel hidden by leaving inline mode ends the recording, and nothing is sent at two minutes", async () => {
    const el = mount();
    el.setAttribute("mode", "inline");
    await record(el);
    el.removeAttribute("mode");
    // The ceiling's send runs from the recording's timer, which goes with the recording: a stopped
    // recorder and no recording left are what no send at two minutes rests on.
    later(121_000);
    await new Promise((r) => setTimeout(r, 20));
    expect({
      state: voice(el).state,
      tracksStopped: tracks.map((t) => t.stopped),
      recorder: FakeRecorder.last?.state,
      requests: transcriptions().length,
    }).toEqual({
      state: "idle",
      tracksStopped: [true],
      recorder: "inactive",
      requests: 0,
    });
  });

  test("a recorder that stops by itself (the microphone went away) sends what it recorded", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    await record(el);
    later(5_000);
    turnAnswers = [
      json({ text: "o que deu para gravar" }),
      () => sse(["done", { threadId: "t", status: "done", reply: "Entendi." }]),
    ];
    FakeRecorder.last?.stop();
    await until(() => logText(el).includes("Entendi."));
    expect({
      state: voice(el).state,
      message: sent.find((x) => x.url.endsWith("/turn"))?.body?.message,
      tracksStopped: tracks.map((t) => t.stopped),
    }).toEqual({
      state: "idle",
      message: "o que deu para gravar",
      tracksStopped: [true],
    });
  });

  test("a recorder that cannot start leaves no microphone open and says so", async () => {
    FakeRecorder.failStart = true;
    const el = mount();
    el.open();
    q<HTMLButtonElement>(el, ".mic").click();
    await until(() => tracks.length === 1 && voice(el).state === "idle");
    expect({
      error: q<HTMLElement>(el, ".msg.error")?.textContent,
      tracksStopped: tracks.map((t) => t.stopped),
      textarea: voice(el).textarea,
    }).toEqual({
      error: "Não foi possível transcrever a mensagem de voz.",
      tracksStopped: [true],
      textarea: true,
    });
  });

  test("a recorder that fails ends the recording with a line and releases the microphone", async () => {
    const el = mount();
    await record(el);
    FakeRecorder.last?.dispatchEvent(new Event("error"));
    await until(() => voice(el).state === "idle");
    expect({
      error: q<HTMLElement>(el, ".msg.error")?.textContent,
      tracksStopped: tracks.map((t) => t.stopped),
      requests: transcriptions().length,
    }).toEqual({
      error: "Não foi possível transcrever a mensagem de voz.",
      tracksStopped: [true],
      requests: 0,
    });
  });

  test("near two minutes it warns, and at two minutes it stops and sends by itself", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    await record(el);
    later(111_000);
    await until(() => voice(el).label === "Envia sozinha em 2:00");
    const warned = {
      ...voice(el),
      ending: q<HTMLElement>(el, ".rec .time").classList.contains("ending"),
    };
    turnAnswers = [
      json({ text: "uma mensagem longa" }),
      () => sse(["done", { threadId: "t", status: "done", reply: "ok" }]),
    ];
    later(10_000);
    await until(() => transcriptions().length === 1);
    await until(() => logText(el).includes("ok"));
    expect({ warned, tracksStopped: tracks.map((t) => t.stopped) }).toEqual({
      warned: {
        state: "recording",
        label: "Envia sozinha em 2:00",
        live: "Envia sozinha em 2:00",
        time: "01:51",
        textarea: false,
        ending: true,
      },
      tracksStopped: [true],
    });
  });

  test("a transcription that heard nothing sends nothing and says so", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    await record(el);
    later(2_000);
    turnAnswers = [json({ text: "   " })];
    q<HTMLButtonElement>(el, ".rec-send").click();
    await until(() => logText(el).includes("Não deu para ouvir nada"));
    expect({
      turns: sent.filter((x) => x.url.endsWith("/turn")).length,
      bubbles: (el.shadowRoot as ShadowRoot).querySelectorAll(".msg.user")
        .length,
      state: voice(el).state,
    }).toEqual({ turns: 0, bubbles: 0, state: "idle" });
  });

  test("each way a voice message fails has its own text, and none leaves the form behind", async () => {
    const outcomes: Record<string, string> = {};
    const run = async (
      name: string,
      setup: (el: FazerAiAgent) => Promise<void>,
    ) => {
      document.body.replaceChildren();
      sent = [];
      tokens = [jwt({ sub: "42", exp: now() + 600 })];
      const el = mount();
      await setup(el);
      await until(
        () =>
          voice(el).state === "idle" &&
          /\S/.test(q<HTMLElement>(el, ".msg.error")?.textContent ?? ""),
      );
      outcomes[name] = q<HTMLElement>(el, ".msg.error").textContent ?? "";
    };
    const denied = (name: string) => async () => {
      const e = new Error("no");
      e.name = name;
      throw e;
    };
    const refused =
      (status: number, body: unknown) => async (el: FazerAiAgent) => {
        await record(el);
        later(2_000);
        turnAnswers = [json(body, status)];
        q<HTMLButtonElement>(el, ".rec-send").click();
      };
    micAnswer = denied("NotAllowedError");
    await run("denied", async (el) => {
      el.open();
      q<HTMLButtonElement>(el, ".mic").click();
    });
    micAnswer = denied("NotFoundError");
    await run("missing", async (el) => {
      el.open();
      q<HTMLButtonElement>(el, ".mic").click();
    });
    micAnswer = async () => stream();
    await run("short", async (el) => {
      await record(el);
      q<HTMLButtonElement>(el, ".rec-send").click();
    });
    const shortRequests = transcriptions().length;
    await run(
      "sttOff",
      refused(400, { error: "Speech-to-text is not configured" }),
    );
    await run("tooLong", refused(413, { error: "Audio file is too large" }));
    await run(
      "limited",
      refused(429, { error: "Limite de requisições atingido." }),
    );
    await run("broken", refused(502, { error: "transcription failed" }));
    expect({ outcomes, shortRequests }).toEqual({
      outcomes: {
        denied: "O navegador não liberou o microfone.",
        missing: "Nenhum microfone pôde ser usado.",
        short: "A gravação ficou curta demais.",
        sttOff: "Este assistente não recebe mensagens de voz.",
        tooLong: "A gravação ficou longa demais para enviar.",
        limited: "Limite de requisições atingido.",
        broken: "Não foi possível transcrever a mensagem de voz.",
      },
      shortRequests: 0,
    });
  });

  test("the voice texts follow the page's overrides", async () => {
    const el = mount();
    el.texts = { record: "Falar", requestingMic: "Liberando…" };
    let answerMic: (s: unknown) => void = () => {};
    micAnswer = () => new Promise((r) => (answerMic = r));
    el.open();
    q<HTMLButtonElement>(el, ".mic").click();
    await until(() => voice(el).state === "asking");
    const shown = {
      mic: q<HTMLElement>(el, ".mic").getAttribute("aria-label"),
      label: voice(el).label,
    };
    answerMic(stream());
    await until(() => voice(el).state === "recording");
    el.close();
    expect(shown).toEqual({ mic: "Falar", label: "Liberando…" });
  });

  test("a spoken message keeps its mark after a reload", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const el = mount();
    await record(el);
    later(2_000);
    turnAnswers = [
      json({ text: "minhas notas" }),
      () =>
        sse(["done", { threadId: "t-voz", status: "done", reply: "Pronto." }]),
    ];
    q<HTMLButtonElement>(el, ".rec-send").click();
    await until(() => logText(el).includes("Pronto."));
    document.body.replaceChildren();
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    const again = mount();
    again.open();
    await until(() => logText(again).includes("Pronto."));
    expect(
      q<HTMLElement>(again, ".msg.user .voice-mark")?.getAttribute(
        "aria-label",
      ),
    ).toBe("Mensagem de voz");
  });
});

describe("the floating button and the textarea", () => {
  test("the button stays while the panel is open and becomes its close toggle", () => {
    const el = mount();
    const fab = (el.shadowRoot as ShadowRoot).querySelector(
      ".fab",
    ) as HTMLButtonElement;
    const panel = (el.shadowRoot as ShadowRoot).querySelector(
      ".panel",
    ) as HTMLElement;
    const state = () => ({
      fabHidden: fab.hidden,
      label: fab.getAttribute("aria-label"),
      expanded: fab.getAttribute("aria-expanded"),
      panelHidden: panel.hidden,
    });
    const closed = state();
    fab.click();
    const opened = state();
    fab.click();
    expect({ closed, opened, reclosed: state() }).toEqual({
      closed: {
        fabHidden: false,
        label: "Abrir o assistente",
        expanded: "false",
        panelHidden: true,
      },
      opened: {
        fabHidden: false,
        label: "Fechar o assistente",
        expanded: "true",
        panelHidden: false,
      },
      reclosed: {
        fabHidden: false,
        label: "Abrir o assistente",
        expanded: "false",
        panelHidden: true,
      },
    });
  });

  // happy-dom lays nothing out, so `scrollHeight` is set by hand: what is measured here is the
  // sizing rule (grow to the content, cap, scroll only past the cap, shrink back once sent), not the
  // browser's line metrics.
  test("the textarea grows with what is typed, scrolls only past its cap, and shrinks back once sent", async () => {
    tokens = [jwt({ sub: "42", exp: now() + 600 })];
    turnAnswers = [
      () => sse(["done", { threadId: "t", status: "done", reply: "ok" }]),
    ];
    const el = mount();
    el.open();
    const input = (el.shadowRoot as ShadowRoot).querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    let content = 0;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => content,
    });
    const type = (text: string, height: number) => {
      content = height;
      input.value = text;
      input.dispatchEvent(new Event("input"));
      return {
        height: input.style.height,
        scrolls: input.classList.contains("scroll"),
      };
    };
    const one = type("oi", 40);
    const three = type("uma\nduas\ntrês", 84);
    const many = type("1\n2\n3\n4\n5\n6\n7", 200);
    content = 40;
    (el.shadowRoot as ShadowRoot)
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    const sentBack = {
      height: input.style.height,
      scrolls: input.classList.contains("scroll"),
    };
    await until(() => logText(el).includes("ok"));
    const css = [...(el.shadowRoot as ShadowRoot).querySelectorAll("style")]
      .map((s) => s.textContent ?? "")
      .join("\n");
    expect({
      one,
      three,
      many,
      sentBack,
      hiddenByDefault: /textarea \{[^}]*overflow-y: hidden/.test(css),
      placeholderOneLine:
        /textarea::placeholder \{[^}]*white-space: nowrap/.test(css),
    }).toEqual({
      one: { height: "40px", scrolls: false },
      three: { height: "84px", scrolls: false },
      many: { height: "120px", scrolls: true },
      sentBack: { height: "40px", scrolls: false },
      hiddenByDefault: true,
      placeholderOneLine: true,
    });
  });
});
