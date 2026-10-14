/// <reference lib="dom" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

// Force the Full edition (IS_FREE false) BEFORE importing ProGate so this suite is order-independent:
// a sibling suite that mock.module's env to the Free edition must NOT leak in (Bun's mock.module is
// process-global and not auto-reset across files). Guards the invariant that Pro/master builds never
// surface the upsell.
mock.module("@/client/lib/env", () => ({
  IS_FREE: false,
  EDITION: "full",
  CDN_URL: "",
  APP_VERSION: "",
  APP_BUILD_ID: "",
}));

const { ProGate } = await import("@/client/components/ProGate");

describe("ProGate (Full edition)", () => {
  afterEach(() => cleanup());

  test("renders nothing", () => {
    const { container } = render(<ProGate feature="multiTenant" />);
    expect(container).toBeEmptyDOMElement();
  });
});
