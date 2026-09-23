import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { sendsConversationRef } from "@/client/pages/resources/ToolEditModal";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";
import { unusedCredentialWarning } from "@/modules/tool-definitions/credential-wiring";
import { runToolTest } from "@/modules/tool-definitions/test-run";

// (#818) `{{conversation_ref}}`: the handle an HTTP tool gives the operator's own system so it can
// send an event back to THIS conversation later. Minted only for a tool that renders it, before the
// request leaves, and never sent empty.

const PUBLIC = "8.8.8.8";

function def(over: Partial<HttpToolDef> = {}): HttpToolDef {
  return {
    name: "schedule_report",
    method: "POST",
    urlTemplate: `https://${PUBLIC}/v1/jobs`,
    allowedHosts: [PUBLIC],
    headers: {},
    inputSchema: {},
    credentialRef: null,
    body: {
      mode: "kv",
      rows: [{ key: "ref", value: "{{conversation_ref}}" }],
    },
    conversationRefIntegrationId: 41n,
    ...over,
  };
}

function harness(
  over: Partial<HttpToolDef>,
  mint?: (
    id: bigint,
  ) => Promise<
    | { ok: true; ref: string }
    | { ok: false; reason: "instance_missing" | "instance_not_generic" }
  >,
) {
  const sent: Array<{ url: string; body: string | null; headers: Headers }> =
    [];
  const minted: bigint[] = [];
  const noEffect: string[] = [];
  // What the receiver would see at the moment it gets the request: whether the ref already
  // correlates. The mint closure flips it, so a request that went out first reads `false`.
  let refExists = false;
  const seenAtSend: boolean[] = [];
  const tool = buildHttpTool(def(over), {
    resolveCredential: async () => null,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      seenAtSend.push(refExists);
      sent.push({
        url: String(url),
        body: init?.body ? String(init.body) : null,
        headers: new Headers(init?.headers),
      });
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
    context: { conversation_id: "900" },
    onNoEffect: (name) => noEffect.push(name),
    ...(mint
      ? {
          conversationRef: async (id: bigint) => {
            minted.push(id);
            const r = await mint(id);
            if (r.ok) refExists = true;
            return r;
          },
        }
      : {}),
  });
  return { tool, sent, minted, noEffect, seenAtSend };
}

describe("an HTTP tool that renders {{conversation_ref}}", () => {
  test("mints the ref for its named instance and sends it, the ref existing before the request leaves", async () => {
    const h = harness({}, async () => ({ ok: true, ref: "cr_abc" }));
    await h.tool.invoke({});
    expect(h.minted).toEqual([41n]);
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.sent[0]?.body ?? "{}")).toEqual({ ref: "cr_abc" });
    expect(h.seenAtSend).toEqual([true]);
  });

  test("renders it in the URL, a header and the query as well", async () => {
    const h = harness(
      {
        urlTemplate: `https://${PUBLIC}/v1/jobs/{{conversation_ref}}`,
        headers: { "x-ref": "{{conversation_ref}}" },
        query: { ref: "{{conversation_ref}}" },
        body: { mode: "kv", rows: [] },
      },
      async () => ({ ok: true, ref: "cr_xyz" }),
    );
    await h.tool.invoke({});
    const req = h.sent[0];
    expect(req?.url).toBe(`https://${PUBLIC}/v1/jobs/cr_xyz?ref=cr_xyz`);
    expect(req?.headers.get("x-ref")).toBe("cr_xyz");
  });

  test("a tool that names no instance refuses and sends nothing", async () => {
    const h = harness({ conversationRefIntegrationId: null }, async () => ({
      ok: true,
      ref: "cr_abc",
    }));
    const out = (await h.tool.invoke({})) as unknown as string;
    expect(out).toContain("Could not call the tool");
    expect(h.sent).toHaveLength(0);
    expect(h.minted).toEqual([]);
    expect(h.noEffect).toEqual(["schedule_report"]);
  });

  test("where there is no conversation to hand (no mint closure), it refuses and sends nothing", async () => {
    const h = harness({});
    const out = (await h.tool.invoke({})) as unknown as string;
    expect(out).toContain("no conversation here");
    expect(h.sent).toHaveLength(0);
    expect(h.noEffect).toEqual(["schedule_report"]);
  });

  test("an instance that is gone or not GENERIC refuses and sends nothing", async () => {
    for (const reason of [
      "instance_missing",
      "instance_not_generic",
    ] as const) {
      const h = harness({}, async () => ({ ok: false, reason }));
      const out = (await h.tool.invoke({})) as unknown as string;
      expect(out).toContain("Could not call the tool");
      expect(h.sent).toHaveLength(0);
    }
  });

  test("the ref is minted before the acknowledgement goes out, so a refusal sends no ack either", async () => {
    const acks: string[] = [];
    const tool = buildHttpTool(def({ ackMessage: "Um instante." }), {
      resolveCredential: async () => null,
      fetchImpl: (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch,
      emitAck: async (m) => {
        acks.push(m);
        return true;
      },
    });
    const out = (await tool.invoke({
      __wait_message: "Já vejo isso.",
    })) as unknown as string;
    expect(out).toContain("Could not call the tool");
    expect(acks).toEqual([]);
  });
});

describe("an HTTP tool that does not render {{conversation_ref}}", () => {
  test("never mints, even when it names an instance", async () => {
    const h = harness(
      {
        body: {
          mode: "kv",
          rows: [{ key: "c", value: "{{conversation_id}}" }],
        },
      },
      async () => ({ ok: true, ref: "cr_abc" }),
    );
    await h.tool.invoke({});
    expect(h.minted).toEqual([]);
    expect(JSON.parse(h.sent[0]?.body ?? "{}")).toEqual({ c: "900" });
  });
});

describe("the readers around the tool that know {{conversation_ref}}", () => {
  test("the editor's test run refuses it in so many words, and nothing goes out", async () => {
    let called = false;
    const run = runToolTest(
      { tenantId: 1n, userId: null, role: "TENANT_ADMIN" },
      {
        definition: {
          method: "POST",
          urlTemplate: `https://${PUBLIC}/v1/jobs`,
          allowedHosts: [PUBLIC],
          headers: { "x-ref": "{{conversation_ref}}" },
        },
      },
      {} as PrismaClient,
      {
        fetchImpl: (async () => {
          called = true;
          return new Response("{}");
        }) as unknown as typeof fetch,
      },
    );
    await expect(run).rejects.toMatchObject({ statusCode: 400 });
    await expect(run).rejects.toThrow("only exists inside a conversation");
    expect(called).toBe(false);
  });

  test("a URL that carries it still builds a request, so an unwired credential is still reported", () => {
    const warning = unusedCredentialWarning(
      { kind: "generic", paramName: null, baseUrl: null },
      "POST",
      {
        urlTemplate: `https://${PUBLIC}/v1/jobs/{{conversation_ref}}`,
        headers: {},
        inputSchema: {},
      },
    );
    expect(warning).not.toBeNull();
  });

  test("the editor asks for the integration exactly where the save requires one", () => {
    const at = (over: Record<string, unknown>) =>
      sendsConversationRef({
        urlTemplate: `https://${PUBLIC}/v1/jobs`,
        headers: {},
        query: {},
        body: { mode: "kv", rows: [] },
        inputSchema: {},
        ...over,
      });
    expect(at({})).toBe(false);
    expect(at({ query: { ref: "{{conversation_ref}}" } })).toBe(true);
    expect(
      at({ body: { mode: "raw", raw: '{"r":"{{conversation_ref}}"}' } }),
    ).toBe(true);
    // Prose for the model is not a template the runtime renders.
    expect(
      at({
        inputSchema: {
          note: { type: "string", description: "{{conversation_ref}}" },
        },
      }),
    ).toBe(false);
    expect(sendsConversationRef(null)).toBe(false);
  });
});
