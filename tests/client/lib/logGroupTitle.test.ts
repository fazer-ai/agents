import { describe, expect, test } from "bun:test";
import { type LogGroupTitle, logGroupTitle } from "@/client/lib/logGroupTitle";

// The Logs page groups by `turnId`, which is a correlation id and not a claim that a turn happened,
// so a group with neither a conversation nor a thread must not fall through to the word "Turn".
// Every row here is one line of the decision, so a change to the ordering of the four answers shows
// up as a named case rather than as a rendering difference.

interface Row {
  name: string;
  conversationId: string | null;
  threadId: string | null;
  stages: string[];
  expected: LogGroupTitle;
}

const TABLE: Row[] = [
  {
    name: "a conversation wins over everything else it carries",
    conversationId: "12",
    threadId: "1:playground:1:ab",
    stages: ["generate", "tool"],
    expected: { kind: "conversation", conversationId: "12" },
  },
  {
    name: "no conversation, a thread: the thread names it",
    conversationId: null,
    threadId: "1:playground:1:ab",
    stages: ["generate", "tool"],
    expected: { kind: "thread", threadId: "1:playground:1:ab" },
  },
  {
    name: "a dead outbound delivery is named by its stage",
    conversationId: null,
    threadId: null,
    stages: ["webhook"],
    expected: { kind: "stage", stage: "webhook" },
  },
  {
    name: "repeats of one stage are still that stage",
    conversationId: null,
    threadId: null,
    stages: ["webhook", "webhook"],
    expected: { kind: "stage", stage: "webhook" },
  },
  {
    name: "a turn step with neither is named by the step, not by 'Turn'",
    conversationId: null,
    threadId: null,
    stages: ["generate"],
    expected: { kind: "stage", stage: "generate" },
  },
  {
    name: "mixed stages with neither: 'Turn', the one place it is true",
    conversationId: null,
    threadId: null,
    stages: ["generate", "tool"],
    expected: { kind: "turn" },
  },
  {
    name: "an empty conversation id is absent, not a name",
    conversationId: "",
    threadId: null,
    stages: ["webhook"],
    expected: { kind: "stage", stage: "webhook" },
  },
  {
    name: "an empty thread id is absent too",
    conversationId: null,
    threadId: "",
    stages: ["generate"],
    expected: { kind: "stage", stage: "generate" },
  },
];

describe("what a Logs group is called", () => {
  for (const r of TABLE) {
    test(r.name, () => {
      expect(
        logGroupTitle({
          conversationId: r.conversationId,
          threadId: r.threadId,
          rows: r.stages.map((stage) => ({ stage })),
        }),
      ).toEqual(r.expected);
    });
  }
});
