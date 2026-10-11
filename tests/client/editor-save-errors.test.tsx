import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { firstRefusalAt, settlesRefusal } from "@/client/lib/fieldRefusal";
import { PROTECTED_LABELS_MAX } from "@/modules/agents/tool-guidance";
import {
  type EditorStub,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The agent editor answers a refused save in two places: a mark on the control the server named, and
// a banner above the tabs that carries every standing refusal until it is answered. Rendered whole
// against a stubbed API, so what is asserted is what the operator reads after each save.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const isAgent = (stub: EditorStub, path: string) =>
  path === `/api/v1/agents/${stub.agent.id}`;
const isGrants = (stub: EditorStub, path: string) =>
  path === `/api/v1/agents/${stub.agent.id}/tool-selections`;

// Answers the next PATCH of the agent with this refusal, once; every later one goes through.
function refuseNextPatch(stub: EditorStub, body: Record<string, unknown>) {
  let pending = true;
  stub.override = (method, path) => {
    if (!pending || method !== "PATCH" || !isAgent(stub, path)) return;
    pending = false;
    return json(body, 400);
  };
}

// The text of every banner row, in the order drawn.
const bannerRows = () =>
  screen.queryAllByRole("alert").map((row) => row.textContent ?? "");

const bannerRow = (text: string) =>
  screen.getAllByRole("alert").find((row) => row.textContent?.includes(text));

// How many times a sentence is on screen: once is the banner, twice is the banner and a mark (or a
// toast beside it).
const onScreen = (text: string) =>
  (document.body.textContent ?? "").split(text).length - 1;

const save = (name = "Save") =>
  fireEvent.click(screen.getByRole("button", { name }));

async function goTo(tab: string) {
  fireEvent.click(screen.getByRole("tab", { name: tab }));
  await screen.findByRole("tab", { name: tab, selected: true });
}

const GUARDRAILS_ON = { guardrails: { enabled: true } };

describe("agent editor save errors", () => {
  test("a refusal is settled by the tab that draws its value, whichever form wrote it", async () => {
    const stub = stubEditorApi({ settings: GUARDRAILS_ON });
    refuseNextPatch(stub, {
      error: "The policy is too long.",
      field: "guardrails.customPolicy",
    });
    await renderEditor(stub, "behavior");
    save();
    await waitFor(() =>
      expect(bannerRows()).toEqual(["The policy is too long.Fix"]),
    );

    // Saving Behavior again does not answer it: the value belongs to Guardrails, and a Behavior save
    // resends what is stored there rather than any edit made on that tab.
    save();
    await screen.findByText("Agent saved.");
    expect(bannerRows()).toEqual(["The policy is too long.Fix"]);

    fireEvent.click(
      within(bannerRow("The policy is too long.") as HTMLElement).getByRole(
        "button",
        { name: "Fix" },
      ),
    );
    await screen.findByRole("textbox", { name: "Custom policy" });
    // On the tab that draws it the row loses its jump and the control carries the mark.
    expect(bannerRows()).toEqual(["The policy is too long."]);
    expect(onScreen("The policy is too long.")).toBe(2);

    const saves = stub.writes.length;
    save();
    await waitFor(() => expect(stub.writes.length).toBe(saves + 1));
    await waitFor(() => expect(bannerRows()).toEqual([]));
    expect(onScreen("The policy is too long.")).toBe(0);
  });

  test("a discard answers the refusal about the values it puts back", async () => {
    const stub = stubEditorApi({
      settings: { guardrails: { enabled: true, customPolicy: "Seja breve." } },
    });
    refuseNextPatch(stub, {
      error: "The policy is too long.",
      field: "guardrails.customPolicy",
    });
    await renderEditor(stub, "behavior");
    save();
    await waitFor(() => expect(bannerRows().length).toBe(1));
    await goTo("Guardrails");

    // An edit takes the mark off, because the box no longer holds what was refused.
    const policy = screen.getByRole("textbox", { name: "Custom policy" });
    fireEvent.change(policy, { target: { value: "Seja breve. Sempre." } });
    await waitFor(() => expect(bannerRows()).toEqual([]));
    // The discard puts the refused value back. Unanswered, the refusal would stand on it again.
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: "Custom policy" }) as HTMLElement)
          .textContent,
      ).toBe("Seja breve."),
    );
    expect(bannerRows()).toEqual([]);
    expect(onScreen("The policy is too long.")).toBe(0);
  });

  test("two forms refused in turn both stay on the banner, in tab order", async () => {
    const stub = stubEditorApi({ settings: GUARDRAILS_ON });
    refuseNextPatch(stub, {
      error: "That name is taken.",
      field: "name",
    });
    await renderEditor(stub, "general");
    save();
    await waitFor(() => expect(bannerRows()).toEqual(["That name is taken."]));

    await goTo("Behavior");
    refuseNextPatch(stub, {
      error: "The policy is too long.",
      field: "guardrails.customPolicy",
    });
    save();
    await waitFor(() =>
      expect(bannerRows()).toEqual([
        "That name is taken.Fix",
        "The policy is too long.Fix",
      ]),
    );

    // The General row still leads to its mark.
    fireEvent.click(
      within(bannerRow("That name is taken.") as HTMLElement).getByRole(
        "button",
        { name: "Fix" },
      ),
    );
    await screen.findByRole("tab", { name: "General", selected: true });
    expect(onScreen("That name is taken.")).toBe(2);
    expect(bannerRows()).toEqual([
      "That name is taken.",
      "The policy is too long.Fix",
    ]);
  });

  test("a refusal no control can carry is kept on the banner, and says so only when it is proved", async () => {
    const stub = stubEditorApi({});
    await renderEditor(stub, "behavior");

    // A native-tool note the console draws no field for.
    refuseNextPatch(stub, {
      error: "The handoff note is too long.",
      field: "toolGuidance.handoff_to_human",
    });
    save();
    await waitFor(() =>
      expect(bannerRows()).toEqual([
        "The handoff note is too long.This value has no field in the console, so it can only be changed through the API.",
      ]),
    );

    // A name this editor does not know, and a refusal about no field at all: kept, with no claim.
    for (const body of [
      { error: "Something unknown is wrong.", field: "somewhere.else" },
      { error: "The server is busy." },
    ]) {
      refuseNextPatch(stub, body);
      save();
      await waitFor(() => expect(bannerRows()).toEqual([body.error]));
    }

    // A request that never answered still says it failed.
    stub.override = (method, path) => {
      if (method === "PATCH" && isAgent(stub, path)) {
        throw new TypeError("Failed to fetch");
      }
    };
    save();
    await waitFor(() =>
      expect(bannerRows()).toEqual(["Could not save the agent."]),
    );
  });

  test("a refusal about a value edited while the save was out goes to the banner, not the box", async () => {
    const stub = stubEditorApi({ name: "Atendente" });
    let answer: (r: Response) => void = () => {};
    stub.override = (method, path) => {
      if (method !== "PATCH" || !isAgent(stub, path)) return;
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    };
    await renderEditor(stub, "general");
    const name = screen.getByRole("textbox", { name: /^Name/ });
    fireEvent.change(name, { target: { value: "Ana" } });
    save();
    await waitFor(() => expect(stub.writes.length).toBe(1));
    fireEvent.change(name, { target: { value: "Ana Lima" } });
    answer(json({ error: "That name is taken.", field: "name" }, 400));

    await waitFor(() => expect(bannerRows()).toEqual(["That name is taken."]));
    // The banner only: under "Ana Lima" the sentence would be about a name the server never saw.
    expect(onScreen("That name is taken.")).toBe(1);
  });

  test("the banner is brought into view once per answered request", async () => {
    const scrolled: Element[] = [];
    const spy = spyOn(
      HTMLElement.prototype,
      "scrollIntoView",
    ).mockImplementation(function (this: Element) {
      if (this.querySelector('[role="alert"]')) scrolled.push(this);
    });
    try {
      const stub = stubEditorApi({ name: "Atendente" });
      refuseNextPatch(stub, { error: "That name is taken.", field: "name" });
      await renderEditor(stub, "general");
      save();
      await waitFor(() => expect(scrolled.length).toBe(1));

      // The row leaves with an edit and comes back with the value: nothing was answered, no scroll.
      const name = screen.getByRole("textbox", { name: /^Name/ });
      fireEvent.change(name, { target: { value: "Atendente 2" } });
      await waitFor(() => expect(bannerRows()).toEqual([]));
      fireEvent.change(name, { target: { value: "Atendente" } });
      await waitFor(() => expect(bannerRows().length).toBe(1));
      expect(scrolled.length).toBe(1);

      // Two failures in a row with the SAME sentence are two answers, each brought into view.
      stub.override = (method, path) => {
        if (method === "PATCH" && isAgent(stub, path)) {
          return json({ error: "Try again later." }, 503);
        }
      };
      save();
      await waitFor(() => expect(scrolled.length).toBe(2));
      save();
      await waitFor(() => expect(scrolled.length).toBe(3));
      expect(bannerRows()).toEqual(["Try again later."]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a mark stays on a value that differs from what was sent only by how it is normalized", async () => {
    const stub = stubEditorApi({
      settings: { availability: { enabled: true, awayMessage: "Volto já" } },
    });
    await renderEditor(stub, "general");
    const name = screen.getByRole("textbox", { name: /^Name/ });
    fireEvent.change(name, { target: { value: "Ana  " } });
    refuseNextPatch(stub, { error: "That name is taken.", field: "name" });
    save();
    await waitFor(() => expect(bannerRows().length).toBe(1));
    // The wire carried "Ana" and the box holds "Ana  ": the same value, so the mark is on the box.
    expect(stub.writes.at(-1)?.body.name).toBe("Ana");
    expect(onScreen("That name is taken.")).toBe(2);
    // An actual edit takes it off.
    fireEvent.change(name, { target: { value: "Ana L" } });
    await waitFor(() => expect(onScreen("That name is taken.")).toBe(0));

    await goTo("Behavior");
    const away = screen.getByRole("textbox", { name: "Out-of-hours message" });
    fireEvent.change(away, { target: { value: "  Volto já  " } });
    refuseNextPatch(stub, {
      error: "The away message is refused.",
      field: "availability.awayMessage",
    });
    save();
    await waitFor(() =>
      expect(bannerRows()).toContain("The away message is refused."),
    );
    expect(onScreen("The away message is refused.")).toBe(2);
  });
});

describe("the Tools save checks before it writes anything", () => {
  const LABELS = { native: [{ name: "set_labels" }] };
  const GRANTED = [
    {
      source: "NATIVE",
      enabledTools: ["set_labels"],
      knowledgeBaseIds: [],
    },
  ];
  const labels = (n: number) =>
    Array.from({ length: n }, (_, i) => `rotulo-${i}`);

  test("a forced save compares the text caps against the agent as it is now", async () => {
    const legacy = "x".repeat(1600);
    const stub = stubEditorApi(
      { settings: { toolGuidance: { handoff_to_human: legacy } } },
      { catalog: LABELS, grants: GRANTED },
    );
    await renderEditor(stub, "tools");
    // Another writer shortened the stored note: the copy this tab holds is now an edit of it.
    let conflict = true;
    stub.override = (method, path) => {
      if (method === "GET" && isAgent(stub, path) && !conflict) {
        return json({
          agent: {
            ...stub.agent,
            settings: { toolGuidance: { handoff_to_human: "curta" } },
          },
        });
      }
      if (method === "PUT" && isGrants(stub, path) && conflict) {
        conflict = false;
        return json({ error: "conflict" }, 409);
      }
    };
    save("Save tools");
    fireEvent.click(
      (
        await screen.findAllByRole("button", { name: "Save anyway" })
      )[0] as HTMLElement,
    );
    await screen.findByText(
      "The text in toolGuidance.handoff_to_human is too long: 1600 characters (limit 1500).",
    );
    // The conflicted PUT is the only write: nothing was persisted on the way to the refusal.
    expect(stub.writes.map((w) => w.method)).toEqual(["PUT"]);
  });

  test("an over-ceiling list of protected labels is refused before the grants PUT, a stored one is not", async () => {
    const stored = labels(PROTECTED_LABELS_MAX + 2);
    const stub = stubEditorApi(
      { settings: { setLabels: { protected: stored } } },
      { catalog: LABELS, grants: GRANTED },
    );
    await renderEditor(stub, "tools");

    // Saved as stored, the legacy list is not this save's to refuse.
    save("Save tools");
    await screen.findByText("Tools updated.");
    expect(stub.writes.map((w) => w.method)).toEqual(["PUT", "PATCH"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Settings", expanded: false }),
    );
    const field = screen.getByRole("textbox", { name: "Labels off limits" });
    fireEvent.change(field, {
      target: { value: [...stored, "mais-um"].join(", ") },
    });
    save("Save tools");
    await screen.findByText(
      `Labels off limits takes at most ${PROTECTED_LABELS_MAX} labels.`,
    );
    expect(stub.writes.map((w) => w.method)).toEqual(["PUT", "PATCH"]);
  });
});

describe("every save that writes the agent shows what the server said", () => {
  for (const [tab, button, path] of [
    ["general", "Save", "agent"],
    ["behavior", "Save", "agent"],
    ["tools", "Save tools", "grants"],
    ["knowledge", "Save knowledge", "grants"],
    ["guardrails", "Save", "agent"],
    ["channelRedirect", "Save", "agent"],
  ] as const) {
    test(`${tab}: the server's sentence, and the fallback when nothing answered`, async () => {
      const stub = stubEditorApi({});
      await renderEditor(stub, tab);
      const writes = (p: string) =>
        path === "agent" ? isAgent(stub, p) : isGrants(stub, p);
      stub.override = (method, p) => {
        if (method !== "GET" && writes(p)) {
          return json({ error: "Refused by the server." }, 422);
        }
      };
      save(button);
      await waitFor(() =>
        expect(bannerRows()).toEqual(["Refused by the server."]),
      );
      // The banner and nothing else: a toast would take the only copy away while it still stands.
      expect(onScreen("Refused by the server.")).toBe(1);

      stub.override = (method, p) => {
        if (method !== "GET" && writes(p)) throw new TypeError("offline");
      };
      save(button);
      await waitFor(() =>
        expect(bannerRows()).toEqual([
          path === "agent"
            ? "Could not save the agent."
            : "Could not update tools.",
        ]),
      );
    });
  }

  // The questions and rules have a Save of their own on their tab (agents#1224), and its refusal reaches
  // the same banner as every other form's.
  test("decisions: the server's sentence, and the fallback when nothing answered", async () => {
    const stub = stubEditorApi({
      mode: "monitoring",
      settings: {
        monitoring: {
          engine: "decisions",
          decisions: {
            provider: "typesafe",
            credentialRef: "vault:12",
            questions: [
              { name: "pede_reembolso", type: "yes_no", instructions: "Pede?" },
            ],
            rules: [],
          },
        },
      },
    });
    await renderEditor(stub, "decisions");
    stub.override = (method, p) => {
      if (method !== "GET" && isAgent(stub, p)) {
        return json({ error: "Refused by the server." }, 422);
      }
    };
    save();
    await waitFor(() =>
      expect(bannerRows()).toEqual(["Refused by the server."]),
    );
    expect(onScreen("Refused by the server.")).toBe(1);

    stub.override = (method, p) => {
      if (method !== "GET" && isAgent(stub, p)) throw new TypeError("offline");
    };
    save();
    await waitFor(() =>
      expect(bannerRows()).toEqual(["Could not save the agent."]),
    );
  });

  test("the Redirect save is settled by its own success", async () => {
    const stub = stubEditorApi({});
    refuseNextPatch(stub, { error: "Refused by the server." });
    await renderEditor(stub, "channelRedirect");
    save();
    await waitFor(() =>
      expect(bannerRows()).toEqual(["Refused by the server."]),
    );
    save();
    await screen.findByText("Agent saved.");
    expect(bannerRows()).toEqual([]);
  });

  test("the clone dialog says why the copy was refused", async () => {
    const stub = stubEditorApi({});
    await renderEditor(stub, "general");
    stub.override = (method, path) => {
      if (method === "POST" && path.endsWith("/clone")) {
        return json(
          {
            error: "The source's handoff note is too long.",
            field: "handoff.instructions",
          },
          400,
        );
      }
    };
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clone" }));
    await screen.findByText("The source's handoff note is too long.");
  });
});

describe("one refusal per form that writes", () => {
  test("every holder is asked before a control is left unmarked", () => {
    // Behaviour, not shape: a source check on the loop's text survives narrowing the loop to
    // its first entry. The rule lives in `firstRefusalAt` and is asked to answer.
    const silent = () => null;
    const says = (what: string) => () => what;
    expect(
      firstRefusalAt([silent, silent, says("from the sixth")], "f", 1),
    ).toBe("from the sixth");
    // First match wins: one control draws one value, so the older sentence is the one already shown.
    expect(firstRefusalAt([says("first"), says("second")], "f", 1)).toBe(
      "first",
    );
    expect(firstRefusalAt([silent, silent], "f", 1)).toBeNull();
    expect(firstRefusalAt([], "f", 1)).toBeNull();
  });

  test("a refusal is settled by the tab that draws it, whichever form wrote it", () => {
    // NOTE: the half the per-form split does not get for free: `clearRefusalFor` keeps its section
    // argument, because the holder is not the section. A Behavior save refused about a Guardrails
    // path is fixed on Guardrails and saved THERE, while the mark sits in the Behavior holder.
    expect(
      settlesRefusal({
        drawnBy: "guardrails",
        owner: "behavior",
        settled: "guardrails",
      }),
    ).toBe(true);
    // Saving Behavior again does NOT settle it: the value belongs to the Guardrails tab, and a
    // Behavior save spreads the last-synced settings rather than the edit still unsaved there.
    expect(
      settlesRefusal({
        drawnBy: "guardrails",
        owner: "behavior",
        settled: "behavior",
      }),
    ).toBe(false);
    // A refusal the holder could place nowhere is about a SAVE rather than a value, so its own
    // section answers it, and nobody else's does.
    expect(
      settlesRefusal({ drawnBy: null, owner: "tools", settled: "tools" }),
    ).toBe(true);
    expect(
      settlesRefusal({ drawnBy: null, owner: "tools", settled: "general" }),
    ).toBe(false);
  });
});
