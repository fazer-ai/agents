/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Force the Free edition BEFORE importing ProGate so its `IS_FREE` binding is true. Provide every
// env export the render tree might read so the mock is a drop-in.
mock.module("@/client/lib/env", () => ({
  IS_FREE: true,
  EDITION: "free",
  CDN_URL: "",
  APP_VERSION: "",
  APP_BUILD_ID: "",
}));

const { ProGate } = await import("@/client/components/ProGate");

describe("ProGate (Free edition)", () => {
  afterEach(() => cleanup());
  afterAll(() => {
    // Reset the global env mock to the Full defaults so this suite's Free override does not leak into
    // sibling suites (Bun mock.module is process-global). See ProGate.full.test.tsx.
    mock.module("@/client/lib/env", () => ({
      IS_FREE: false,
      EDITION: "full",
      CDN_URL: "",
      APP_VERSION: "",
      APP_BUILD_ID: "",
    }));
  });

  test("renders the upsell trigger with the given label", () => {
    render(<ProGate feature="multiTenant" triggerLabel="Create tenant" />);
    expect(
      screen.getByRole("button", { name: /create tenant/i }),
    ).toBeInTheDocument();
    // Modal starts closed: no dialog until the trigger is clicked.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("opens a modal with the upgrade CTA pointing at the hub", () => {
    render(<ProGate feature="multiTenant" triggerLabel="Create tenant" />);
    fireEvent.click(screen.getByRole("button", { name: /create tenant/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /upgrade/i });
    expect(cta).toHaveAttribute("href", "https://app.fazer.ai/#/agents");
    expect(cta).toHaveAttribute("target", "_blank");
  });

  test("dismiss closes the modal without navigating", () => {
    render(<ProGate feature="multiTenant" triggerLabel="Create tenant" />);
    fireEvent.click(screen.getByRole("button", { name: /create tenant/i }));
    fireEvent.click(screen.getByRole("button", { name: /maybe later/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
