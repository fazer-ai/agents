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
  COMPACTION_WORKER_ENABLED,
  COMPACTION_WORKER_INTERVAL_MS,
  DEBOUNCE_WORKER_INTERVAL_MS,
  ALERT_WORKER_ENABLED,
  ALERT_WORKER_INTERVAL_MS,
  ALERT_COALESCE_WINDOW_MS,
  FLOWLOG_RETENTION_DAYS,
  HEARTBEAT_INTERVAL_MS,
  MCP_STDIO_ENABLED,
  ALLOW_SUPERUSER_RUNTIME,
  DOCUMENTS_STORAGE_DIR,
  QUOTES_STORAGE_DIR,
  BRANDING_STORAGE_DIR,
  MCP_JWT_SECRET,
  MCP_DCR_ENABLED,
  SSRF_ALLOW_PRIVATE_TARGETS,
  RATE_LIMIT_USER_PER_MIN,
  RATE_LIMIT_MCP_PER_MIN,
  RATE_LIMIT_CREDENTIAL_MAX,
  RATE_LIMIT_CREDENTIAL_WINDOW_MINUTES,
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
// NOTE: the upper bound is not tidiness, it is the second half of the same defect. A window that
// `Number.isInteger` accepts can still be one the limiter cannot honour: at 1e12 minutes the
// millisecond duration passes Date's ±8.64e15 range, and the reset lands on an invalid date exactly
// like Infinity does. Bounding the window at a day is well past any real throttle and puts every
// unrepresentable value on the other side of the check. The budgets are bounded for the mirror-image
// reason: an absurd ceiling is a bucket that never trips while reading as a configured one.
//
// NOTE: `Number.isInteger` is what makes the rest of this safe, not `> 0`. The pattern these budgets used to
// share (`RAW && Number(RAW) > 0 ? Number(RAW) : fallback`) accepts `Infinity`, and `1e309` parses to
// exactly that. Measured with an infinite window: the limiter advertises `RateLimit-Reset: NaN` and
// the bucket NEVER resets, so the endpoints it guards answer 429 permanently once the budget is
// spent. On a max instead of a window it is the mirror image, an unlimited bucket that reads as a
// configured one. `isInteger` refuses Infinity, NaN and fractions in one go.
//
// NOTE: it also throws on garbage instead of falling back. Falling back is how a typo becomes a
// budget nobody chose, silently: same reasoning as TRUST_PROXY above, where the quiet default is the
// strict side and guessing would mean the opposite of what the operator wrote.
// A day. Any real throttle is orders of magnitude under this, and every window whose millisecond
// duration Date cannot represent is orders of magnitude over it.
const MAX_WINDOW_MINUTES = 1440;
// Generous enough that "effectively unlimited" is still expressible, small enough that a slipped
// exponent is caught rather than silently disabling a limiter. Used for every count: budgets, pool
// sizes, concurrency, character caps.
const MAX_COUNT = 1_000_000;
// The runtime's own limit for the five that reach `setInterval` (the webhook, scheduler, debounce,
// compaction and alert workers), and a generous ceiling for the three other millisecond spans.
// `setInterval` takes a 32-bit signed delay and anything it cannot represent it sets to 1: measured
// in Bun, twenty ticks at a NaN delay took 23.6ms and twenty at Infinity took 22.8ms, about 1.15ms
// each, against the 15_000ms the operator wrote. A worker whose tick claims jobs then spins against
// the database instead of idling. The other three are date and cache arithmetic, where the same
// values produce an Invalid Date rather than a hot loop; 24 days is past any real span for them too.
const MAX_DURATION_MS = 2_147_483_647;
// The protocol's own limit.
const MAX_PORT = 65_535;
// A century. Any real retention policy is orders of magnitude under this, and every span whose
// millisecond value Date cannot represent is orders of magnitude over it.
const MAX_RETENTION_DAYS = 36_500;

// NOTE: every numeric environment variable in this file goes through here, and tests/config.test.ts
// reads this source to keep that true: it asserts that `raw`, this function's own input, is the only
// thing the file ever hands to `Number`. The shape this replaced was `RAW ? Number(RAW) : fallback`,
// which converts and asks nothing, so `Number("15s")` reached consumers as NaN and `Number("1e309")`
// as Infinity. See MAX_DURATION_MS for what that did to the seven that feed a timer.
//
// NOTE: `minimum` is 1 for every setting but one. Zero is admitted only where the CONSUMER treats it
// as a value rather than as an absence, which is a narrower test than "the old code let it through":
// the old code let zero through on nine of these, and on eight of the nine it was the pathology, not
// a setting. `setInterval(fn, 0)` is the same 1ms tick as NaN, a heartbeat due at `now` is a storm,
// and `PORT=0` binds an ephemeral port nothing can route to.
export const parseIntSetting = (
  raw: string | undefined,
  envName: string,
  fallback: number,
  consequence: string,
  upperBound: number,
  minimum = 1,
): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > upperBound) {
    throw new Error(
      `${envName} must be a whole number between ${minimum} and ${upperBound} (got "${raw}"). ${consequence}`,
    );
  }
  return value;
};

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

const agentPromptMaxChars = parseIntSetting(
  AGENT_PROMPT_MAX_CHARS,
  "AGENT_PROMPT_MAX_CHARS",
  100_000,
  "It is the ceiling on an agent's system prompt, so a malformed value would disable the guard.",
  MAX_COUNT,
);

const config = {
  packageInfo: {
    name: packageInfo.name,
    version: packageInfo.version,
  },
  port: parseIntSetting(
    PORT,
    "PORT",
    3000,
    "It is the port the server binds.",
    MAX_PORT,
  ),
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
  // NOTE: filesystem root for issued document PDFs (`<dir>/<tenantId>/documents/<documentId>.pdf`)
  // and the tenant's letterhead logo (`<dir>/company/<tenantId>-logo.<ext>`). Served ONLY via the
  // authenticated, tenant-scoped /v1/documents routes — never under staticPlugin. The `documents/`
  // segment keeps them clear of the `<tenantId>/<quoteId>.pdf` an upgraded install already has in
  // this directory (see storageKey).
  //
  // The QUOTES_STORAGE_DIR fallback is NOT tidiness, it is the upgrade path, and dropping it loses
  // files. Coolify FREEZES a compose `environment:` value when the installation is created, so an
  // existing install keeps the QUOTES_STORAGE_DIR it was created with and never learns the new name
  // no matter what the compose says today. Without this chain, that install falls through to the
  // default — which is inside the container, not on the volume — and every PDF it writes disappears
  // on the next redeploy, silently.
  documentsStorageDir:
    DOCUMENTS_STORAGE_DIR || QUOTES_STORAGE_DIR || "./data/documents",
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
  dbPoolMax: parseIntSetting(
    DB_POOL_MAX,
    "DB_POOL_MAX",
    30,
    "It sizes both Postgres pools, and total connections per replica are about twice it.",
    MAX_COUNT,
  ),
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
    modelConcurrency: parseIntSetting(
      AGENT_MODEL_CONCURRENCY,
      "AGENT_MODEL_CONCURRENCY",
      20,
      "It is the only throttle on concurrent model calls, process-wide.",
      MAX_COUNT,
    ),
    // NOTE: Hard cap (characters) on an agent's system prompt, enforced at the service layer for
    // every transport (console/REST/MCP) and at import. A deliberate checkpoint, not a technical
    // ceiling: prompts past tens of KB usually hold knowledge-base content and degrade instruction
    // adherence. Intentionally surfaced only as a save error — no UI affordance points here.
    promptMaxChars: agentPromptMaxChars,
  },
  // NOTE: Outbound webhook delivery worker. Single-replica by construction (a reentrancy
  // guard + interval; see docs/deploy.md "Single replica" for the leader pattern when scaling).
  // The tick claims due deliveries (FOR UPDATE SKIP LOCKED), POSTs them signed, and retries
  // with full-jitter backoff. Disable for CLIs/one-off scripts that import the app graph.
  webhookWorker: {
    enabled: WEBHOOK_WORKER_ENABLED !== "false",
    intervalMs: parseIntSetting(
      WEBHOOK_WORKER_INTERVAL_MS,
      "WEBHOOK_WORKER_INTERVAL_MS",
      5_000,
      "It is how often the outbound webhook worker claims due deliveries.",
      MAX_DURATION_MS,
    ),
  },
  // NOTE: Follow-up/sweep scheduler worker. Single-replica by construction (a globalThis
  // singleton + non-overlapping tick); the claim uses FOR UPDATE SKIP LOCKED so it is still
  // correct if briefly doubled. Disable for CLIs/one-off scripts that import the app graph.
  schedulerWorker: {
    enabled: SCHEDULER_WORKER_ENABLED !== "false",
    intervalMs: parseIntSetting(
      SCHEDULER_WORKER_INTERVAL_MS,
      "SCHEDULER_WORKER_INTERVAL_MS",
      15_000,
      "It is how often the scheduler worker claims due jobs.",
      MAX_DURATION_MS,
    ),
  },
  // NOTE: Dedicated FAST tick that drains only DEBOUNCE jobs (inbound message coalescing). It is
  // separate from the scheduler so the per-agent debounce window (seconds) is honored without
  // running the reaper/sweep at that cadence. Same single-replica discipline (globalThis singleton
  // + non-overlapping tick + FOR UPDATE SKIP LOCKED claim). Operational, NOT a per-agent setting.
  debounceWorker: {
    enabled: DEBOUNCE_WORKER_ENABLED !== "false",
    intervalMs: parseIntSetting(
      DEBOUNCE_WORKER_INTERVAL_MS,
      "DEBOUNCE_WORKER_INTERVAL_MS",
      2_500,
      "It is how often the debounce lane drains inbound message coalescing.",
      MAX_DURATION_MS,
    ),
  },
  // NOTE: Dedicated tick that drains only MEMORY_COMPACT jobs. Separate from the scheduler for the
  // mirror image of the debounce reason: the scheduler awaits its jobs one at a time, a summary is a
  // model call with a 60s ceiling, and compaction fires for every agent on every closed attendance.
  // Nothing here is time-sensitive (the resolve trigger already waits out a 15-minute grace), so the
  // cadence matches the scheduler's rather than the fast lane's. Operational, NOT a per-agent
  // setting; the per-agent switch is agent.settings.memory.compaction.
  compactionWorker: {
    enabled: COMPACTION_WORKER_ENABLED !== "false",
    intervalMs: parseIntSetting(
      COMPACTION_WORKER_INTERVAL_MS,
      "COMPACTION_WORKER_INTERVAL_MS",
      15_000,
      "It is how often the compaction lane claims MEMORY_COMPACT jobs.",
      MAX_DURATION_MS,
    ),
  },
  // NOTE: Cadence of the periodic `heartbeat` outbound webhook (a liveness ping). Runs on the
  // scheduler worker (no separate process); a per-tenant HEARTBEAT job is armed lazily only while
  // the tenant has an enabled subscription to the event, and self-terminates otherwise. Default 1 min.
  heartbeat: {
    intervalMs: parseIntSetting(
      HEARTBEAT_INTERVAL_MS,
      "HEARTBEAT_INTERVAL_MS",
      60_000,
      "It is the cadence of the heartbeat outbound webhook.",
      MAX_DURATION_MS,
    ),
  },
  // NOTE: External alert delivery worker (execution-flow warnings/errors → Discord / webhook).
  // Same single-replica discipline as the outbound worker; OFF on extra replicas. The coalesce
  // window lets a burst accumulate into one delivery's count before the single POST.
  alertWorker: {
    enabled: ALERT_WORKER_ENABLED !== "false",
    intervalMs: parseIntSetting(
      ALERT_WORKER_INTERVAL_MS,
      "ALERT_WORKER_INTERVAL_MS",
      10_000,
      "It is how often the alert worker claims due deliveries.",
      MAX_DURATION_MS,
    ),
    // NOTE: the one setting here where ZERO is a value, not an absence. It means deliver without
    // buffering, the consumer takes it as such (`Math.max(0, Math.floor(ms / 1000))` in claimDue),
    // and there is no other way to ask for it. Everything else in this file takes a minimum of 1.
    coalesceWindowMs: parseIntSetting(
      ALERT_COALESCE_WINDOW_MS,
      "ALERT_COALESCE_WINDOW_MS",
      30_000,
      "It is how long a burst accumulates into one delivery before the POST; 0 delivers without buffering.",
      MAX_DURATION_MS,
      0,
    ),
  },
  // NOTE: Retention for the high-write execution_logs table (+ terminal alert_deliveries). A daily
  // per-tenant FLOWLOG_SWEEP job deletes rows older than this. Default 30 days.
  flowlog: {
    retentionDays: parseIntSetting(
      FLOWLOG_RETENTION_DAYS,
      "FLOWLOG_RETENTION_DAYS",
      30,
      "It is the cutoff the daily sweep deletes execution_logs against, so a malformed value leaves the highest-write table growing forever.",
      MAX_RETENTION_DAYS,
    ),
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
  //
  // NOTE: the credential budget is the exception, and it is deliberately NOT per-minute. A
  // per-minute ceiling resets 60 times an hour, so 10/min is 600 password guesses an hour against
  // one account; the window is what bounds brute force, not the number. 20 per 5 minutes is 240 an
  // hour and still absorbs a burst, which is what an office arriving at once looks like through a
  // single NAT.
  rateLimit: {
    userPerMin: parseIntSetting(
      RATE_LIMIT_USER_PER_MIN,
      "RATE_LIMIT_USER_PER_MIN",
      600,
      "It is the ceiling every request that is not static or MCP transport counts against.",
      MAX_COUNT,
    ),
    mcpPerMin: parseIntSetting(
      RATE_LIMIT_MCP_PER_MIN,
      "RATE_LIMIT_MCP_PER_MIN",
      1200,
      "It is the ceiling the MCP JSON-RPC transport counts against.",
      MAX_COUNT,
    ),
    credentialMax: parseIntSetting(
      RATE_LIMIT_CREDENTIAL_MAX,
      "RATE_LIMIT_CREDENTIAL_MAX",
      20,
      "It is how many credential attempts one address gets per window.",
      MAX_COUNT,
    ),
    credentialWindowMinutes: parseIntSetting(
      RATE_LIMIT_CREDENTIAL_WINDOW_MINUTES,
      "RATE_LIMIT_CREDENTIAL_WINDOW_MINUTES",
      5,
      "It is the window the credential budget resets on, so a value the limiter cannot turn into a date leaves those endpoints answering 429 for good.",
      MAX_WINDOW_MINUTES,
    ),
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
    // NOTE: Cache TTL (ms) for the hub announcements/version fetch. Default 1h.
    updatesTtlMs: parseIntSetting(
      HUB_UPDATES_TTL_MS,
      "HUB_UPDATES_TTL_MS",
      3_600_000,
      "It is how long the hub announcements and version check are cached.",
      MAX_DURATION_MS,
    ),
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

// NOTE: `elysia-rate-limit` registers itself as an Elysia plugin named "elysia-rate-limit" seeded
// with `max:duration:scoping`, so ANY TWO of the five limiters mounted in src/app.ts that share all
// three are DEDUPLICATED by Elysia and the later one silently never mounts. Measured on 4.6.3: two
// limiters at max=3 guarding different paths, and the path guarded by the SECOND served 4 of 4
// requests with no `RateLimit-*` header at all and nothing logged.
//
// The failure is not symmetric, which is why this throws instead of warning. Whichever limiter loses
// is the ONLY one counting its traffic, so a collision never tightens anything, it deletes a bucket.
// It is also exactly the trap the credential budget was walking into: the DCR limiter is
// (10, 60000, scoped) and the limiter written for the credential endpoints shipped as
// (10, 60000, scoped) and mounted nowhere, so mounting it as written would have left those endpoints
// with the global budget they already had, while every test and every reader said otherwise.
export function assertLimiterBudgetsAreDistinct(
  seeds: readonly (readonly [name: string, max: number, durationMs: number])[],
): void {
  for (const [nameA, maxA, durationA] of seeds) {
    for (const [nameB, maxB, durationB] of seeds) {
      if (nameA < nameB && maxA === maxB && durationA === durationB) {
        throw new Error(
          `${nameA} and ${nameB} are both ${maxA} per ${durationA / 1000}s. elysia-rate-limit seeds its plugin with max:duration:scoping, and all of these are scoped, so two limiters sharing a budget AND a window are deduplicated by Elysia: one of them silently never mounts and its traffic goes unlimited. Give them different values.`,
        );
      }
    }
  }
}

// Beyond the collision above, a credential budget that is not tighter than the global one is
// meaningless: the same requests are counted by BOTH limiters, so the looser one never trips first.
// Compared as rates, because the two windows differ.
export function assertCredentialBudgetIsTighter(
  credentialMax: number,
  windowMinutes: number,
  userPerMin: number,
): void {
  const perMinute = credentialMax / windowMinutes;
  if (perMinute >= userPerMin) {
    throw new Error(
      `RATE_LIMIT_CREDENTIAL_MAX (${credentialMax} per ${windowMinutes} min = ${perMinute}/min) must be below RATE_LIMIT_USER_PER_MIN (${userPerMin}/min): the credential endpoints are counted by both limiters, so a credential budget at or above the global one never applies.`,
    );
  }
}

assertLimiterBudgetsAreDistinct([
  [
    "the global budget (RATE_LIMIT_USER_PER_MIN)",
    config.rateLimit.userPerMin,
    60_000,
  ],
  [
    "the MCP transport budget (RATE_LIMIT_MCP_PER_MIN)",
    config.rateLimit.mcpPerMin,
    60_000,
  ],
  ["the static asset budget", 1000, 60_000],
  ["the DCR registration budget", 10, 60_000],
  [
    "the credential budget (RATE_LIMIT_CREDENTIAL_MAX / _WINDOW_MINUTES)",
    config.rateLimit.credentialMax,
    config.rateLimit.credentialWindowMinutes * 60_000,
  ],
]);

assertCredentialBudgetIsTighter(
  config.rateLimit.credentialMax,
  config.rateLimit.credentialWindowMinutes,
  config.rateLimit.userPerMin,
);

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
