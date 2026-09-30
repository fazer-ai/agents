// Boots the server and probes the routing table the way a browser would, exiting non-zero and
// naming each probe that came back wrong. The development path is its own: the HTMLBundle goes
// straight onto Bun's routes table (docs/routing.md), which no test, lint or production smoke sees.
// `SMOKE_ENV=production` (`bun smoke:prod`, after `bun run build`) boots the production server and
// adds the cache policy of the document and of hashed, verbatim and missing assets to each probe.
// `SMOKE_URL` probes a server that is already running instead of booting one.
import { spawn } from "bun";

const MODE =
  process.env.SMOKE_ENV === "production" ? "production" : "development";

const PORT = Number(
  process.env.DEV_SMOKE_PORT ?? 3000 + Math.floor(Math.random() * 2000),
);
const BOOT_TIMEOUT_MS = 30_000;

interface Probe {
  method?: "GET" | "POST";
  path: string;
  status: number;
  contentType: RegExp;
  cacheControl?: string;
}

// Each row is one thing the dev routing has to get right: the document for `/` and for a
// deep route (BrowserRouter refresh), a favicon and an /assets/ file as their real media types
// (the carve-outs derived from public/), and the API as JSON for a registered path, a missing
// path and the bare prefix (the /api carve-outs plus the GET 404 guards).
const DEV_PROBES: Probe[] = [
  { path: "/", status: 200, contentType: /^text\/html/ },
  { path: "/settings/profile", status: 200, contentType: /^text\/html/ },
  { path: "/favicon-dark.png", status: 200, contentType: /^image\/png/ },
  { path: "/assets/logo.png", status: 200, contentType: /^image\/png/ },
  { path: "/api/health", status: 200, contentType: /^application\/json/ },
  { path: "/api/nope", status: 404, contentType: /^application\/json/ },
  { path: "/api", status: 404, contentType: /^application\/json/ },
  {
    method: "POST",
    path: "/api/nope",
    status: 404,
    contentType: /^application\/json/,
  },
  // NOTE: the OAuth discovery documents live outside /api and MCP clients reject HTML for them.
  {
    path: "/.well-known/oauth-authorization-server",
    status: 200,
    contentType: /^application\/json/,
  },
  {
    path: "/.well-known/oauth-protected-resource/api/v1/mcp",
    status: 200,
    contentType: /^application\/json/,
  },
];

// Bundle names change with every build, so the real ones are read from the document the
// server actually serves. The missing names are shaped like the real ones: a hashed bundle a
// deploy removed, and a plain file under /assets/, neither of which may come back as the shell.
async function productionProbes(baseUrl: string): Promise<Probe[]> {
  const html = await (await fetch(`${baseUrl}/`)).text();
  const bundle = html.match(/src="[^"]*\/(index-[a-z0-9]+\.js)"/i)?.[1];
  const stylesheet = html.match(/href="[^"]*\/(index-[a-z0-9]+\.css)"/i)?.[1];
  if (!bundle || !stylesheet) {
    throw new Error(
      "could not find the hashed bundle and stylesheet in the served document",
    );
  }
  const immutable = "public, max-age=31536000, immutable";
  const missing = {
    status: 404,
    contentType: /^text\/plain/,
    cacheControl: "no-store",
  };
  return [
    {
      path: "/",
      status: 200,
      contentType: /^text\/html/,
      cacheControl: "no-cache",
    },
    {
      path: "/settings/profile",
      status: 200,
      contentType: /^text\/html/,
      cacheControl: "no-cache",
    },
    {
      path: `/${bundle}`,
      status: 200,
      contentType: /javascript/,
      cacheControl: immutable,
    },
    {
      path: `/${stylesheet}`,
      status: 200,
      contentType: /^text\/css/,
      cacheControl: immutable,
    },
    {
      path: "/assets/logo.png",
      status: 200,
      contentType: /^image\/png/,
      cacheControl: "public, max-age=86400",
    },
    // NOTE: copied verbatim from public/assets, so it can change under the same name; its
    // `-variable` suffix is shaped like a build hash and once got it cached as immutable.
    {
      path: "/assets/fonts/inter-variable.woff2",
      status: 200,
      contentType: /font\/woff2/,
      cacheControl: "public, max-age=86400",
    },
    { path: "/index-deadbeef1234.js", ...missing },
    { path: "/assets/does-not-exist.png", ...missing },
    { path: "/api/health", status: 200, contentType: /^application\/json/ },
    { path: "/api/nope", status: 404, contentType: /^application\/json/ },
    {
      path: "/.well-known/oauth-protected-resource/api/v1/mcp",
      status: 200,
      contentType: /^application\/json/,
    },
  ];
}

async function bootServer(): Promise<{
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const server = spawn({
    cmd: ["bun", "src/index.ts"],
    env: {
      // NOTE: placeholders only, so the production boot does not warn about the defaults. The
      // probes never reach anything these protect.
      JWT_SECRET: "smoke-jwt-secret-not-a-real-secret",
      ENCRYPTION_KEY: "smoke-encryption-key-not-a-real-key",
      ...process.env,
      NODE_ENV: MODE,
      PORT: String(PORT),
      // NOTE: the probes need the HTTP server only. Left on, the workers would claim and run jobs
      // from whatever database `.env` points at for as long as the smoke runs.
      WEBHOOK_WORKER_ENABLED: "false",
      SCHEDULER_WORKER_ENABLED: "false",
      DEBOUNCE_WORKER_ENABLED: "false",
      COMPACTION_WORKER_ENABLED: "false",
      ALERT_WORKER_ENABLED: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // The entrypoint walks to the next port on EADDRINUSE, so the bound port is read back from its own
  // log line rather than assumed. Everything the server prints is kept, because "exited with code 1
  // before binding a port" on its own says nothing (a missing Prisma client, for one, shows up only
  // in the child's output).
  let serverOutput = "";
  const boundPort = await new Promise<number>((resolve, reject) => {
    const fail = (reason: string) => {
      const tail = serverOutput.trim().split("\n").slice(-20).join("\n");
      reject(
        new Error(
          `${reason}${tail ? `\n--- server output (last lines) ---\n${tail}` : ""}`,
        ),
      );
    };
    const timer = setTimeout(
      () => fail(`server did not report a port within ${BOOT_TIMEOUT_MS}ms`),
      BOOT_TIMEOUT_MS,
    );
    const scan = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        serverOutput += new TextDecoder().decode(chunk);
        const match = serverOutput.match(/running on http:\/\/[^:\s]+:(\d+)/);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      }
    };
    void scan(server.stdout);
    void scan(server.stderr);
    void server.exited.then((code) => {
      clearTimeout(timer);
      fail(`server exited with code ${code} before binding a port`);
    });
  }).catch((error: unknown) => {
    server.kill();
    throw error;
  });
  return {
    baseUrl: `http://localhost:${boundPort}`,
    stop: async () => {
      server.kill();
      await server.exited;
    },
  };
}

const target = process.env.SMOKE_URL
  ? { baseUrl: process.env.SMOKE_URL.replace(/\/$/, ""), stop: async () => {} }
  : await bootServer();

const failures: string[] = [];
let PROBES: Probe[] = [];
try {
  PROBES =
    MODE === "production" ? await productionProbes(target.baseUrl) : DEV_PROBES;
  for (const probe of PROBES) {
    const method = probe.method ?? "GET";
    const res = await fetch(`${target.baseUrl}${probe.path}`, {
      method,
    });
    const contentType = res.headers.get("content-type") ?? "";
    const cacheControl = res.headers.get("cache-control") ?? "(none)";
    const ok =
      res.status === probe.status &&
      probe.contentType.test(contentType) &&
      (probe.cacheControl === undefined || probe.cacheControl === cacheControl);
    const got = `${res.status} ${contentType || "(no content-type)"}${probe.cacheControl === undefined ? "" : ` cache-control: ${cacheControl}`}`;
    console.log(`${ok ? "ok  " : "FAIL"} ${method} ${probe.path} → ${got}`);
    if (!ok) {
      const cache =
        probe.cacheControl === undefined
          ? ""
          : ` cache-control: ${probe.cacheControl}`;
      failures.push(
        `${method} ${probe.path}: expected ${probe.status} ${probe.contentType}${cache}, got ${got}`,
      );
    }
  }
} finally {
  await target.stop();
}

if (failures.length > 0) {
  console.error(`\n${MODE} smoke failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `\n${MODE} smoke passed (${PROBES.length} probes on ${target.baseUrl})`,
);
