/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { OccurrenceFlagHistory } from "@/client/pages/resources/OccurrenceFlagHistory";

// The Themes tab's "Flagged in a period" (docs/occurrences.md, "Flag history"): the episodes of the
// period picked, a custom one included, each with the title then, its span or "still flagged", its
// conversations and peak, the theme it is part of now, and a way to open the theme.

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const episode = (over: Record<string, unknown>) => ({
  id: "1",
  themeId: "3",
  themeTitle: "Ingresso nao chegou",
  themeStatus: "open",
  title: "Ingresso nao chegou",
  reference: null,
  kinds: ["new"],
  startedAt: "2026-10-19T17:00:00.000Z",
  lastFlaggedAt: "2026-10-19T18:00:00.000Z",
  endedAt: "2026-10-19T18:30:00.000Z",
  peak: 9,
  conversations: 14,
  links: [],
  ...over,
});

let asked: URL[] = [];
function stub(episodes: unknown[], status = 200, total = episodes.length) {
  asked = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(url);
    return status === 200 ? json({ episodes, total }) : json({}, status);
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const when = (iso: string) =>
  new Date(iso).toLocaleString("en", {
    dateStyle: "short",
    timeStyle: "short",
  });

test("lists the period's episodes: the title then, the span or still flagged, conversations, peak and the theme now", async () => {
  stub([
    episode({
      id: "2",
      title: "Troca de data",
      themeTitle: "Remarcar ingresso",
      endedAt: null,
      kinds: ["new", "concentrated"],
      reference: "Show X",
    }),
    episode({}),
  ]);
  const opened: string[] = [];
  render(
    <OccurrenceFlagHistory
      monitorId="7"
      onOpenTheme={(id) => opened.push(id)}
    />,
  );
  await screen.findByText("Troca de data");
  const url = asked[0] as URL;
  expect(url.pathname).toBe("/api/v1/occurrences/monitors/7/flag-episodes");
  const since = new Date(url.searchParams.get("since") ?? "");
  const until = new Date(url.searchParams.get("until") ?? "");
  expect(until.getTime() - since.getTime()).toBe(86_400_000);
  const rows = screen.getAllByRole("listitem");
  expect(rows[0]?.dataset.open).toBe("true");
  expect(rows[0]?.textContent).toContain(
    `${when("2026-10-19T17:00:00.000Z")}, still flagged`,
  );
  expect(rows[0]?.textContent).toContain("Now part of “Remarcar ingresso”");
  expect(rows[0]?.textContent).toContain("Reference: Show X");
  expect(rows[1]?.textContent).toContain(
    `${when("2026-10-19T17:00:00.000Z")} to ${when("2026-10-19T18:30:00.000Z")}`,
  );
  expect(rows[1]?.textContent).toContain("14 conversations");
  expect(rows[1]?.textContent).toContain("peak of 9 in the window");
  expect(rows[1]?.textContent).not.toContain("Now part of");
  const openButtons = screen.getAllByRole("button", { name: "Open the theme" });
  fireEvent.click(openButtons[0] as HTMLElement);
  expect(opened).toEqual(["3"]);
});

test("a split theme's episode offers no theme to open, and an empty period says so", async () => {
  stub([episode({ themeStatus: "split" })]);
  render(<OccurrenceFlagHistory monitorId="7" onOpenTheme={() => {}} />);
  await screen.findByText("Ingresso nao chegou");
  expect(screen.queryByRole("button", { name: "Open the theme" })).toBeNull();
  cleanup();
  stub([]);
  render(<OccurrenceFlagHistory monitorId="7" />);
  await screen.findByText("No theme was flagged during this period.");
});

test("yesterday asks for the whole local day before, and a custom period asks for what was typed, its end after its start", async () => {
  stub([]);
  render(<OccurrenceFlagHistory monitorId="7" />);
  await waitFor(() => expect(asked).toHaveLength(1));
  fireEvent.change(screen.getByLabelText("Period"), {
    target: { value: "yesterday" },
  });
  await waitFor(() => expect(asked).toHaveLength(2));
  const y = asked[1] as URL;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  expect(new Date(y.searchParams.get("until") ?? "").getTime()).toBe(
    midnight.getTime(),
  );
  fireEvent.change(screen.getByLabelText("Period"), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText("From"), {
    target: { value: "2026-10-18T17:00" },
  });
  fireEvent.change(screen.getByLabelText("To"), {
    target: { value: "2026-10-18T19:00" },
  });
  await waitFor(() =>
    expect(asked.at(-1)?.searchParams.get("until")).toBe(
      new Date("2026-10-18T19:00").toISOString(),
    ),
  );
  expect(asked.at(-1)?.searchParams.get("since")).toBe(
    new Date("2026-10-18T17:00").toISOString(),
  );
  const count = asked.length;
  fireEvent.change(screen.getByLabelText("To"), {
    target: { value: "2026-10-18T16:00" },
  });
  expect(
    await screen.findByText("The end has to come after the start."),
  ).toBeTruthy();
  expect(asked).toHaveLength(count);
});

test("a read that fails says so", async () => {
  stub([], 500);
  render(<OccurrenceFlagHistory monitorId="7" />);
  await screen.findByText("Could not read the flagged themes.");
});

test("an answer for a period changed since never replaces the latest one", async () => {
  const releases: Array<() => void> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const n = releases.length;
    const title = n === 0 ? "Do periodo antigo" : "Do periodo novo";
    return new Promise<Response>((resolve) => {
      releases.push(() =>
        resolve(
          json({ episodes: [episode({ id: String(n), title })], total: 1 }),
        ),
      );
      void url;
    });
  }) as typeof fetch;
  render(<OccurrenceFlagHistory monitorId="7" />);
  await waitFor(() => expect(releases).toHaveLength(1));
  fireEvent.change(screen.getByLabelText("Period"), {
    target: { value: "7d" },
  });
  await waitFor(() => expect(releases).toHaveLength(2));
  releases[1]?.();
  await screen.findByText("Do periodo novo");
  releases[0]?.();
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText("Do periodo antigo")).toBeNull();
  expect(screen.getByText("Do periodo novo")).toBeTruthy();
});

test("a period with more episodes than the list shows says how many it leaves out", async () => {
  stub([episode({})], 200, 340);
  render(<OccurrenceFlagHistory monitorId="7" />);
  expect(
    (await screen.findByText(/The newest 1 of 340 times/)).textContent,
  ).toContain("Pick a shorter period");
  expect(asked[0]?.searchParams.get("limit")).toBe("200");
  cleanup();
  stub([episode({})]);
  render(<OccurrenceFlagHistory monitorId="7" />);
  await screen.findByText("Ingresso nao chegou");
  expect(screen.queryByText(/The newest/)).toBeNull();
});
