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
import { I18nextProvider } from "react-i18next";
import {
  ConfirmDialog,
  type ConfirmPayload,
} from "@/client/components/ConfirmDialog";
import { useModalController } from "@/client/components/Modal";
import {
  StrongConfirmModal,
  type StrongConfirmPayload,
} from "@/client/components/StrongConfirmModal";
import { createTestI18n } from "@/tests/utils/i18n";

const i18n = createTestI18n();

// The contract of both dialogs: a caller throws from `onConfirm` to keep the dialog open, after
// showing its own error. The click handler is the only thing awaiting it, so whatever the dialog
// lets through surfaces as an unhandled rejection.
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  cleanup();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function OpenConfirm({ onConfirm }: Pick<ConfirmPayload, "onConfirm">) {
  const modal = useModalController<ConfirmPayload>();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    modal.open({ title: "Delete source", confirmLabel: "Delete", onConfirm });
  }, [modal, onConfirm]);
  return (
    <I18nextProvider i18n={i18n}>
      <ConfirmDialog modal={modal} />
    </I18nextProvider>
  );
}

function OpenStrongConfirm({
  onConfirm,
}: Pick<StrongConfirmPayload, "onConfirm">) {
  const modal = useModalController<StrongConfirmPayload>();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    modal.open({
      title: "Disconnect instance",
      warning: "Everything goes.",
      confirmPhrase: "chat.example.com",
      confirmLabel: "Type chat.example.com to confirm",
      actionLabel: "Disconnect",
      onConfirm,
    });
  }, [modal, onConfirm]);
  return (
    <I18nextProvider i18n={i18n}>
      <StrongConfirmModal modal={modal} />
    </I18nextProvider>
  );
}

const REJECTIONS: [string, () => Promise<void>][] = [
  [
    "an Error",
    async () => {
      throw new Error("delete failed");
    },
  ],
  [
    "a value that is not an Error",
    async () => {
      throw { status: 500 };
    },
  ],
  [
    "a synchronous throw",
    () => {
      throw new Error("delete failed");
    },
  ],
];

describe("ConfirmDialog", () => {
  for (const [label, reject] of REJECTIONS) {
    test(`keeps the dialog open and swallows ${label} from onConfirm`, async () => {
      render(<OpenConfirm onConfirm={reject} />);
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await settle();
      expect(unhandled).toEqual([]);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    });
  }

  test("closes once onConfirm resolves, including on a retry after a failure", async () => {
    let attempts = 0;
    const onConfirm = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("delete failed");
    });
    render(<OpenConfirm onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await settle();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await settle();
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(unhandled).toEqual([]);
  });
});

describe("StrongConfirmModal", () => {
  async function confirm() {
    fireEvent.change(screen.getByLabelText(/type chat\.example\.com/i), {
      target: { value: "chat.example.com" },
    });
    fireEvent.change(
      screen.getByLabelText(/your password/i, { selector: "input" }),
      {
        target: { value: "hunter2" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await settle();
  }

  for (const [label, reject] of REJECTIONS) {
    test(`keeps the dialog open and swallows ${label} from onConfirm`, async () => {
      render(<OpenStrongConfirm onConfirm={reject} />);
      await confirm();
      expect(unhandled).toEqual([]);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  }

  test("closes once onConfirm resolves", async () => {
    const onConfirm = mock(async (_password: string) => {});
    render(<OpenStrongConfirm onConfirm={onConfirm} />);
    await confirm();
    expect(onConfirm).toHaveBeenCalledWith("hunter2");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
