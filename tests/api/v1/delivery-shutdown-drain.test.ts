import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chatwootController } from "@/api/v1/chatwoot.controller";
import { integrationsController } from "@/api/v1/integrations.controller";
import {
  drainInFlight,
  inFlightWork,
  resetShutdownForTest,
} from "@/lib/shutdown";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import * as chatwootWebhook from "@/modules/chatwoot/webhook";
import * as inbound from "@/modules/webhooks/inbound/service";

// The two webhook receivers ack first and process detached, and a direct turn runs inside that
// detached half. Each detached delivery is registered with the shutdown drain, so SIGTERM waits for it
// like it waits for a claimed job. The receivers' own parsing and the delivery itself are stubbed:
// what is under test is that the controller hands the drain the work it starts.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const restore: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of restore.splice(0)) spy.mockRestore();
  resetShutdownForTest();
});

// A delivery that runs until released, and records whether it got to finish.
function heldDelivery() {
  let release: () => void = () => {};
  const state = { finished: false };
  const run = () =>
    new Promise<void>((r) => {
      release = r;
    }).then(() => {
      state.finished = true;
    });
  return { run, release: () => release(), state };
}

describe("a detached webhook delivery is waited for by the shutdown drain", () => {
  test("Chatwoot", async () => {
    const held = heldDelivery();
    restore.push(
      spyOn(chatwootWebhook, "receiveChatwootWebhook").mockResolvedValue({
        ack: true,
        outcome: "queued",
        tenantId: 1n,
        instanceId: 1n,
        deliveryId: "drain-1",
        agentBotId: null,
        normalized: {} as NormalizedChatwootEvent,
      }),
      spyOn(
        chatwootWebhook,
        "recordAndProcessChatwootDelivery",
      ).mockImplementation(async () => {
        await held.run();
        return "processed";
      }),
    );
    const res = await chatwootController.handle(
      new Request("http://localhost/v1/chatwoot/webhook/tok", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(inFlightWork().byKind).toEqual({ chatwoot_delivery: 1 });
    const drained = drainInFlight({ boundMs: 5_000 });
    await sleep(200);
    held.release();
    expect((await drained).drained).toBe(true);
    expect(held.state.finished).toBe(true);
  });

  test("generic inbound", async () => {
    const held = heldDelivery();
    restore.push(
      spyOn(inbound, "receiveInbound").mockResolvedValue({
        ack: true,
        outcome: "queued",
        tenantId: 1n,
        deliveryId: 1n,
      } as Awaited<ReturnType<typeof inbound.receiveInbound>>),
      spyOn(inbound, "processInboundDelivery").mockImplementation(async () => {
        await held.run();
        return undefined as unknown as Awaited<
          ReturnType<typeof inbound.processInboundDelivery>
        >;
      }),
    );
    const res = await integrationsController.handle(
      new Request("http://localhost/v1/integrations/inbound/tok", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(inFlightWork().byKind).toEqual({ inbound_delivery: 1 });
    const drained = drainInFlight({ boundMs: 5_000 });
    await sleep(200);
    held.release();
    expect((await drained).drained).toBe(true);
    expect(held.state.finished).toBe(true);
  });
});
