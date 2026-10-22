/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { FieldRefusal } from "@/client/hooks/useFieldRefusal";
import { InboundSignatureFields } from "@/client/pages/resources/InboundSignatureFields";

afterEach(cleanup);

const noRefusal: FieldRefusal = {
  at: () => null,
  capture: () => null,
  clear: () => {},
  field: null,
  message: null,
};

function Harness({
  initial,
  seen,
}: {
  initial: Record<string, unknown>;
  seen: Record<string, unknown>[];
}) {
  const [cfg, setCfgState] = useState(initial);
  const setCfg = (patch: Record<string, unknown>) =>
    setCfgState((c) => {
      const next = { ...c, ...patch };
      seen.push(next);
      return next;
    });
  return (
    <InboundSignatureFields cfg={cfg} setCfg={setCfg} refusal={noRefusal} />
  );
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

test("the Mercado Pago recipe typed into the screen is the config the receptor reads", () => {
  const seen: Record<string, unknown>[] = [];
  render(<Harness initial={{ instructions: "x" }} seen={seen} />);
  type("Signature header", "x-signature");
  fireEvent.change(screen.getByLabelText("Signature format"), {
    target: { value: "parts" },
  });
  type("Part with the timestamp", "ts");
  type(
    "Signed message",
    "[[id:{{query.data.id|lower}};]][[request-id:{{header.x-request-id}};]]ts:{{sig.ts}};",
  );
  type("Refuse notifications older than (seconds)", "600");
  expect(seen.at(-1)).toEqual({
    instructions: "x",
    signatureHeader: "x-signature",
    signature: {
      format: "parts",
      signaturePart: "v1",
      timestampPart: "ts",
      message:
        "[[id:{{query.data.id|lower}};]][[request-id:{{header.x-request-id}};]]ts:{{sig.ts}};",
      maxAgeSeconds: 600,
    },
  });
});

test("going back to the whole-header format with an empty message leaves no signature key", () => {
  const seen: Record<string, unknown>[] = [];
  render(
    <Harness
      initial={{
        signature: {
          format: "parts",
          signaturePart: "v1",
          timestampPart: "ts",
          message: "{{sig.ts}}.{{body}}",
          maxAgeSeconds: 60,
        },
      }}
      seen={seen}
    />,
  );
  fireEvent.change(screen.getByLabelText("Signature format"), {
    target: { value: "hex" },
  });
  type("Signed message", "");
  expect(seen.at(-1)?.signature).toBeUndefined();
  expect(
    screen.queryByLabelText("Part with the signature"),
  ).not.toBeInTheDocument();
});
