import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chatwootController } from "@/api/v1/chatwoot.controller";
import { integrationsController } from "@/api/v1/integrations.controller";
import {
  drainInFlight,
  inFlightWork,
  resetShutdownForTest,
} from "@/lib/shutdown";
import * as deliveryQueue from "@/modules/chatwoot/delivery-queue";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import * as chatwootWebhook from "@/modules/chatwoot/webhook";
import * as inbound from "@/modules/webhooks/inbound/service";

// The two webhook receivers ack first and process detached (the Chatwoot one behind its admission
// queue, ./delivery-queue.ts), and a direct turn runs inside that detached half. Each detached delivery is registered with the shutdown drain, so SIGTERM waits for it
// like it waits for a claimed job. The receivers' own parsing and the delivery itself are stubbed:
// what is under test is that the controller hands the drain the work it starts.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const restore: Array<{ mockRestore: () => void }> = [];

// The registry is process-wide: a suite that claimed rows without running them leaves them held.
beforeEach(() => {
  resetShutdownForTest();
});

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
        deliveryRowId: 1n,
        dispatch: true,
        agentBotId: null,
        normalized: {} as NormalizedChatwootEvent,
      }),
      spyOn(
        chatwootWebhook,
        "processRecordedChatwootDelivery",
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

  // A redelivery of a row already past PENDING is acked and starts nothing: processing it again would
  // spend a slot on a CAS that cannot win.
  test("Chatwoot: a delivery that no longer owes its attempt starts nothing", async () => {
    let ran = false;
    restore.push(
      spyOn(chatwootWebhook, "receiveChatwootWebhook").mockResolvedValue({
        ack: true,
        outcome: "queued",
        tenantId: 1n,
        instanceId: 1n,
        deliveryId: "drain-settled",
        deliveryRowId: 2n,
        dispatch: false,
        agentBotId: null,
        normalized: {} as NormalizedChatwootEvent,
      }),
      spyOn(
        chatwootWebhook,
        "processRecordedChatwootDelivery",
      ).mockImplementation(async () => {
        ran = true;
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
    await sleep(20);
    expect(ran).toBe(false);
    expect(inFlightWork().byKind).toEqual({});
  });

  // A status or assignment change is how a takeover reaches a running turn, so it is admitted in the
  // lane that customer messages (and their turns) do not occupy.
  test("Chatwoot: an event that is not a customer message goes in the other lane", async () => {
    const lanes: unknown[] = [];
    restore.push(
      spyOn(chatwootWebhook, "receiveChatwootWebhook").mockResolvedValue({
        ack: true,
        outcome: "queued",
        tenantId: 1n,
        instanceId: 1n,
        deliveryId: "drain-meta",
        deliveryRowId: 3n,
        dispatch: true,
        agentBotId: null,
        normalized: {
          event: "conversation_status_changed",
        } as NormalizedChatwootEvent,
      }),
      spyOn(deliveryQueue, "admitChatwootDelivery").mockImplementation(
        (_id, _run, lane) => {
          lanes.push(lane);
          return true;
        },
      ),
    );
    const res = await chatwootController.handle(
      new Request("http://localhost/v1/chatwoot/webhook/tok", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(lanes).toEqual(["meta"]);
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
