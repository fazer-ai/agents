import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { z } from "zod";
import {
  invalidCaseAttributeKey,
  readCrossInboxCaseState,
  serializeCrossInboxCase,
  showsSubjectField,
  withDestination,
} from "@/client/pages/agents/CrossInboxCaseFields";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { readCrossInboxCaseConfig } from "@/modules/cross-inbox-case/settings";
import {
  type EditorStub,
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// `crossInboxCase` is config OF the open_case_in_inbox tool, so it is edited on the
// tool's card and written by the Tools tab's save, the way `handoff` is. Two saves write the same
// settings column, and each one resends the whole bag, so the ownership has to be exact on both
// sides: the Tools save writes the block and keeps the shared bag in step, and the Behavior save
// never names it, so its `...settings` spread carries the stored value through.

describe("the form round-trips what is stored", () => {
  test("every field the reader honors survives a load and a save", () => {
    const stored = {
      targetInboxId: 40,
      targetInstanceId: 3,
      originLabel: "caso-aberto",
      caseAttributeKey: "protocolo",
      mergeContacts: true,
      resolveOrigin: true,
      caseLabels: ["agente-sac", "veio-do-whatsapp"],
      subjectTemplate: "Solicitação de {{nome_contato}}: {{resumo}}",
      openingTemplate: "Olá {{primeiro_nome}}\n\n{{mensagem}}",
      noteTemplate: "{{motivo}} {{link_origem}}",
      carryAttachments: {
        mode: "attendance" as const,
        fileTypes: ["file" as const, "video" as const],
        maxFiles: 4,
      },
    };
    const saved = serializeCrossInboxCase(readCrossInboxCaseState(stored));
    expect(readCrossInboxCaseConfig({ crossInboxCase: saved })).toEqual(stored);
  });

  test("clearing the opening and the note templates saves none (issue #923)", () => {
    const state = readCrossInboxCaseState({
      targetInboxId: 40,
      openingTemplate: "Olá {{mensagem}}",
      noteTemplate: "{{motivo}}",
    });
    const saved = serializeCrossInboxCase({
      ...state,
      openingTemplate: "  ",
      noteTemplate: "",
    });
    expect(saved.openingTemplate).toBeNull();
    expect(saved.noteTemplate).toBeNull();
  });

  test("clearing the inbox clears the instance too, and an empty key falls back to the default", () => {
    const state = readCrossInboxCaseState({
      targetInboxId: 40,
      targetInstanceId: 3,
      caseAttributeKey: "protocolo",
    });
    const saved = serializeCrossInboxCase({
      ...state,
      targetInboxId: "",
      caseAttributeKey: " ",
    });
    expect(saved.targetInboxId).toBeNull();
    expect(saved.targetInstanceId).toBeNull();
    expect(
      readCrossInboxCaseConfig({ crossInboxCase: saved }).caseAttributeKey,
    ).toBe("case_conversation_id");
  });
});

test("case labels picked on the card are saved, and an empty pick saves an empty list (issue #901)", () => {
  const state = readCrossInboxCaseState({
    targetInboxId: 40,
    targetInstanceId: 3,
  });
  expect(state.caseLabels).toEqual([]);
  const saved = serializeCrossInboxCase({
    ...state,
    caseLabels: [" Agente-SAC ", "agente-sac", ""],
  });
  expect(
    readCrossInboxCaseConfig({ crossInboxCase: saved }).caseLabels,
  ).toEqual(["agente-sac"]);
  expect(serializeCrossInboxCase(state).caseLabels).toEqual([]);
});

// The two saves write the same settings column, each resending the whole bag: the Tools save owns
// the block, and a Behavior save carries whatever the Tools save last stored.
describe("which save owns the block", () => {
  const STORED = {
    targetInboxId: 40,
    targetInstanceId: 3,
    caseAttributeKey: "protocolo",
  };
  const KEY_ERROR =
    "Use lowercase letters, digits and _, starting with a letter.";

  async function openTools(): Promise<EditorStub> {
    const stub = stubEditorApi(
      { settings: { crossInboxCase: STORED } },
      { catalog: { native: [{ name: "open_case_in_inbox" }] } },
    );
    await renderEditor(stub, "tools");
    return stub;
  }
  async function keyField(): Promise<HTMLInputElement> {
    if (!screen.queryByPlaceholderText("case_conversation_id")) {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    }
    return (await screen.findByPlaceholderText(
      "case_conversation_id",
    )) as HTMLInputElement;
  }
  async function typeKey(value: string) {
    fireEvent.change(await keyField(), { target: { value } });
  }
  const goTo = async (name: string) => {
    fireEvent.click(screen.getByRole("tab", { name }));
    await act(async () => {});
  };
  const patches = (stub: EditorStub) =>
    stub.writes.filter((w) => w.method === "PATCH" && w.body.settings);
  const savedKey = (stub: EditorStub) =>
    (lastSavedSettings(stub)?.crossInboxCase as { caseAttributeKey?: string })
      ?.caseAttributeKey;
  async function saveBehaviorEdit(stub: EditorStub) {
    const before = patches(stub).length;
    await goTo("Behavior");
    fireEvent.click(
      await screen.findByRole("switch", {
        name: /Stop answering when a person replies to the customer/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches(stub).length).toBe(before + 1));
  }
  const dirty = (name: string) =>
    screen.getByRole("tab", { name }).querySelector(".bg-warning") !== null;

  test("the Tools save writes it, and a later Behavior save keeps what it wrote", async () => {
    const stub = await openTools();
    await typeKey("protocolo_novo");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedKey(stub)).toBe("protocolo_novo"));

    await saveBehaviorEdit(stub);
    expect(savedKey(stub)).toBe("protocolo_novo");
  });

  // The bar saves the agent, Behavior before Tools (agents#1520). With the Tools write failing, the
  // Behavior PATCH that went out carries the stored key, and its re-read leaves the draft on the field.
  test("an unsaved Tools edit is neither written by a Behavior save nor wiped by it", async () => {
    const stub = await openTools();
    await typeKey("rascunho");
    stub.override = (method, path) =>
      method === "PUT" && path.endsWith("/tool-selections")
        ? Response.json({ error: "boom" }, { status: 500 })
        : undefined;

    await saveBehaviorEdit(stub);
    expect(savedKey(stub)).toBe("protocolo");
    await goTo("Tools");
    expect((await keyField()).value).toBe("rascunho");
  });

  test("the stored block loads into the card, and an edit lights the Tools tab's unsaved dot only", async () => {
    await openTools();
    expect((await keyField()).value).toBe("protocolo");
    expect(dirty("Tools")).toBe(false);
    await typeKey("outro_campo");
    await waitFor(() => expect(dirty("Tools")).toBe(true));
    expect(dirty("Behavior")).toBe(false);
  });

  // A PATCH refusing the key would come after the grants PUT, leaving new grants beside the old
  // settings, so the save stops before either request.
  test("a key the reader would replace is flagged on the field and stops the Tools save", async () => {
    const stub = await openTools();
    await typeKey("Ticket-ID");
    expect(screen.getAllByText(KEY_ERROR).length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getAllByText(KEY_ERROR).length).toBe(2));
    expect(stub.writes).toEqual([]);
  });
});

// The reader replaces a key outside lowercase snake_case with the default, so
// a key like that is refused where it is written instead of saved and silently ignored.
describe("the attribute key is checked where it is written", () => {
  const patch = z.object(BEHAVIOR_PATCH_SHAPE);
  const accepts = (caseAttributeKey: string) =>
    patch.safeParse({ crossInboxCase: { caseAttributeKey } }).success;
  test("a key the reader would replace is refused", () => {
    expect(accepts("Ticket-ID")).toBe(false);
    expect(accepts("1protocolo")).toBe(false);
    expect(accepts("a".repeat(65))).toBe(false);
  });
  test("a key the reader honors, or none, is accepted", () => {
    expect(accepts("protocolo_caso")).toBe(true);
    expect(accepts(" protocolo ")).toBe(true);
    expect(accepts("")).toBe(true);
  });
  test("the editor flags the same keys before the save", () => {
    const at = (caseAttributeKey: string) =>
      invalidCaseAttributeKey({
        ...readCrossInboxCaseState({}),
        caseAttributeKey,
      });
    expect(at("Ticket-ID")).toBe(true);
    expect(at("protocolo_caso")).toBe(false);
    expect(at(" protocolo ")).toBe(false);
    expect(at("")).toBe(false);
  });
});

describe("the email subject field", () => {
  test("offered for an email destination only", () => {
    expect(showsSubjectField("Channel::Email", "")).toBe(true);
    expect(showsSubjectField("Channel::Whatsapp", "Caso {{resumo}}")).toBe(
      false,
    );
    expect(showsSubjectField("Channel::Api", "")).toBe(false);
  });
  test("a saved template stays visible before the inbox list loads", () => {
    expect(showsSubjectField(undefined, "Caso {{resumo}}")).toBe(true);
    expect(showsSubjectField(undefined, "  ")).toBe(false);
  });
  test("picking a destination that is not email drops the template", () => {
    const state = {
      ...readCrossInboxCaseState({ targetInboxId: 40 }),
      subjectTemplate: "Caso {{resumo}}",
    };
    expect(
      withDestination(state, "41", "3", "Channel::Api").subjectTemplate,
    ).toBe("");
    expect(withDestination(state, "41", "3", null).subjectTemplate).toBe("");
    expect(
      withDestination(state, "42", "3", "Channel::Email").subjectTemplate,
    ).toBe("Caso {{resumo}}");
    expect(withDestination(state, "", "", undefined).subjectTemplate).toBe("");
    expect(withDestination(state, "43", "3", undefined).subjectTemplate).toBe(
      "Caso {{resumo}}",
    );
  });
});
