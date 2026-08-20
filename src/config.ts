import type { LevelWithSilentOrString } from "pino";
import packageInfo from "@/../package.json";

const {
  NODE_ENV,
  PUBLIC_URL,
  PORT,
  LOG_LEVEL,
  JWT_SECRET,
  ENCRYPTION_KEY,
  CORS_ORIGIN,
  DATABASE_URL,
  LANGGRAPH_DATABASE_URL,
  CDN_URL,
  GOOGLE_CLIENT_ID,
  ALLOWED_SIGNUP_DOMAINS,
  ADMIN_SIGNUP_DOMAINS,
  SIGNUP_ENABLED,
  SETUP_TOKEN_REQUIRED,
  WEBHOOK_WORKER_ENABLED,
  WEBHOOK_WORKER_INTERVAL_MS,
  SCHEDULER_WORKER_ENABLED,
  SCHEDULER_WORKER_INTERVAL_MS,
  DEBOUNCE_WORKER_ENABLED,
  DEBOUNCE_WORKER_INTERVAL_MS,
  ALERT_WORKER_ENABLED,
  ALERT_WORKER_INTERVAL_MS,
  ALERT_COALESCE_WINDOW_MS,
  FLOWLOG_RETENTION_DAYS,
  HEARTBEAT_INTERVAL_MS,
  MCP_STDIO_ENABLED,
  ALLOW_SUPERUSER_RUNTIME,
  QUOTES_STORAGE_DIR,
  BRANDING_STORAGE_DIR,
  MCP_JWT_SECRET,
  MCP_DCR_ENABLED,
  SSRF_ALLOW_PRIVATE_TARGETS,
  RATE_LIMIT_USER_PER_MIN,
  RATE_LIMIT_MCP_PER_MIN,
  TRUST_PROXY,
  TRUSTED_PROXY_HOPS,
  BUN_PUBLIC_EDITION,
  FAZER_AI_HUB_URL,
  AGENTS_UPDATE_CHECK_URL,
  HUB_UPDATES_TTL_MS,
  AGENT_MODEL_CONCURRENCY,
  AGENT_PROMPT_MAX_CHARS,
  DB_POOL_MAX,
} = process.env;

// NOTE: Domain entries are trimmed, lowercased, and have a leading "@" stripped
// by parseDomainList() before being matched against this pattern. Values like
// "foo", "example.", or entries containing slashes still fail fast at startup.
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

const parseDomainList = (
  raw: string | undefined,
  envName: string,
): string[] => {
  const values = (raw ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@+/, ""))
    .filter(Boolean);

  for (const domain of values) {
    if (!DOMAIN_RE.test(domain)) {
      throw new Error(`Invalid domain "${domain}" in ${envName}`);
    }
  }

  return values;
};

// TRUST_PROXY decides whether the forwarded chain is believed when keying the rate limiters.
// Unset means false: without a declaration the safe reading is that the app may be reached directly,
// where believing the header would let a caller pick its own bucket. A value that is neither
// spelling fails by name rather than falling back, because the fallback is the strict side and an
// operator who typed `yes` would get the opposite of what they meant, silently and permanently.
const parseTrustProxy = (raw: string | undefined, envName: string): boolean => {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    `${envName} must be "true" or "false" (got "${raw}"). It decides whether X-Forwarded-For is believed when keying the rate limiters.`,
  );
};

// A hop count selects WHICH X-Forwarded-For entry is believed to be the client, so a silently
// defaulted bad value would change who shares a bucket. Fail by name at boot instead.
const parseHops = (raw: string | undefined, envName: string): number => {
  if (raw === undefined || raw.trim() === "") return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${envName} must be a whole number >= 1 (got "${raw}"). It selects which X-Forwarded-For entry is read as the client.`,
    );
  }
  return value;
};

const googleClientId = (GOOGLE_CLIENT_ID ?? "").trim();

// NOTE: strict parse — anything but a finite positive integer (Infinity, NaN, 0, negatives,
// fractions) falls back to the default, so the prompt-size guard can never be disabled by a
// malformed value.
const agentPromptMaxChars = Number(AGENT_PROMPT_MAX_CHARS);

const config = {
  packageInfo: {
    name: packageInfo.name,
    version: packageInfo.version,
  },
  port: PORT ? Number(PORT) : 3000,
  publicUrl: PUBLIC_URL || "http://localhost:3000",
  env: (NODE_ENV || "development") as "development" | "production",
  // NOTE: Distribution edition. Single source of truth shared with the frontend bundle
  // (BUN_PUBLIC_EDITION is baked into the client at build AND kept as a runtime ENV by the
  // Dockerfile), so the client gate and the server never disagree. Defaults to "full"; the Free
  // build sets "free". Consumed via `IS_FREE` (src/lib/edition.ts) and the client bundle.
  edition: (BUN_PUBLIC_EDITION === "free" ? "free" : "full") as "free" | "full",
  logLevel: (LOG_LEVEL || "info") as LevelWithSilentOrString,
  // NOTE: Escape hatch for local dev where the runtime connects as the Postgres superuser.
  // Boot fails fast if the runtime role is superuser/bypassrls (RLS would be a no-op) UNLESS
  // this is true AND env !== production. NEVER set in production.
  allowSuperuserRuntime: ALLOW_SUPERUSER_RUNTIME === "true",
  // NOTE: filesystem root for generated quote PDFs (`<dir>/<tenantId>/<quoteId>.pdf`). Served
  // ONLY via the authenticated, tenant-scoped /v1/quotes/:id/pdf route — never under staticPlugin.
  quotesStorageDir: QUOTES_STORAGE_DIR || "./data/quotes",
  // NOTE: filesystem root for the GLOBAL identity assets (logo/favicon, at most 4 files:
  // `<kind>-<variant>.<ext>`). Served via the public /v1/branding/asset/:kind/:variant route
  // (the binaries are public by nature) — never under staticPlugin.
  brandingStorageDir: BRANDING_STORAGE_DIR || "./data/branding",
  jwtSecret: JWT_SECRET || "change-me-in-production",
  // NOTE: MCP OAuth access tokens are signed with a key SEPARATE from the app cookie JWT (so a
  // token from one realm never validates in the other — anti algorithm/key confusion). Defaults to
  // a derived-but-distinct value so the separation holds even if MCP_JWT_SECRET is unset.
  mcpJwtSecret:
    MCP_JWT_SECRET || `${JWT_SECRET || "change-me-in-production"}:mcp`,
  // NOTE: Dynamic Client Registration is ON by default: every MCP client we support self-registers
  // and NONE has a fallback — with `registration_endpoint` absent from the metadata, Codex aborts
  // with "Dynamic client registration not supported" and Claude Code with "Incompatible auth
  // server", both before any login screen. Pre-registering a client does not rescue them either
  // (Codex's loopback callback uses a random port, and /authorize matches redirect_uri exactly), so
  // a closed default means the MCP transport is simply unreachable. Set MCP_DCR_ENABLED=false to
  // close it: /register 404s and the metadata stops advertising it. A self-registered client is
  // still shown as "unverified" on the consent screen, /register is rate-limited, and the effective
  // grant stays role-gated at /authorize.
  mcpDcrEnabled: MCP_DCR_ENABLED !== "false",
  encryptionKey: ENCRYPTION_KEY || "change-me-in-production",
  corsOrigin: CORS_ORIGIN || "localhost:3000",
  databaseUrl: DATABASE_URL,
  // NOTE: LangGraph PostgresSaver checkpointer connection (schema `langgraph`). Should use a
  // NON-superuser role (the thread_id prefix is the tenant fence; RLS on these tables is
  // hardened in a later phase). Falls back to DATABASE_URL.
  langgraphDatabaseUrl: LANGGRAPH_DATABASE_URL || DATABASE_URL,
  // NOTE: Max connections for BOTH pg pools against the (dedicated) Postgres — the main Prisma pool
  // (prisma.ts) and the LangGraph checkpointer pool (checkpointer.ts). Sized so agent turns drain in
  // parallel without the pool becoming the bottleneck (pairs with agent.modelConcurrency). Total
  // connections per leader replica are ~2×this; keep it under the server's max_connections (pg
  // default 100). To go well beyond ~40, raise max_connections on the Postgres image instead.
  dbPoolMax: DB_POOL_MAX && Number(DB_POOL_MAX) > 0 ? Number(DB_POOL_MAX) : 30,
  cdnUrl: CDN_URL ?? "",
  googleClientId,
  googleOAuthEnabled: googleClientId.length > 0,
  allowedSignupDomains: parseDomainList(
    ALLOWED_SIGNUP_DOMAINS,
    "ALLOWED_SIGNUP_DOMAINS",
  ),
  adminSignupDomains: parseDomainList(
    ADMIN_SIGNUP_DOMAINS,
    "ADMIN_SIGNUP_DOMAINS",
  ),
  // NOTE: Public registration is opt-in. When disabled (the default), both
  // password signup and first-time Google sign-in are refused; existing users
  // keep logging in. The first admin is always created through /setup.
  signupEnabled: SIGNUP_ENABLED === "true",
  // NOTE: When true (the default), the first-run /setup flow requires the token
  // printed in the server log. Disable only on trusted networks.
  setupTokenRequired: SETUP_TOKEN_REQUIRED !== "false",
  // NOTE: Global cap on concurrent agent model calls — the LLM round-trip in the LangGraph agent node
  // (graph.ts) plus the opt-in TTS-normalize call. Conversations drain fully in parallel (the debounce
  // worker no longer serializes them); this is the ONLY throttle on model calls, applied process-wide
  // across every entrypoint (debounce/webhook/nudge/playground) so a burst does not hammer the
  // provider. Per-process (single-replica). Pair with dbPoolMax so the DB pool is not the effective cap.
  agent: {
    modelConcurrency:
      AGENT_MODEL_CONCURRENCY && Number(AGENT_MODEL_CONCURRENCY) > 0
        ? Number(AGENT_MODEL_CONCURRENCY)
        : 20,
    // NOTE: Hard cap (characters) on an agent's system prompt, enforced at the service layer for
    // every transport (console/REST/MCP) and at import. A deliberate checkpoint, not a technical
    // ceiling: prompts past tens of KB usually hold knowledge-base content and degrade instruction
    // adherence. Intentionally surfaced only as a save error — no UI affordance points here.
    promptMaxChars:
      Number.isSafeInteger(agentPromptMaxChars) && agentPromptMaxChars > 0
        ? agentPromptMaxChars
        : 100_000,
  },
  // NOTE: Outbound webhook delivery worker. Single-replica by construction (a reentrancy
  // guard + interval; see docs/deploy.md "Single replica" for the leader pattern when scaling).
  // The tick claims due deliveries (FOR UPDATE SKIP LOCKED), POSTs them signed, and retries
  // with full-jitter backoff. Disable for CLIs/one-off scripts that import the app graph.
  webhookWorker: {
    enabled: WEBHOOK_WORKER_ENABLED !== "false",
    intervalMs: WEBHOOK_WORKER_INTERVAL_MS
      ? Number(WEBHOOK_WORKER_INTERVAL_MS)
      : 5_000,
  },
  // NOTE: Follow-up/sweep scheduler worker. Single-replica by construction (a globalThis
  // singleton + non-overlapping tick); the claim uses FOR UPDATE SKIP LOCKED so it is still
  // correct if briefly doubled. Disable for CLIs/one-off scripts that import the app graph.
  schedulerWorker: {
    enabled: SCHEDULER_WORKER_ENABLED !== "false",
    intervalMs: SCHEDULER_WORKER_INTERVAL_MS
      ? Number(SCHEDULER_WORKER_INTERVAL_MS)
      : 15_000,
  },
  // NOTE: Dedicated FAST tick that drains only DEBOUNCE jobs (inbound message coalescing). It is
  // separate from the scheduler so the per-agent debounce window (seconds) is honored without
  // running the reaper/sweep at that cadence. Same single-replica discipline (globalThis singleton
  // + non-overlapping tick + FOR UPDATE SKIP LOCKED claim). Operational, NOT a per-agent setting.
  debounceWorker: {
    enabled: DEBOUNCE_WORKER_ENABLED !== "false",
    intervalMs: DEBOUNCE_WORKER_INTERVAL_MS
      ? Number(DEBOUNCE_WORKER_INTERVAL_MS)
      : 2_500,
  },
  // NOTE: Cadence of the periodic `heartbeat` outbound webhook (a liveness ping). Runs on the
  // scheduler worker (no separate process); a per-tenant HEARTBEAT job is armed lazily only while
  // the tenant has an enabled subscription to the event, and self-terminates otherwise. Default 1 min.
  heartbeat: {
    intervalMs: HEARTBEAT_INTERVAL_MS ? Number(HEARTBEAT_INTERVAL_MS) : 60_000,
  },
  // NOTE: External alert delivery worker (execution-flow warnings/errors → Discord / webhook).
  // Same single-replica discipline as the outbound worker; OFF on extra replicas. The coalesce
  // window lets a burst accumulate into one delivery's count before the single POST.
  alertWorker: {
    enabled: ALERT_WORKER_ENABLED !== "false",
    intervalMs: ALERT_WORKER_INTERVAL_MS
      ? Number(ALERT_WORKER_INTERVAL_MS)
      : 10_000,
    coalesceWindowMs: ALERT_COALESCE_WINDOW_MS
      ? Number(ALERT_COALESCE_WINDOW_MS)
      : 30_000,
  },
  // NOTE: Retention for the high-write execution_logs table (+ terminal alert_deliveries). A daily
  // per-tenant FLOWLOG_SWEEP job deletes rows older than this. Default 30 days.
  flowlog: {
    retentionDays: FLOWLOG_RETENTION_DAYS ? Number(FLOWLOG_RETENTION_DAYS) : 30,
  },
  // NOTE: stdio MCP transport spawns a local process — arbitrary command execution on the host.
  // In multi-tenant hosting that is an RCE vector, so it is OFF by default; enable only on a
  // single-tenant/self-hosted box you control. Network transports (http/sse) are always allowed
  // and pass the SSRF guard.
  mcpStdioEnabled: MCP_STDIO_ENABLED === "true",
  // NOTE: Anti-SSRF guard for outbound HTTP/MCP targets. Blocking private ranges is critical in
  // production (multi-tenant hosting); in development operators often need to reach local services.
  // Auto-enabled in development when the env var is absent so devs can iterate without extra config.
  ssrf: {
    allowPrivateTargets:
      SSRF_ALLOW_PRIVATE_TARGETS === "true"
        ? true
        : SSRF_ALLOW_PRIVATE_TARGETS === "false"
          ? false
          : (NODE_ENV || "development") === "development",
  },
  // NOTE: Whether to believe the X-Forwarded-For chain when keying the rate limiters. OFF unless
  // declared: the compose files that guarantee the app is only reachable through a proxy set it, and
  // the one that publishes the app port leaves the operator to. See src/api/lib/clientIp.ts for why
  // this is not derived from the peer address.
  trustProxy: parseTrustProxy(TRUST_PROXY, "TRUST_PROXY"),
  // NOTE: How many proxies sit between the client and this app. The client address is read that many
  // hops from the END of X-Forwarded-For, since a proxy appends the peer it saw and a client can
  // prepend but never append. One proxy (every compose file here) is the last entry; a CDN in front
  // of that proxy makes it two.
  trustedProxyHops: parseHops(TRUSTED_PROXY_HOPS, "TRUSTED_PROXY_HOPS"),
  // NOTE: Per-client rate-limit ceilings (requests/minute). These are runaway guards, NOT tight
  // throttles: navigating the console fires dozens of parallel reads, and one MCP client funnels
  // every tool call through a single address, so the buckets must be generous. CAVEAT: everyone
  // behind one NAT counts against the same bucket. The static (1000/min) and DCR (10/min) limits are
  // fixed in the middleware.
  rateLimit: {
    userPerMin:
      RATE_LIMIT_USER_PER_MIN && Number(RATE_LIMIT_USER_PER_MIN) > 0
        ? Number(RATE_LIMIT_USER_PER_MIN)
        : 600,
    mcpPerMin:
      RATE_LIMIT_MCP_PER_MIN && Number(RATE_LIMIT_MCP_PER_MIN) > 0
        ? Number(RATE_LIMIT_MCP_PER_MIN)
        : 1200,
  },
  // NOTE: Central fazer.ai hub (app.fazer.ai) that serves operator announcements (the top banner)
  // and the "new version available" check. Empty string DISABLES all hub communication (air-gapped,
  // or a fork that does not want to talk to fazer.ai). For the Free/open-source edition this is a
  // light update check: it sends the edition + current version + the request IP, never any PII.
  hub: {
    // NOTE: trim before stripping trailing slashes so a padded or whitespace-only value resolves to
    // "" (disabled) instead of a malformed URL.
    url: (FAZER_AI_HUB_URL ?? "https://app.fazer.ai")
      .trim()
      .replace(/\/+$/, ""),
    // NOTE: Optional override for the VERSION check only (a fork with its own release cadence points
    // this at a URL returning `{ latestVersion, releaseUrl? }`). Empty = derive from `url`.
    updateCheckUrl: (AGENTS_UPDATE_CHECK_URL ?? "").trim().replace(/\/+$/, ""),
    // NOTE: Cache TTL (ms) for the hub announcements/version fetch. Default 1h. A non-numeric or
    // non-positive value falls back to the default (Number("x") > 0 is false for NaN), never NaN.
    updatesTtlMs:
      HUB_UPDATES_TTL_MS && Number(HUB_UPDATES_TTL_MS) > 0
        ? Number(HUB_UPDATES_TTL_MS)
        : 3_600_000,
  },
};

// NOTE: ADMIN_SIGNUP_DOMAINS auto-promotes only via paths that already pass the
// ALLOWED_SIGNUP_DOMAINS gate (Google first-time sign-in). When both lists are
// set, an admin domain outside the allowlist can never fire and the misconfig
// is silent. Fail fast at boot instead.
if (
  config.allowedSignupDomains.length > 0 &&
  config.adminSignupDomains.length > 0
) {
  const allowedSet = new Set(config.allowedSignupDomains);
  for (const domain of config.adminSignupDomains) {
    if (!allowedSet.has(domain)) {
      throw new Error(
        `ADMIN_SIGNUP_DOMAINS contains "${domain}" which is not in ALLOWED_SIGNUP_DOMAINS`,
      );
    }
  }
}

if (config.env === "production") {
  if (config.jwtSecret === "change-me-in-production") {
    throw new Error(
      "⚠️  JWT_SECRET must be set in production to something other than the default.",
    );
  }
  if (config.encryptionKey === "change-me-in-production") {
    throw new Error(
      "⚠️  ENCRYPTION_KEY must be set in production to something other than the default.",
    );
  }
}

export default config;
