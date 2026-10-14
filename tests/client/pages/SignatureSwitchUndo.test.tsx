/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useRef, useState } from "react";
import {
  BehaviorTab,
  type SignatureState,
} from "@/client/pages/agents/BehaviorTab";
import {
  SIGNATURE_SEED,
  type SignatureSeed,
} from "@/client/pages/agents/signatureFormState";
import { behaviorTabProps } from "./behaviorTabProps";

// The switch remembers the form it seeded, held the way the page holds it: off over that very form
// gives the box back as it was (agents#1440). The memory outlives the tab, and anything that hands
// the tab a new form (an edit, a save, a reload) ends it.
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

// The page's side of it: the signature and the seed live above the tab, which may come and go.
function renderPage(initial: SignatureState) {
  const api = {
    now: () => initial,
    setShown: (_v: boolean) => {},
    replace: (_s: SignatureState) => {},
  };
  function Page() {
    const [signature, setSignature] = useState(initial);
    const [shown, setShown] = useState(true);
    const signatureSeed = useRef<SignatureSeed | null>(null);
    api.now = () => signature;
    api.setShown = setShown;
    api.replace = setSignature;
    return shown ? (
      <BehaviorTab
        {...behaviorTabProps({ signature, setSignature, signatureSeed })}
      />
    ) : null;
  }
  render(<Page />);
  return api;
}

const toggle = () =>
  fireEvent.click(
    screen.getByRole("switch", {
      name: /Add a signature to the agent's messages/i,
    }),
  );

describe("the signature switch on the Behavior tab", () => {
  test("on and off again over an empty box leaves it as it was", () => {
    const page = renderPage(OFF);
    toggle();
    expect(page.now().text).toBe(SIGNATURE_SEED);
    toggle();
    expect(JSON.stringify(page.now())).toBe(JSON.stringify(OFF));
  });

  test("the seed outlives the tab: away and back, off still undoes it", () => {
    const page = renderPage(OFF);
    toggle();
    act(() => page.setShown(false));
    act(() => page.setShown(true));
    toggle();
    expect(JSON.stringify(page.now())).toBe(JSON.stringify(OFF));
  });

  // A save hands the tab the stored block as a new form: the seed is the saved signature now.
  test("after a save, off keeps the seed", () => {
    const page = renderPage(OFF);
    toggle();
    act(() => page.replace({ ...page.now() }));
    toggle();
    expect(page.now().text).toBe(SIGNATURE_SEED);
  });

  test("off over a seed the operator typed keeps it", () => {
    const page = renderPage({ ...OFF, enabled: true, text: SIGNATURE_SEED });
    toggle();
    expect(page.now().text).toBe(SIGNATURE_SEED);
  });
});
