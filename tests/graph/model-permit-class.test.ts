import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import config from "@/config";
import {
  modelPermitReading,
  type PermitWaitInfo,
  runModelCall,
} from "@/graph/model-limit";
import { summarizeAttendance } from "@/modules/memory/summarize";

// Which class each caller queues in on the process-wide model semaphore. Read from the semaphore
// itself while the call holds its permit, or while it waits for one: a summary nobody waits on is
// background, a call that names no class is a reply.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A model whose call records how many background permits were held while it ran.
class ReadingModel extends BaseChatModel {
  heldBackground: number[] = [];
  constructor() {
    super({});
  }
  _llmType() {
    return "reading";
  }
  async _generate(): Promise<ChatResult> {
    this.heldBackground.push(modelPermitReading().heldBackground);
    return {
      generations: [{ text: "resumo", message: new AIMessage("resumo") }],
    };
  }
}

const held: Array<() => void> = [];
afterEach(async () => {
  for (const release of held.splice(0)) release();
  await sleep(0);
});

async function holdEveryPermit(): Promise<void> {
  const { permits } = modelPermitReading();
  let started = 0;
  for (let i = 0; i < permits; i++) {
    void runModelCall(
      () =>
        new Promise<void>((resolve) => {
          started++;
          held.push(resolve);
        }),
    );
  }
  while (started < permits) await sleep(1);
}

describe("the class a model call queues in", () => {
  test("a memory summary runs as background, a bare call as a reply", async () => {
    const model = new ReadingModel();
    const out = await summarizeAttendance(model, [new HumanMessage("oi")]);
    expect(out.summary).toBe("resumo");
    await runModelCall(async () => {
      model.heldBackground.push(modelPermitReading().heldBackground);
    });
    expect(model.heldBackground).toEqual([1, 0]);
  });

  describe("a background call that waits", () => {
    let saved: number;
    beforeEach(() => {
      saved = config.agent.capacityWaitAlertMs;
      config.agent.capacityWaitAlertMs = 100;
    });
    afterEach(() => {
      config.agent.capacityWaitAlertMs = saved;
    });

    test("is counted in the background queue and reported as background", async () => {
      await holdEveryPermit();
      const seen: PermitWaitInfo[] = [];
      const summary = summarizeAttendance(
        new ReadingModel(),
        [new HumanMessage("oi")],
        undefined,
        null,
        {
          primary: { provider: "openai", model: "gpt-test" },
          onPermitWait: (info) => seen.push(info),
        },
      );
      await sleep(20);
      expect(modelPermitReading()).toMatchObject({
        waitingReply: 0,
        waitingBackground: 1,
      });
      await sleep(150);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.occupancy).toMatchObject({
        limit: "AGENT_MODEL_CONCURRENCY",
        class: "background",
        modelWaitingBackground: 1,
        modelWaitingReply: 0,
      });
      for (const release of held.splice(0)) release();
      expect((await summary).summary).toBe("resumo");
    });
  });
});
