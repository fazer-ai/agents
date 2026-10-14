/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  BehaviorTab,
  type SignatureState,
} from "@/client/pages/agents/BehaviorTab";
import { SIGNATURE_SEED } from "@/client/pages/agents/signatureFormState";
import { behaviorTabProps } from "./behaviorTabProps";

// The switch asks the block AS SAVED when it moves: turning it off over the seed it just put there
// gives back the saved empty box, so on and off again leaves the tab clean (agents#1440).
//
// Every assertion reduces to a value BEFORE expect: a failing expectation holding a DOM node
// serializes a cyclic happy-dom tree and stalls the runner.

const SAVED: SignatureState = {
  enabled: false,
  text: "",
  position: "top",
  frequency: "all",
  separator: "blank",
};

afterEach(cleanup);

describe("the signature switch on the Behavior tab", () => {
  test("turning it off over the untouched seed writes the saved empty box", () => {
    const written: SignatureState[] = [];
    render(
      <BehaviorTab
        {...behaviorTabProps({
          signature: { ...SAVED, enabled: true, text: SIGNATURE_SEED },
          setSignature: (v) => {
            if (typeof v !== "function") written.push(v);
          },
          savedSignature: () => SAVED,
        })}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: /Add a signature to the agent's messages/i,
    });
    fireEvent.click(toggle);
    expect(JSON.stringify(written.at(-1))).toBe(JSON.stringify(SAVED));
  });
});
