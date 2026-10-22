/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ToastProvider } from "@/client/components";
import {
  parseHeaderLines,
  type RunTest,
  TestReceptionPanel,
  type TestResult,
} from "@/client/pages/resources/TestReceptionPanel";

afterEach(cleanup);

test("headers pasted as Name: value lines become a map, and a line without a name is dropped", () => {
  expect(
    parseHeaderLines(
      "x-signature: ts=1,v1=ab:cd\r\nX-Request-Id:  req-1 \nno colon here\n: orphan",
    ),
  ).toEqual({ "x-signature": "ts=1,v1=ab:cd", "X-Request-Id": "req-1" });
});

test("a header pasted twice is one header with both values, as the webhook reads it", () => {
  expect(
    parseHeaderLines(
      "asaas-access-token: bad\nAsaas-Access-Token: good\nasaas-access-token: third",
    ),
  ).toEqual({ "asaas-access-token": "bad, good, third" });
});

test("the pasted notification goes to the server as typed, simulated by default, and each stage comes back with its verdict", async () => {
  const calls: Parameters<RunTest>[0][] = [];
  const answer: TestResult = {
    dryRun: true,
    outcome: "unauthorized",
    stages: [
      {
        stage: "signature",
        ok: false,
        reason: "credential_mismatch",
        detail: { header: "x-signature", signedMessage: "id:123;ts:1;" },
      },
    ],
  };
  const run: RunTest = async (input) => {
    calls.push(input);
    return answer;
  };
  render(
    <ToastProvider>
      <TestReceptionPanel run={run} />
    </ToastProvider>,
  );
  const button = screen.getByRole("button", { name: "Run test" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Notification body"), {
    target: { value: '{"data":{"id":"123"}}' },
  });
  fireEvent.change(screen.getByLabelText("Headers"), {
    target: { value: "x-signature: ts=1,v1=ab" },
  });
  fireEvent.change(screen.getByLabelText("URL parameters"), {
    target: { value: " data.id=123&type=payment " },
  });
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByText("credential_mismatch")));
  expect(calls).toEqual([
    {
      body: '{"data":{"id":"123"}}',
      headers: { "x-signature": "ts=1,v1=ab" },
      query: "data.id=123&type=payment",
      dryRun: true,
    },
  ]);
  expect(screen.getByText("Signature")).toBeTruthy();
  expect(screen.getByLabelText("stopped here")).toBeTruthy();
  expect(screen.getByText(/signedMessage: id:123;ts:1;/)).toBeTruthy();

  fireEvent.click(
    screen.getByRole("switch", {
      name: "Simulate only (nothing is recorded or sent)",
    }),
  );
  fireEvent.click(button);
  await waitFor(() => expect(calls.length).toBe(2));
  expect(calls[1]?.dryRun).toBe(false);
});

test("the editor hears while a test is out, so it can hold its close and save", async () => {
  const seen: boolean[] = [];
  let finish: (r: TestResult) => void = () => {};
  const run: RunTest = () =>
    new Promise<TestResult>((resolve) => {
      finish = resolve;
    });
  render(
    <ToastProvider>
      <TestReceptionPanel run={run} onRunningChange={(r) => seen.push(r)} />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByLabelText("Notification body"), {
    target: { value: "{}" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run test" }));
  expect(seen).toEqual([true]);
  finish({ dryRun: true, outcome: "queued", stages: [] });
  await waitFor(() => expect(seen).toEqual([true, false]));
});

test("no test starts while the editor saves", () => {
  render(
    <ToastProvider>
      <TestReceptionPanel
        run={async () => ({ dryRun: true, outcome: "queued", stages: [] })}
        disabled
      />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByLabelText("Notification body"), {
    target: { value: "{}" },
  });
  expect(
    (screen.getByRole("button", { name: "Run test" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
