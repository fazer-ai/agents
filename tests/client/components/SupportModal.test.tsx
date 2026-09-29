/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { useModalController } from "@/client/components/Modal";
import { SupportModal } from "@/client/components/SupportModal";

const mockWriteText = mock(async (_: string) => {});

Object.defineProperty(navigator, "clipboard", {
  value: { writeText: mockWriteText },
  writable: true,
  configurable: true,
});

function ControlledSupportModal({
  email = "support@example.com",
  mailto = "mailto:support@example.com",
}: {
  email?: string;
  mailto?: string;
}) {
  const modal = useModalController();
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    modal.open();
  }, [modal]);
  return <SupportModal modal={modal} email={email} mailtoHref={mailto} />;
}

describe("SupportModal", () => {
  beforeEach(() => {
    mockWriteText.mockClear();
    mockWriteText.mockImplementation(async () => {});
  });

  afterEach(() => cleanup());

  test("renders email and mailto anchor", () => {
    render(<ControlledSupportModal />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "mailto:support@example.com");
    expect(link).toHaveTextContent("support@example.com");
  });

  test("copy button writes email to clipboard and shows 'Copied'", async () => {
    render(<ControlledSupportModal />);
    const copyBtn = screen.getByRole("button", { name: /copy email/i });
    await act(async () => {
      fireEvent.click(copyBtn);
      await Promise.resolve();
    });
    expect(mockWriteText).toHaveBeenCalledWith("support@example.com");
    expect(
      screen.getByRole("button", { name: /^copied$/i }),
    ).toBeInTheDocument();
  });

  test("shows 'Failed' when clipboard write rejects", async () => {
    mockWriteText.mockImplementationOnce(async () => {
      throw new Error("denied");
    });
    render(<ControlledSupportModal />);
    const copyBtn = screen.getByRole("button", { name: /copy email/i });
    await act(async () => {
      fireEvent.click(copyBtn);
      await Promise.resolve();
    });
    expect(
      screen.getByRole("button", { name: /^failed$/i }),
    ).toBeInTheDocument();
  });

  test("footer close button closes the modal", () => {
    render(<ControlledSupportModal />);
    // Two buttons match /close/i (header X and footer Close). Take the
    // footer one, which renders inside the dialog footer region.
    const closeButtons = screen.getAllByRole("button", { name: /^close$/i });
    fireEvent.click(closeButtons[closeButtons.length - 1] as HTMLButtonElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
