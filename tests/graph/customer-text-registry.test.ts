import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { toJSONSchema } from "zod";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import {
  customerTextOf,
  TOOL_ARG_AUDIENCE,
  TRANSFER_LINE_ARG,
} from "@/graph/tools/customer-text";
import {
  buildNativeTools,
  buildSimulatedNativeTools,
} from "@/graph/tools/native";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CONTACT_FIELDS } from "@/modules/chatwoot/contact-fields";
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";
import {
  buildToolpackTools,
  getToolpackToolNames,
  type ToolpackCtx,
} from "@/modules/integrations/toolpacks";

// The turn review's rules read every argument through which the model's text reaches the customer
// (customer-text.ts). The registry is only as good as its coverage, so this walks every tool the
// product builds, in every shape that adds an argument, and asks that each argument be listed.

type Ctx = Parameters<typeof buildNativeTools>[0];
const natives = (over: Record<string, unknown> = {}): Ctx =>
  ({
    client: {} as ChatwootClient,
    conversationId: 7,
    kanban: {
      taskId: 3,
      currentStepId: 1,
      boardName: "Funil",
      card: {},
      steps: [{ id: 1, name: "Novo" }],
    },
    contactFields: { writable: [...CONTACT_FIELDS] },
    crossInboxCase: {
      // A subject that asks for a summary adds that argument.
      config: {
        ...CROSS_INBOX_CASE_DEFAULTS,
        targetInboxId: 9,
        subjectTemplate: "{{summary}}",
      },
      contactId: 55,
    },
    ...over,
  }) as unknown as Ctx;

const PACKS = [
  "ASAAS",
  "GOOGLE_CALENDAR",
  "GOOGLE_DRIVE",
  "GOOGLE_SHEETS",
  "RESEND",
] as const;
const pack = (type: (typeof PACKS)[number]) =>
  buildToolpackTools(
    [
      {
        instanceId: 1n,
        catalogType: type,
        config: { calendarIds: ["primary"] },
        credentialRef: "cred",
        enabledTools: getToolpackToolNames(type),
      },
    ],
    {
      tenantId: 1n,
      base: {} as never,
      threadId: "1:1:1",
      resolveCredential: async () => "tok",
      assertSafe: async () => undefined,
      fetchImpl: fetch,
    } as ToolpackCtx,
  );

const argsOf = (t: StructuredToolInterface): string[] =>
  Object.keys(
    (toJSONSchema(t.schema as never) as { properties?: object }).properties ??
      {},
  );

const everyTool = (): StructuredToolInterface[] => [
  ...buildNativeTools(natives()),
  // The handoff that lets the model pick who takes the case adds `assignTo`.
  ...buildNativeTools(natives({ handoff: { mode: "agent_choice" } })),
  ...buildSimulatedNativeTools(natives()),
  ...PACKS.flatMap(pack),
];

describe("the registry of text that reaches the customer", () => {
  // The bug it catches: a tool, or a new argument of one, whose text the customer reads and the
  // rules never see, because nobody said which kind of argument it is.
  test("every argument of every tool the product builds is classified", () => {
    const unlisted = everyTool().flatMap((t) =>
      argsOf(t)
        .filter((arg) => TOOL_ARG_AUDIENCE[t.name]?.[arg] === undefined)
        .map((arg) => `${t.name}.${arg}`),
    );
    expect([...new Set(unlisted)]).toEqual([]);
    const built = new Set(everyTool().map((t) => t.name));
    expect([...NATIVE_TOOL_NAMES].filter((n) => !built.has(n))).toEqual([]);
    // And nothing stale: a tool that no longer exists reads no call.
    expect(Object.keys(TOOL_ARG_AUDIENCE).filter((n) => !built.has(n))).toEqual(
      [],
    );
  });

  test("the arguments the customer reads are these, and no others", () => {
    const read = Object.entries(TOOL_ARG_AUDIENCE).flatMap(([tool, args]) =>
      Object.entries(args)
        .filter(([, who]) => who !== "internal")
        .map(([arg, who]) => `${tool}.${arg}:${who}`),
    );
    expect(read.sort()).toEqual([
      "asaas_create_pix_charge.description:customer",
      "asaas_payment_link_create.description:customer",
      "asaas_payment_link_create.name:customer",
      "calendar_create_event.description:customer",
      "calendar_create_event.summary:customer",
      "calendar_update_event.description:customer",
      "calendar_update_event.summary:customer",
      "drive_send_file.caption:customer",
      "handoff_to_human.customerMessage:transfer",
      "open_case_in_inbox.customer_message:customer",
      "open_case_in_inbox.handoff_message:transfer",
      "resend_send_email.html:customer",
      "resend_send_email.subject:customer",
      "send_image.caption:customer",
    ]);
    expect(TRANSFER_LINE_ARG).toEqual({
      handoff_to_human: "customerMessage",
      open_case_in_inbox: "handoff_message",
    });
  });

  test("a call's text is read per argument, and a document tool's from every value", () => {
    expect(
      customerTextOf({
        name: "open_case_in_inbox",
        args: {
          reason: "interno",
          customer_message: "Abri o seu caso.",
          handoff_message: "Um atendente vai continuar.",
        },
      }),
    ).toEqual([
      { field: "customer_message", text: "Abri o seu caso.", transfer: false },
      {
        field: "handoff_message",
        text: "Um atendente vai continuar.",
        transfer: true,
      },
    ]);
    const call = {
      name: "send_orcamento",
      args: { cliente: "Ana", itens: [{ descricao: "Reembolso", valor: 10 }] },
    };
    expect([
      customerTextOf(call),
      customerTextOf(call, (n) => n === "send_orcamento"),
    ]).toEqual([[], [{ field: "*", text: "Ana\nReembolso", transfer: false }]]);
  });
});
