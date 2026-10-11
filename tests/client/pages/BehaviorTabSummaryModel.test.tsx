/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import { readOtherInboxesState } from "@/client/pages/agents/OtherInboxesFields";
import { behaviorTabProps } from "./behaviorTabProps";

// The summary model serves the attendance summariser and the other-inbox summaries. With attendance
// compaction off and the other inboxes on, the runtime still uses it, so its controls stay on screen:
// hidden, a broken leftover override fails every long conversation's summary with nothing to fix it.

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

function renderWith(compactionEnabled: boolean, otherOn: boolean): void {
  const props = behaviorTabProps({});
  render(
    <BehaviorTab
      {...props}
      mode="production"
      memory={{ ...props.memory, compactionEnabled }}
      otherInboxes={{ ...readOtherInboxesState({}), enabled: otherOn }}
    />,
  );
}

const modelShown = () =>
  screen.queryAllByText(/^(Summary model|Modelo do resumo)$/).length;

describe("the Behavior tab's summary model", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("is shown while only the other-inbox summaries use it", () => {
    renderWith(false, true);
    expect(modelShown()).toBeGreaterThan(0);
  });

  test("is hidden while neither summariser is on", () => {
    renderWith(false, false);
    expect(modelShown()).toBe(0);
  });
});
