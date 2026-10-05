import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

// The probe is the read-only Portainer inventory of the agents-onboarding skill. It is run against a fake
// Portainer API serving one Chatwoot stack, with or without a WhatsApp sidecar next to it.
const PROBE = join(
  import.meta.dir,
  "../../.claude/skills/agents-onboarding/scripts/portainer-brownfield.py",
);
const CHATWOOT = "ghcr.io/fazer-ai/chatwoot:v4.18.0-fazer-ai.124";

function container(name: string, image: string) {
  return {
    Names: [`/cw-${name}-1`],
    Image: image,
    State: "running",
    Status: "Up 2 hours (healthy)",
    Labels: { "com.docker.compose.project": "cw" },
    Ports: [],
  };
}

// node:http rather than Bun.serve: the DOM preload replaces the global Response with happy-dom's.
let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function probe(sidecar?: { name: string; image: string }) {
  const containers = [
    container("chatwoot", CHATWOOT),
    container("sidekiq", CHATWOOT),
    container("postgres", "pgvector/pgvector:pg16"),
    container("redis", "redis:alpine"),
  ];
  if (sidecar) containers.push(container(sidecar.name, sidecar.image));
  const routes: Record<string, unknown> = {
    "/api/stacks": [{ Id: 1, Name: "cw", Status: 1, Type: 2 }],
    "/api/endpoints/1/docker/containers/json": containers,
  };
  server = createServer((req, res) => {
    const body = routes[new URL(req.url ?? "/", "http://x").pathname];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const proc = Bun.spawn(["python3", PROBE], {
    env: {
      ...process.env,
      PORTAINER_URL: `http://127.0.0.1:${port}`,
      PORTAINER_API_KEY: "test",
      PORTAINER_ENDPOINT_ID: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await Bun.readableStreamToText(proc.stdout);
  expect(await proc.exited).toBe(0);
  return out;
}

describe("portainer-brownfield probe", () => {
  test("a Chatwoot stack alone is reused and nothing mentions Baileys", async () => {
    const out = await probe();
    expect(out).toMatch(/chatwoot\s+PRESENT\(oss\)\+healthy -> REUSE/);
    expect(out.toLowerCase()).not.toContain("baileys");
  });

  test("an existing baileys-api is kept as legacy, never removed", async () => {
    const out = await probe({
      name: "baileys-api",
      image: "ghcr.io/fazer-ai/baileys-api:latest",
    });
    expect(out).toMatch(/chatwoot\s+PRESENT\(oss\)\+healthy -> REUSE/);
    expect(out).toMatch(/baileys\s+PRESENT -> KEEP \(legacy\)/);
  });

  test("a separate whatsapp-connector is recognised and the upgrade warning names the switch", async () => {
    const out = await probe({
      name: "whatsapp-connector",
      image: "ghcr.io/fazer-ai/whatsapp-connector:0.6.0",
    });
    expect(out).toMatch(/^\s+whatsapp-connector\s+proj=cw/m);
    expect(out).toContain("PRESENT (separate) -> KEEP");
    expect(out).toContain("WHATSAPP_CONNECTOR_EMBEDDED=false");
  });
});
