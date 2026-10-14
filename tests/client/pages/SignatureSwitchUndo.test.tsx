/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  BehaviorTab,
  type SignatureState,
} from "@/client/pages/agents/BehaviorTab";
import { SIGNATURE_SEED } from "@/client/pages/agents/signatureFormState";
import { behaviorTabProps } from "./behaviorTabProps";

// The switch remembers whether it put the seed in the box: off over its own untouched seed gives
// the box back as it was, and off over a seed the operator typed keeps it (agents#1440).
//
// Every assertion reduces to a value BEFORE expect: a failing expectation holding a DOM node
// serializes a cyclic happy-dom tree and stalls the runner.

const OFF: SignatureState = {
  enabled: false,
  text: "",
  position: "top",
  frequency: "all",
  separator: "blank",
};

afterEach(cleanup);

function renderTab(initial: SignatureState): { now: () => SignatureState } {
  let current = initial;
  function Harness() {
    const [signature, setSignature] = useState(initial);
    current = signature;
    return <BehaviorTab {...behaviorTabProps({ signature, setSignature })} />;
  }
  render(<Harness />);
  return { now: () => current };
}

const toggle = () =>
  fireEvent.click(
    screen.getByRole("switch", {
      name: /Add a signature to the agent's messages/i,
    }),
  );

describe("the signature switch on the Behavior tab", () => {
  test("on and off again over an empty box leaves it as it was", () => {
    const tab = renderTab(OFF);
    toggle();
    expect(tab.now().text).toBe(SIGNATURE_SEED);
    toggle();
    expect(JSON.stringify(tab.now())).toBe(JSON.stringify(OFF));
  });

  test("off over a seed the operator typed keeps it", () => {
    const typed = { ...OFF, enabled: true, text: SIGNATURE_SEED };
    const tab = renderTab(typed);
    toggle();
    expect(tab.now().text).toBe(SIGNATURE_SEED);
  });
});
