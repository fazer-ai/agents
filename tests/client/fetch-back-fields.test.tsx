/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { FieldRefusal } from "@/client/hooks/useFieldRefusal";
import {
  FetchBackFields,
  type FetchBackTool,
  fetchBackFields,
  fetchBackFieldValues,
  idFieldsOf,
} from "@/client/pages/resources/FetchBackFields";
import { parseFetchBackConfig } from "@/modules/integrations/fetch-back";

afterEach(cleanup);

const noRefusal: FieldRefusal = {
  at: () => null,
  capture: () => null,
  clear: () => {},
  field: null,
  message: null,
};

const TOOLS: FetchBackTool[] = [
  {
    id: "7",
    label: "Consultar pagamento",
    name: "consultar_pagamento",
    enabled: true,
    inputSchema: {
      api_version: { type: "string", source: "fixed", value: "v1" },
      payment_id: { type: "string", required: true },
    },
  },
  {
    id: "8",
    label: "Desligada",
    name: "desligada",
    enabled: false,
    inputSchema: { id: { type: "string" } },
  },
];

function Harness({
  initial,
  refusal = noRefusal,
  out,
}: {
  initial: Record<string, unknown>;
  refusal?: FieldRefusal;
  out: { cfg?: Record<string, unknown> };
}) {
  const [cfg, setCfgState] = useState(initial);
  out.cfg = cfg;
  const setCfg = (patch: Record<string, unknown>) =>
    setCfgState((c) => ({ ...c, ...patch }));
  return (
    <FetchBackFields
      cfg={cfg}
      setCfg={setCfg}
      refusal={refusal}
      tools={TOOLS}
    />
  );
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

test("the Mercado Pago lookup set up on the screen is the config the receptor reads", () => {
  const out: { cfg?: Record<string, unknown> } = {};
  render(<Harness initial={{ instructions: "x" }} out={out} />);
  expect(screen.queryByLabelText("Lookup tool")).toBeNull();

  fireEvent.click(
    screen.getByRole("switch", {
      name: "Look up each notification with a tool",
    }),
  );
  fireEvent.change(screen.getByLabelText("Lookup tool"), {
    target: { value: "7" },
  });
  // The fixed field is not offered: only a field the model would fill can carry the id.
  const idArg = screen.getByLabelText(
    "Tool field for the id",
  ) as HTMLSelectElement;
  expect([...idArg.options].map((o) => o.value)).toEqual(["payment_id"]);
  type("Response field with the amount", "transaction_amount");
  type("Response field with the currency", "currency_id");
  type("What the agent is told 1", "Pagamento aprovado");
  fireEvent.click(screen.getByRole("button", { name: "Add status" }));
  type("Status 2", "rejected");
  type("What the agent is told 2", "Pagamento recusado");

  expect(out.cfg).toEqual({
    instructions: "x",
    fetchBack: {
      toolId: "7",
      idFrom: "query.data.id",
      idArg: "payment_id",
      conversationRefPath: "external_reference",
      statusPath: "status",
      valuePath: "transaction_amount",
      currencyPath: "currency_id",
      statuses: [
        { status: "approved", paid: true, text: "Pagamento aprovado" },
        { status: "rejected", text: "Pagamento recusado" },
      ],
    },
  });
  expect(parseFetchBackConfig(out.cfg?.fetchBack)).toMatchObject({
    toolId: 7n,
    idArg: "payment_id",
  });

  // An emptied input removes its key rather than sending "" for the server to refuse.
  type("Response field with the currency", "");
  expect(
    Object.keys(out.cfg?.fetchBack as Record<string, unknown>),
  ).not.toContain("currencyPath");
  type("Response field with the currency", "currency_id");

  // Turning it off removes the key, so an instance takes GENERIC's own body again.
  fireEvent.click(
    screen.getByRole("switch", {
      name: "Look up each notification with a tool",
    }),
  );
  expect(out.cfg?.fetchBack).toBeUndefined();
});

test("a disabled tool is listed but cannot be picked, and a removed status leaves the config", () => {
  const out: { cfg?: Record<string, unknown> } = {};
  render(
    <Harness
      initial={{
        fetchBack: {
          toolId: "7",
          idFrom: "query.data.id",
          idArg: "payment_id",
          conversationRefPath: "external_reference",
          statusPath: "status",
          statuses: [
            { status: "approved", paid: true },
            { status: "rejected", text: "x" },
          ],
        },
      }}
      out={out}
    />,
  );
  const option = screen.getByRole("option", {
    name: "Desligada",
  }) as HTMLOptionElement;
  expect(option.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove 1" }));
  expect((out.cfg?.fetchBack as { statuses?: unknown[] })?.statuses).toEqual([
    { status: "rejected", text: "x" },
  ]);
});

test("a refusal about one status row lands under that row", () => {
  const cfg = {
    fetchBack: {
      toolId: "7",
      idFrom: "query.data.id",
      idArg: "payment_id",
      conversationRefPath: "external_reference",
      statusPath: "status",
      statuses: [
        { status: "approved", paid: true, text: "Pago" },
        { status: "in_process" },
      ],
    },
  };
  expect(fetchBackFields(cfg)).toContain("config.fetchBack.statuses.1.text");
  const values = fetchBackFieldValues(cfg);
  const refusal: FieldRefusal = {
    ...noRefusal,
    at: (field, value) =>
      field === "config.fetchBack.statuses.1.text" && value === values[field]
        ? "is required: it is what reaches the conversation"
        : null,
  };
  render(<Harness initial={cfg} refusal={refusal} out={{}} />);
  expect(
    screen.getByText("is required: it is what reaches the conversation"),
  ).toBeTruthy();
  expect(parseFetchBackConfig(cfg.fetchBack)).toMatchObject({
    field: "statuses.1.text",
  });
});

test("a lookup imported with malformed status rows still opens, so it can be repaired", () => {
  for (const statuses of [{}, [null], "x"]) {
    const cfg = { fetchBack: { toolId: "7", statuses } };
    expect(() => fetchBackFields(cfg)).not.toThrow();
    expect(() => fetchBackFieldValues(cfg)).not.toThrow();
    render(<Harness initial={cfg} out={{}} />);
    expect(
      screen.getByRole("switch", {
        name: "Look up each notification with a tool",
      }),
    ).toBeTruthy();
    cleanup();
  }
});

test("a legacy tool stored as JSON Schema offers its properties as id fields, not `properties` and `required`", () => {
  expect(
    idFieldsOf({
      id: "9",
      label: "Legado",
      name: "legado",
      enabled: true,
      inputSchema: {
        type: "object",
        properties: { payment_id: { type: "string" } },
        required: ["payment_id"],
      },
    }),
  ).toEqual(["payment_id"]);
});

test("switching the lookup on starts from a paid status whose text is already filled", () => {
  const out: { cfg?: Record<string, unknown> } = {};
  render(<Harness initial={{}} out={out} />);
  fireEvent.click(screen.getByRole("switch"));
  const fb = out.cfg?.fetchBack as { statuses?: unknown[] } | undefined;
  expect(fb?.statuses).toEqual([
    { status: "approved", paid: true, text: "Payment approved" },
  ]);
});
