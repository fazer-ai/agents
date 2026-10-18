/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";

// A voice agent's editor: its own tabs, and the Voice card on General, whose edits the bar's Discard
// takes back like any other field.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

async function open(tab = "general", kind: "voice" | "text" = "voice") {
  const stub = stubEditorApi(
    {
      kind,
      settings: { calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini" } },
    },
    {
      catalog: {
        rag: [{ name: "search_knowledge" }, { name: "suggest_kb_entry" }],
      },
    },
  );
  stub.override = (method, path) =>
    method === "POST" && path.endsWith("/calls/check")
      ? new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        })
      : undefined;
  await renderEditor(stub, tab);
  await act(async () => {});
  return stub;
}

const tabNames = () =>
  screen.getAllByRole("tab").map((t) => t.textContent ?? "");
const modelSelect = () =>
  screen
    .getAllByRole("combobox")
    .find((el) =>
      [...(el as HTMLSelectElement).options].some(
        (o) => o.value === "qwen36-35b-a3b",
      ),
    ) as HTMLSelectElement;

describe("the editor of a voice agent", () => {
  test("draws the tabs of an agent that takes calls", async () => {
    await open();
    expect(tabNames()).toEqual([
      "General",
      "Channels",
      "Call settings",
      "Tools",
      "Knowledge",
      "Playground",
    ]);
  });

  test("the provider, the key, the voice and the models are on General only, the line on Call settings", async () => {
    await open();
    expect(screen.getByRole("combobox", { name: "Provider" })).not.toBeNull();
    // The models are folded, with what is chosen readable without opening them.
    expect(
      screen.getByText("GPT-4.1 mini · Flash v2.5 · Scribe Realtime"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Call settings" }));
    await act(async () => {});
    for (const label of [
      "Provider",
      "Voice",
      "Conversation model",
      "Voice model",
      "Transcription",
    ])
      expect([label, screen.queryByText(label)]).toEqual([label, null]);
    expect(screen.queryByRole("slider", { name: /^Speech speed/ })).toBeNull();
    expect(
      screen.getByRole("combobox", { name: /^Wait after the person pauses/ }),
    ).not.toBeNull();
  });

  test("without a key, General shows where to get one and no error", async () => {
    const stub = stubEditorApi({ kind: "voice", settings: {} });
    stub.override = (method, path) =>
      method === "POST" && path.endsWith("/calls/check")
        ? new Response(
            JSON.stringify({ ok: false, problem: "no_credential" }),
            { headers: { "content-type": "application/json" } },
          )
        : undefined;
    await renderEditor(stub, "general");
    await act(async () => {});
    expect(
      screen
        .getByRole("link", { name: /Create a key on ElevenLabs/ })
        .getAttribute("href"),
    ).toBe("https://elevenlabs.io/app/settings/api-keys");
    expect(
      screen.queryByText("Choose the ElevenLabs key on General and save."),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Add key" })).not.toBeNull();
    // Before a key the voice is named, not shown as an id.
    expect(
      (screen.getByRole("textbox", { name: "Voice" }) as HTMLInputElement)
        .value,
    ).toBe("Default voice");
  });

  test("the Playground saves a pending change to General before calling", async () => {
    const stub = await open();
    fireEvent.change(screen.getByRole("slider", { name: /^Speech speed/ }), {
      target: { value: "1.1" },
    });
    await act(async () => {});
    // The speed is on General, so General's tab is the one marked unsaved.
    const marked = (tab: string) =>
      screen.getByRole("tab", { name: tab }).querySelector(".bg-warning") !==
      null;
    expect([marked("General"), marked("Call settings")]).toEqual([true, false]);
    fireEvent.click(screen.getByRole("tab", { name: "Playground" }));
    await act(async () => {});
    // This agent answers customers: saving to try a change also puts it on their calls.
    expect(
      screen.getByText(
        "There are unsaved changes. This agent answers customers: saving puts them on its calls too.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Call the saved version" }),
    ).not.toBeNull();
    // An audio context that resumes, and a microphone the browser refuses: the call starts and stops
    // at the prompt. Both are this test's own, whatever another file left on the globals.
    const g = globalThis as { AudioContext?: unknown };
    const realAudio = g.AudioContext;
    g.AudioContext = class {
      state = "running";
      resume = async () => {};
      close = async () => {};
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new Error("Permission denied");
        },
      },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save and call" }));
      // The save runs inside the call's attempt, then the microphone is asked for.
      expect(
        await screen.findByText("The browser did not allow the microphone."),
      ).not.toBeNull();
      expect(stub.writes.filter((w) => w.method === "PATCH")).toHaveLength(1);
    } finally {
      g.AudioContext = realAudio;
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  });

  test("a save from Call settings shows what was stored, and leaves both tabs clean", async () => {
    const stub = await open("call");
    // The server keeps a different value than the one sent: the form takes the answer's.
    stub.override = (method, path, body) => {
      if (method !== "PATCH" || !path.endsWith("/agents/41")) return undefined;
      const { expectedUpdatedAt: _, ...patch } = body;
      const settings = patch.settings as { calls: Record<string, unknown> };
      settings.calls.maxDurationSecs = 360;
      stub.agent = {
        ...stub.agent,
        ...patch,
        updatedAt: "2026-01-01T00:05:00.000Z",
      };
      return new Response(JSON.stringify({ agent: stub.agent }), {
        headers: { "content-type": "application/json" },
      });
    };
    fireEvent.change(screen.getByRole("textbox", { name: /^Longest call/ }), {
      target: { value: "7" },
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    const marked = (tab: string) =>
      screen.getByRole("tab", { name: tab }).querySelector(".bg-warning") !==
      null;
    expect(
      (
        screen.getByRole("textbox", {
          name: /^Longest call/,
        }) as HTMLInputElement
      ).value,
    ).toBe("6");
    expect([marked("General"), marked("Call settings")]).toEqual([
      false,
      false,
    ]);
  });

  test("a save from Call settings keeps a speed changed on General while it runs", async () => {
    const stub = await open();
    let answer: (() => void) | null = null;
    stub.override = (method, path, body) => {
      if (method !== "PATCH" || !path.endsWith("/agents/41")) return undefined;
      return new Promise<Response>((resolve) => {
        answer = () => {
          const { expectedUpdatedAt: _, ...patch } = body;
          stub.agent = {
            ...stub.agent,
            ...patch,
            updatedAt: "2026-01-01T00:05:00.000Z",
          };
          resolve(
            new Response(JSON.stringify({ agent: stub.agent }), {
              headers: { "content-type": "application/json" },
            }),
          );
        };
      });
    };
    fireEvent.click(screen.getByRole("tab", { name: "Call settings" }));
    await act(async () => {});
    fireEvent.change(screen.getByRole("textbox", { name: /^Longest call/ }), {
      target: { value: "7" },
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(answer).not.toBeNull();
    // While the save is in flight, General's speed changes; the answer carries the old one.
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    await act(async () => {});
    fireEvent.change(screen.getByRole("slider", { name: /^Speech speed/ }), {
      target: { value: "1.1" },
    });
    await act(async () => {});
    await act(async () => (answer as (() => void) | null)?.());
    await act(async () => {});
    expect(
      (
        screen.getByRole("slider", {
          name: /^Speech speed/,
        }) as HTMLInputElement
      ).value,
    ).toBe("1.1");
    // The answer re-synced the Call tab, whose save it was; General keeps its pending speed.
    const marked = (tab: string) =>
      screen.getByRole("tab", { name: tab }).querySelector(".bg-warning") !==
      null;
    expect([marked("General"), marked("Call settings")]).toEqual([true, false]);
  });

  test("Knowledge offers search, and no suggestions or their reviewer, which a call never runs", async () => {
    await open("knowledge");
    expect(screen.queryByText("Suggestion reviewer")).toBeNull();
    cleanup();
    // A text agent's tab, with the same catalog, still has them.
    await open("knowledge", "text");
    expect(screen.queryByText("Suggestion reviewer")).not.toBeNull();
  });

  // The bar saves the agent from any tab (agents#1520); a voice agent's General and call settings go
  // out in its one write, so a call setting is neither written apart nor reported as left unsaved.
  test("Save pressed on Tools writes a pending call setting in the one voice save", async () => {
    const stub = await open("call");
    fireEvent.change(screen.getByRole("textbox", { name: /^Longest call/ }), {
      target: { value: "7" },
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const anyMarked = () =>
      screen
        .getAllByRole("tab")
        .some((tab) => tab.querySelector(".bg-warning") !== null);
    await waitFor(() =>
      expect(stub.writes.filter((w) => w.method === "PATCH")).toHaveLength(1),
    );
    await waitFor(() => expect(anyMarked()).toBe(false));
    const patches = stub.writes.filter((w) => w.method === "PATCH");
    expect(patches).toHaveLength(1);
    const body = patches[0]?.body as {
      name?: string;
      settings: { calls: { maxDurationSecs: number } };
    };
    expect(body.name).toBe("Atendente");
    expect(body.settings.calls.maxDurationSecs).toBe(420);
    expect(screen.queryByText(/were not saved/)).toBeNull();
  });

  test("a call setting edited while the bar's save is out stays pending, on its own tab", async () => {
    const stub = await open("call");
    let answer: (() => void) | null = null;
    stub.override = (method, path, body) => {
      if (method !== "PATCH" || !path.endsWith("/agents/41")) return undefined;
      return new Promise<Response>((resolve) => {
        answer = () => {
          const { expectedUpdatedAt: _, ...patch } = body;
          stub.agent = {
            ...stub.agent,
            ...patch,
            updatedAt: "2026-01-01T00:05:00.000Z",
          };
          resolve(
            new Response(JSON.stringify({ agent: stub.agent }), {
              headers: { "content-type": "application/json" },
            }),
          );
        };
      });
    };
    const longest = () =>
      screen.getByRole("textbox", { name: /^Longest call/ });
    fireEvent.change(longest(), { target: { value: "7" } });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(answer).not.toBeNull();
    fireEvent.change(longest(), { target: { value: "8" } });
    await act(async () => {});
    await act(async () => (answer as (() => void) | null)?.());
    for (let i = 0; i < 5; i++) await act(async () => {});
    // The edit made meanwhile was not in the save: no second write, no word of tabs this agent does
    // not use, and the Call tab still owes it.
    expect(stub.writes.filter((w) => w.method === "PATCH")).toHaveLength(1);
    expect(screen.queryByText(/were not saved/)).toBeNull();
    expect((longest() as HTMLInputElement).value).toBe("8");
    expect(
      screen
        .getByRole("tab", { name: "Call settings" })
        .querySelector(".bg-warning"),
    ).not.toBeNull();
  });

  test("Save and export writes a pending call setting in the voice save", async () => {
    const stub = await open("call");
    fireEvent.change(screen.getByRole("textbox", { name: /^Longest call/ }), {
      target: { value: "7" },
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save and export" }),
    );
    await waitFor(() =>
      expect(stub.writes.filter((w) => w.method === "PATCH")).toHaveLength(1),
    );
    const body = stub.writes.find((w) => w.method === "PATCH")?.body as {
      name?: string;
      settings: { calls: { maxDurationSecs: number } };
    };
    expect(body.name).toBe("Atendente");
    expect(body.settings.calls.maxDurationSecs).toBe(420);
  });

  // A call setting out of range keeps the save back and shows the field: the bar's Save, from that
  // tab or from General, ends on Call settings, never on a tab this agent does not have.
  for (const from of ["Call settings", "General"] as const)
    test(`a longest call out of range, saved from ${from}, ends on Call settings with the field marked`, async () => {
      const stub = await open("call");
      fireEvent.change(screen.getByRole("textbox", { name: /^Longest call/ }), {
        target: { value: "-5" },
      });
      await act(async () => {});
      if (from === "General") {
        fireEvent.click(screen.getByRole("tab", { name: "General" }));
        await act(async () => {});
      }
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      for (let i = 0; i < 5; i++) await act(async () => {});
      expect(stub.writes.filter((w) => w.method === "PATCH")).toHaveLength(0);
      expect(
        screen
          .getByRole("tab", { name: "Call settings" })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(screen.getByText("Use a number from 1 to 60.")).not.toBeNull();
    });

  test("a longest call out of range keeps Save and export back, on Call settings", async () => {
    const stub = await open("call");
    fireEvent.change(screen.getByRole("textbox", { name: /^Longest call/ }), {
      target: { value: "-5" },
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save and export" }),
    );
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(stub.writes.filter((w) => w.method === "PATCH")).toHaveLength(0);
    expect(
      screen
        .getByRole("tab", { name: "Call settings" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("Discard takes back a change to the Voice card, after asking", async () => {
    await open();
    expect(modelSelect().value).toBe("gpt-4.1-mini");
    fireEvent.change(modelSelect(), { target: { value: "qwen36-35b-a3b" } });
    await act(async () => {});
    expect(modelSelect().value).toBe("qwen36-35b-a3b");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard all" }));
    await act(async () => {});
    expect(modelSelect().value).toBe("gpt-4.1-mini");
  });

  test("one save of the name and a call setting leaves nothing unsaved on either tab", async () => {
    const stub = await open();
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Raquel" },
    });
    fireEvent.change(screen.getByRole("slider", { name: /^Speech speed/ }), {
      target: { value: "1.1" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Call settings" }));
    await act(async () => {});
    fireEvent.change(screen.getByRole("textbox", { name: /^Longest call/ }), {
      target: { value: "7" },
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(stub.writes.filter((w) => w.method === "PATCH")).toHaveLength(1);
    expect(
      (
        screen.getByRole("textbox", {
          name: /^Longest call/,
        }) as HTMLInputElement
      ).value,
    ).toBe("7");
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    await act(async () => {});
    expect(
      (
        screen.getByRole("slider", {
          name: /^Speech speed/,
        }) as HTMLInputElement
      ).value,
    ).toBe("1.1");
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  test("the Playground's call warns of an unsaved change on Tools, which the call does not carry", async () => {
    await open("tools");
    fireEvent.click(screen.getByRole("button", { name: "Add a precondition" }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Save" })).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Call in the playground" }),
    );
    await act(async () => {});
    expect(
      screen.queryByText(
        "There are unsaved changes. Save them to try them, or call the saved version.",
      ),
    ).not.toBeNull();
  });

  test("and of one on Knowledge", async () => {
    const stub = stubEditorApi(
      {
        kind: "voice",
        settings: { calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini" } },
      },
      {
        catalog: {
          rag: [{ name: "search_knowledge" }],
          knowledgeBases: [{ id: "kb1", name: "Perguntas frequentes" }],
        },
        grants: [
          {
            source: "RAG",
            enabledTools: ["search_knowledge"],
            knowledgeBaseIds: [],
          },
        ],
      },
    );
    await renderEditor(stub, "knowledge");
    await act(async () => {});
    fireEvent.click(screen.getByText("Perguntas frequentes"));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Save" })).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Call in the playground" }),
    );
    await act(async () => {});
    expect(
      screen.queryByText(
        "There are unsaved changes. Save them to try them, or call the saved version.",
      ),
    ).not.toBeNull();
  });

  test("Channels says the inboxes could not be read, instead of that there are none", async () => {
    const stub = stubEditorApi({ kind: "voice", settings: {} });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    stub.override = (method, path) => {
      if (method !== "GET") return undefined;
      if (path === "/api/v1/chatwoot/deployment")
        return json({
          deployment: { baseUrl: "https://chat.example.com" },
          accounts: [
            {
              id: "a1",
              accountId: 1,
              accountName: "Conta",
              disconnectedAt: null,
            },
          ],
        });
      if (path === "/api/v1/chatwoot/inboxes")
        return json({ error: "Chatwoot is down" }, 502);
      // Answered, so the inboxes are the only thing that fails.
      if (path === "/api/v1/agents") return json({ agents: [], total: 0 });
      return undefined;
    };
    await renderEditor(stub, "channels");
    await act(async () => {});
    expect(await screen.findByRole("button", { name: "Retry" })).not.toBeNull();
    expect(screen.queryByText("No WhatsApp inbox to take calls")).toBeNull();
  });

  // Chatwoot refuses a voice agent on a WhatsApp inbox the connector does not carry: the tab lists
  // only the inboxes that can take calls.
  test("Channels lists only the WhatsApp inboxes on the connector", async () => {
    const stub = stubEditorApi({ kind: "voice", settings: {} });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    const inbox = (
      id: string,
      name: string,
      provider: string | null,
      voiceAgentId: string | null = null,
    ) => ({
      id,
      name,
      agentId: null,
      observerAgentIds: [],
      voiceAgentId,
      chatwootInstanceId: "a1",
      chatwootInboxId: Number(id),
      channelType: "Channel::Whatsapp",
      provider,
    });
    const unbinds: string[] = [];
    stub.override = (method, path, body) => {
      if (method === "PUT" && path.endsWith("/voice-agent")) {
        unbinds.push(`${path} ${JSON.stringify(body)}`);
        return json({ voiceAgentId: null });
      }
      if (method !== "GET") return undefined;
      if (path === "/api/v1/chatwoot/deployment")
        return json({
          deployment: { baseUrl: "https://chat.example.com" },
          accounts: [
            {
              id: "a1",
              accountId: 1,
              accountName: "Conta",
              disconnectedAt: null,
            },
          ],
        });
      if (path === "/api/v1/chatwoot/inboxes")
        return json({
          inboxes: [
            inbox("1", "Loja conector", "native"),
            inbox("2", "Loja ainda sem sync", null),
            inbox("3", "Loja Cloud", "whatsapp_cloud"),
            // Bound while its provider was unknown: it stays, to be turned off.
            inbox("4", "Loja Cloud com voz", "whatsapp_cloud", "41"),
          ],
        });
      if (path === "/api/v1/agents") return json({ agents: [], total: 0 });
      return undefined;
    };
    await renderEditor(stub, "channels");
    expect(await screen.findByText("Loja conector")).not.toBeNull();
    expect(screen.queryByText("Loja ainda sem sync")).not.toBeNull();
    expect(screen.queryByText("Loja Cloud")).toBeNull();
    expect(screen.queryByText("Loja Cloud com voz")).not.toBeNull();
    expect(
      screen.getAllByText(
        "This inbox does not take calls. Turn it off to release the agent.",
      ),
    ).toHaveLength(1);
    const bound = screen.getByRole("switch", {
      name: "Answer the calls of Loja Cloud com voz with this agent",
    });
    expect(bound.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(bound);
    await waitFor(() =>
      expect(unbinds).toEqual([
        '/api/v1/chatwoot/inboxes/4/voice-agent {"agentId":null}',
      ]),
    );
  });

  // A call routes only to an agent that is switched on and in production (`answers`): the tab says
  // which of the three the SAVED agent is, and so does taking an inbox's calls over from another.
  for (const [label, seed, banner, takeover] of [
    [
      "turned off",
      { enabled: false, mode: "production" },
      "This agent is turned off: in the inboxes marked here, calls ring your team until it is turned on.",
      "Outra voz stops answering the calls of Loja. This agent is turned off, so until it is turned on the inbox's calls ring your team.",
    ],
    [
      "in test mode",
      { enabled: true, mode: "test" },
      "This agent is in test mode: in the inboxes marked here, calls ring your team until it goes to production on General.",
      "Outra voz answers the calls of Loja now and stops. This agent is in test mode, so until it goes to production the inbox's calls ring your team.",
    ],
    [
      "in production",
      { enabled: true, mode: "production" },
      "This agent is in production: it answers the calls to the inboxes marked here.",
      "Outra voz answers the calls of Loja now. Only one agent answers an inbox's calls, so it stops.",
    ],
  ] as const) {
    test(`Channels says the saved agent is ${label}`, async () => {
      const stub = stubEditorApi({ kind: "voice", settings: {}, ...seed });
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      stub.override = (method, path) => {
        if (method !== "GET") return undefined;
        if (path === "/api/v1/chatwoot/deployment")
          return json({
            deployment: { baseUrl: "https://chat.example.com" },
            accounts: [
              {
                id: "a1",
                accountId: 1,
                accountName: "Conta",
                disconnectedAt: null,
              },
            ],
          });
        if (path === "/api/v1/chatwoot/inboxes")
          return json({
            inboxes: [
              {
                id: "1",
                name: "Loja",
                agentId: null,
                observerAgentIds: [],
                voiceAgentId: "77",
                chatwootInstanceId: "a1",
                chatwootInboxId: 1,
                channelType: "Channel::Whatsapp",
                provider: "native",
              },
            ],
          });
        if (path === "/api/v1/agents")
          return json({
            agents: [
              {
                id: "77",
                name: "Outra voz",
                kind: "voice",
                mode: "production",
                enabled: true,
              },
            ],
            total: 1,
          });
        return undefined;
      };
      await renderEditor(stub, "channels");
      // Green only when the calls are answered: off and test both ring the team.
      expect((await screen.findByText(banner)).className).toContain(
        label === "in production" ? "text-success" : "text-warning",
      );
      fireEvent.click(
        await screen.findByRole("switch", {
          name: "Answer the calls of Loja with this agent",
        }),
      );
      expect(await screen.findByText(takeover)).not.toBeNull();
    });
  }

  // A voice agent makes no model call of its own, so the "tokens per call" estimate is neither asked
  // for nor shown; a text agent on the same server gets both, which keeps the absence meaningful.
  for (const kind of ["text", "voice"] as const) {
    test(`a ${kind} agent ${kind === "voice" ? "asks for no" : "shows its"} call-floor estimate`, async () => {
      const stub = stubEditorApi({ kind, settings: {} });
      stub.override = (method, path) =>
        method === "POST" && path === "/api/v1/agents/41/call-floor"
          ? new Response(
              JSON.stringify({
                floor: {
                  engine: "llm",
                  instructions: 120,
                  instructionsAdded: 0,
                  instructionsAddedBy: { grounding: 0, mcp: 0 },
                  tools: [],
                  total: 120,
                },
              }),
              { headers: { "content-type": "application/json" } },
            )
          : undefined;
      await renderEditor(stub, "general");
      await screen.findByDisplayValue("Você atende.");
      if (kind === "text") {
        expect(
          await screen.findByText(
            /These instructions add ~?\d+ tokens to every call/,
          ),
        ).not.toBeNull();
        return;
      }
      await waitFor(() =>
        expect(stub.requests).toContain(
          "GET /api/v1/agents/41/tool-selections",
        ),
      );
      expect(stub.requests.filter((r) => r.endsWith("/call-floor"))).toEqual(
        [],
      );
      expect(screen.queryByText(/tokens to every call/)).toBeNull();
    });
  }

  // The Model card is not drawn for a voice agent, so nothing it would refuse can hold the save: a
  // base URL with no scheme, or no model at all (an imported agent).
  for (const [label, modelConfig] of [
    [
      "a base URL with no scheme",
      { provider: "openai-compatible", model: "m", baseURL: "localhost:8000" },
    ],
    ["no model", { provider: "openai", model: "" }],
  ] as const)
    test(`General saves even when the hidden chat model has ${label}`, async () => {
      const stub = stubEditorApi({
        kind: "voice",
        modelConfig,
        settings: { calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini" } },
      });
      stub.override = (method, path) =>
        method === "POST" && path.endsWith("/calls/check")
          ? new Response(JSON.stringify({ ok: true }), {
              headers: { "content-type": "application/json" },
            })
          : undefined;
      await renderEditor(stub, "general");
      await act(async () => {});
      fireEvent.change(screen.getByLabelText(/^Name/), {
        target: { value: "Raquel" },
      });
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await act(async () => {});
      expect(stub.writes.filter((w) => w.method === "PATCH")).toHaveLength(1);
    });

  test("Knowledge saves a grant even when the hidden reviewer's stored settings are incomplete", async () => {
    const stub = stubEditorApi(
      {
        kind: "voice",
        settings: {
          calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini" },
          knowledge: { suggestionReview: { provider: "openai-compatible" } },
        },
      },
      {
        catalog: {
          rag: [{ name: "search_knowledge" }],
          knowledgeBases: [{ id: "kb1", name: "Perguntas frequentes" }],
        },
        grants: [
          {
            source: "RAG",
            enabledTools: ["search_knowledge"],
            knowledgeBaseIds: [],
          },
        ],
      },
    );
    await renderEditor(stub, "knowledge");
    await act(async () => {});
    fireEvent.click(screen.getByText("Perguntas frequentes"));
    await act(async () => {});
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(false);
  });

  test("an older check answering last does not overwrite the newer one's verdict", async () => {
    const stub = stubEditorApi({
      kind: "voice",
      settings: { calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini" } },
    });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    // The first check (on open) is held; the second (after the save) refuses at once.
    const held: { answer?: () => void } = {};
    let checks = 0;
    stub.override = (method, path) => {
      if (method !== "POST" || !path.endsWith("/calls/check")) return undefined;
      checks++;
      if (checks === 1)
        return new Promise<Response>((go) => {
          held.answer = () => go(json({ ok: true }));
        });
      return json({
        ok: false,
        problem: "sync_failed",
        detail: "voice not found",
      });
    };
    await renderEditor(stub, "general");
    await act(async () => {});
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Raquel" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(await screen.findByText("voice not found")).not.toBeNull();
    await act(async () => held.answer?.());
    expect(screen.queryByText("Ready on ElevenLabs")).toBeNull();
    expect(screen.getByText("voice not found")).not.toBeNull();
  });
});
