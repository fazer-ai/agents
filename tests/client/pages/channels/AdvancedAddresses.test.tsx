/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { AdvancedAddresses } from "@/client/pages/channels/AdvancedAddresses";

// The section folds the two rarely used addresses of a Chatwoot connection. It opens by itself when
// either already has a value or shows an error, and folded with a value its header says what is set.
// Assertions reduce to booleans and strings before expect: a DOM node in a failing expectation
// serializes a cyclic happy-dom tree.

function Harness(props: {
  webhook?: string;
  pub?: string;
  webhookError?: string | null;
  publicError?: string | null;
}) {
  const [webhook, setWebhook] = useState(props.webhook ?? "");
  const [pub, setPub] = useState(props.pub ?? "");
  return (
    <AdvancedAddresses
      webhookBaseUrl={webhook}
      publicUrl={pub}
      onWebhookBaseUrl={setWebhook}
      onPublicUrl={setPub}
      webhookBaseUrlError={props.webhookError ?? null}
      publicUrlError={props.publicError ?? null}
    />
  );
}

const toggle = () => screen.getByRole("button", { name: /Advanced/ });
const expanded = () => toggle().getAttribute("aria-expanded");
const fieldCount = () => screen.queryAllByRole("textbox").length;

afterEach(cleanup);

describe("the Advanced section of a Chatwoot connection", () => {
  test("starts folded when both addresses are empty, with no summary", () => {
    render(<Harness />);
    expect(expanded()).toBe("false");
    expect(fieldCount()).toBe(0);
    expect(toggle().textContent ?? "").not.toContain("configured");
  });

  test("starts open when an address already has a value", () => {
    render(<Harness webhook="http://10.0.0.6:3000" />);
    expect(expanded()).toBe("true");
    expect(fieldCount()).toBe(2);
  });

  test("opens by itself on an error inside it, and stays open while it lasts", () => {
    const { rerender } = render(<Harness />);
    expect(expanded()).toBe("false");
    rerender(<Harness publicError="Must be an http(s) address" />);
    expect(expanded()).toBe("true");
    fireEvent.click(toggle());
    expect(expanded()).toBe("true");
  });

  test("folded with a value, the header says what is set", () => {
    render(<Harness webhook="http://10.0.0.6:3000" />);
    fireEvent.click(toggle());
    expect(expanded()).toBe("false");
    expect(toggle().textContent ?? "").toContain("Private network configured");
    cleanup();
    render(<Harness pub="https://chat.example.com" />);
    fireEvent.click(toggle());
    expect(toggle().textContent ?? "").toContain("Public address configured");
  });

  test("typing into a field opened by hand does not fold it", () => {
    render(<Harness />);
    fireEvent.click(toggle());
    const [first] = screen.getAllByRole("textbox");
    if (!first) throw new Error("no field");
    fireEvent.change(first, { target: { value: "http://10.0.0.6:3000" } });
    fireEvent.change(first, { target: { value: "" } });
    expect(expanded()).toBe("true");
  });
});
