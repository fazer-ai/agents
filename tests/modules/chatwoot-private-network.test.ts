import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import config from "@/config";
import {
  attachmentFetchTarget,
  chatwootLinkBase,
  createChatwootClient,
  fetchChatwootProfile,
} from "@/modules/chatwoot/client";
import {
  assertDeploymentConnectable,
  chatwootDeploymentUpdateSchema,
  isCleanHttpBase,
} from "@/modules/chatwoot/management";
import { fillContextOf } from "@/modules/observe/job";

// A Chatwoot reached on a private address (same VPC, same Docker network) is a declared
// SSRF_INTERNAL_TARGETS entry, not a reason to turn the guard off. These run the REAL guard (no
// `assertSafe` stub): the point is which URLs it lets through with the declared list in config.

const saved = {
  allowPrivateTargets: config.ssrf.allowPrivateTargets,
  internalTargets: config.ssrf.internalTargets,
};
beforeEach(() => {
  config.ssrf.allowPrivateTargets = false;
  config.ssrf.internalTargets = [{ host: "10.0.0.5", port: 3000 }];
});
afterEach(() => {
  config.ssrf.allowPrivateTargets = saved.allowPrivateTargets;
  config.ssrf.internalTargets = saved.internalTargets;
});

const clientConfig = (baseUrl: string) => ({
  baseUrl,
  accountId: 1,
  adminToken: "ADMIN_TOK",
  botToken: "BOT_TOK",
});

type Call = { url: string; headers: Record<string, string> };
function recordingFetch(calls: Call[], body = "{}", status = 200) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

describe("Chatwoot base URL on a declared internal target", () => {
  test("createChatwootClient accepts the declared host:port over http", async () => {
    const client = await createChatwootClient(
      clientConfig("http://10.0.0.5:3000"),
    );
    expect(client).toBeDefined();
  });

  test("createChatwootClient refuses another private host", async () => {
    await expect(
      createChatwootClient(clientConfig("http://10.0.0.7:3000")),
    ).rejects.toThrow();
  });

  test("createChatwootClient refuses the declared host on another port", async () => {
    await expect(
      createChatwootClient(clientConfig("http://10.0.0.5:3001")),
    ).rejects.toThrow(/3000/);
  });

  test("createChatwootClient refuses it when the list is empty (no dependence on the instance-wide flag)", async () => {
    config.ssrf.internalTargets = [];
    await expect(
      createChatwootClient(clientConfig("http://10.0.0.5:3000")),
    ).rejects.toThrow();
  });

  test("fetchChatwootProfile reaches the declared base and refuses an undeclared one", async () => {
    const calls: Call[] = [];
    await fetchChatwootProfile(
      { baseUrl: "http://10.0.0.5:3000", token: "T" },
      { fetchImpl: recordingFetch(calls, '{"accounts":[]}') },
    );
    expect(calls.map((c) => c.url)).toEqual([
      "http://10.0.0.5:3000/api/v1/profile",
    ]);
    await expect(
      fetchChatwootProfile(
        { baseUrl: "http://10.0.0.8:3000", token: "T" },
        { fetchImpl: recordingFetch(calls) },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("connecting the deployment on a private base", () => {
  test("the connect check accepts the declared base and refuses an undeclared one", async () => {
    const ok = await assertDeploymentConnectable({
      baseUrl: "http://10.0.0.5:3000/",
      adminToken: "T",
    });
    expect(ok.baseUrl).toBe("http://10.0.0.5:3000");
    await expect(
      assertDeploymentConnectable({
        baseUrl: "http://10.0.0.7:3000",
        adminToken: "T",
      }),
    ).rejects.toThrow();
  });
});

describe("attachmentFetchTarget", () => {
  const targets = [{ host: "10.0.0.5", port: 3000 }];
  const PUBLIC =
    "https://chat.example.com/rails/active_storage/blobs/redirect/abc/audio.ogg?disposition=inline";

  test("a data_url on the public host is fetched from the private base, path and query kept", () => {
    expect(
      attachmentFetchTarget(PUBLIC, "http://10.0.0.5:3000", targets),
    ).toEqual({
      url: "http://10.0.0.5:3000/rails/active_storage/blobs/redirect/abc/audio.ogg?disposition=inline",
      sameInstance: true,
    });
  });

  test("a data_url already on the base host is kept as written", () => {
    const u = "http://10.0.0.5:3000/rails/active_storage/blobs/x/a.ogg";
    expect(attachmentFetchTarget(u, "http://10.0.0.5:3000", targets)).toEqual({
      url: u,
      sameInstance: true,
    });
  });

  test("a path outside Active Storage on another host stays put, without the token", () => {
    const u = "https://cdn.example.com/files/a.ogg";
    expect(attachmentFetchTarget(u, "http://10.0.0.5:3000", targets)).toEqual({
      url: u,
      sameInstance: false,
    });
  });

  test("a base that is not a declared internal target never rewrites", () => {
    expect(
      attachmentFetchTarget(PUBLIC, "https://chat.other.example", targets),
    ).toEqual({ url: PUBLIC, sameInstance: false });
    expect(attachmentFetchTarget(PUBLIC, "http://10.0.0.5:3000", [])).toEqual({
      url: PUBLIC,
      sameInstance: false,
    });
  });

  test("same host on another scheme still goes through the declared base", () => {
    const declared = [{ host: "chat.example.com", port: 80 }];
    expect(
      attachmentFetchTarget(
        "https://chat.example.com/rails/active_storage/blobs/x/a.ogg?d=1",
        "http://chat.example.com",
        declared,
      ),
    ).toEqual({
      url: "http://chat.example.com/rails/active_storage/blobs/x/a.ogg?d=1",
      sameInstance: true,
    });
  });

  test("a data_url carrying credentials is not rewritten", () => {
    const u =
      "https://user:pw@chat.example.com/rails/active_storage/blobs/x/a.ogg";
    expect(attachmentFetchTarget(u, "http://10.0.0.5:3000", targets)).toEqual({
      url: u,
      sameInstance: false,
    });
  });
});

describe("downloadAttachment through the private base", () => {
  test("fetches the public data_url from the base, with the admin token", async () => {
    const calls: Call[] = [];
    const client = await createChatwootClient(
      clientConfig("http://10.0.0.5:3000"),
      { fetchImpl: recordingFetch(calls, "OGG") },
    );
    const out = await client.downloadAttachment(
      "https://chat.example.com/rails/active_storage/blobs/redirect/abc/audio.ogg",
    );
    expect(new TextDecoder().decode(out.bytes)).toBe("OGG");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://10.0.0.5:3000/rails/active_storage/blobs/redirect/abc/audio.ogg",
    );
    expect(calls[0]?.headers["api-access-token"]).toBe("ADMIN_TOK");
  });

  test("another host keeps the full guard and never gets the token", async () => {
    const calls: Call[] = [];
    const client = await createChatwootClient(
      clientConfig("http://10.0.0.5:3000"),
      { fetchImpl: recordingFetch(calls, "X") },
    );
    await client.downloadAttachment("https://203.0.113.10/files/a.ogg");
    expect(calls[0]?.url).toBe("https://203.0.113.10/files/a.ogg");
    expect(calls[0]?.headers["api-access-token"]).toBeUndefined();
    // A private host that is not the base is refused even when the list declares it.
    config.ssrf.internalTargets = [
      { host: "10.0.0.5", port: 3000 },
      { host: "10.0.0.9", port: 3000 },
    ];
    await expect(
      client.downloadAttachment("http://10.0.0.9:3000/files/a.ogg"),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("isInstanceUrl follows the attachment rule", () => {
  test("a public Active Storage URL is the instance's own file only behind a declared base", async () => {
    const priv = await createChatwootClient(
      clientConfig("http://10.0.0.5:3000"),
    );
    expect(
      priv.isInstanceUrl(
        "https://chat.example.com/rails/active_storage/blobs/x/a.ogg",
      ),
    ).toBe(true);
    expect(priv.isInstanceUrl("https://chat.example.com/files/a.ogg")).toBe(
      false,
    );
    config.ssrf.internalTargets = [];
    expect(
      priv.isInstanceUrl(
        "https://chat.example.com/rails/active_storage/blobs/x/a.ogg",
      ),
    ).toBe(false);
  });
});

describe("the connection's two optional addresses", () => {
  test("absent is kept, empty or null clears, a value is stored canonical", () => {
    const parse = (v: unknown) =>
      chatwootDeploymentUpdateSchema.parse({ webhookBaseUrl: v })
        .webhookBaseUrl;
    expect(parse(undefined)).toBeUndefined();
    expect(parse(null)).toBeNull();
    expect(parse("  ")).toBeNull();
    expect(parse("http://10.0.0.6:3000/")).toBe("http://10.0.0.6:3000");
  });

  test("refuses what would misplace the webhook mount or carry credentials", () => {
    for (const bad of [
      "10.0.0.6:3000",
      "ftp://10.0.0.6",
      "http://10.0.0.6:3000/?a=1",
      "http://u:p@10.0.0.6:3000",
      "http://10.0.0.6:3000/#x",
      "http://10.0.0.6:3000/?",
      "http://10.0.0.6:3000/#",
    ]) {
      expect(isCleanHttpBase(bad)).toBe(false);
      expect(() =>
        chatwootDeploymentUpdateSchema.parse({ publicUrl: bad }),
      ).toThrow();
    }
  });

  test("links follow the public address, and the write key follows neither", async () => {
    expect(
      chatwootLinkBase({
        baseUrl: "http://10.0.0.5:3000",
        publicUrl: "https://desk.example.com/",
      }),
    ).toBe("https://desk.example.com");
    expect(chatwootLinkBase({ baseUrl: "http://10.0.0.5:3000/" })).toBe(
      "http://10.0.0.5:3000",
    );
    const client = await createChatwootClient({
      ...clientConfig("http://10.0.0.5:3000"),
      publicUrl: "https://desk.example.com",
    });
    expect(client.conversationLink(7)).toBe(
      "https://desk.example.com/app/accounts/1/conversations/7",
    );
    // The write key is not the link, and with an identity it does not follow the base URL either.
    expect(client.conversationKey(7)).toBe(
      "http://10.0.0.5:3000/accounts/1/conversations/7",
    );
    config.ssrf.internalTargets = [
      { host: "10.0.0.5", port: 3000 },
      { host: "10.0.0.9", port: 3000 },
    ];
    const moved = await createChatwootClient({
      ...clientConfig("http://10.0.0.9:3000"),
      identity: "chatwoot-deployment:4",
    });
    const before = await createChatwootClient({
      ...clientConfig("http://10.0.0.5:3000"),
      identity: "chatwoot-deployment:4",
    });
    expect(moved.conversationKey(7)).toBe(before.conversationKey(7));
  });
});

describe("the observer's conversation link", () => {
  test("a decision rule gets the link people follow, not the private base", () => {
    const ctx = fillContextOf({ inbox_id: "3" }, null, 42, {
      conversationLink: (id: number) =>
        `https://desk.example.com/app/accounts/1/conversations/${id}`,
    });
    expect(ctx.conversation.link).toBe(
      "https://desk.example.com/app/accounts/1/conversations/42",
    );
  });
});
