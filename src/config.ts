import type { LevelWithSilentOrString } from "pino";
import packageInfo from "@/../package.json";
import {
  TTS_CHECK_MODES,
  type TtsCheckMode,
} from "@/modules/tts/settings-shared";

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
  SCHEDULER_TRAFFIC_CONCURRENCY,
  SCHEDULER_TRAFFIC_PER_MINUTE,
  CHECKPOINT_RECONCILE_INTERVAL_MS,
  CHECKPOINT_RECONCILE_FIRST_DELAY_MS,
  CHECKPOINT_RECONCILE_GRACE_MS,
  OBSERVE_WORKER_INTERVAL_MS,
  DEBOUNCE_WORKER_ENABLED,
  COMPACTION_WORKER_ENABLED,
  COMPACTION_WORKER_INTERVAL_MS,
  DEBOUNCE_WORKER_INTERVAL_MS,
  DEBOUNCE_TURN_SLOTS,
  SHUTDOWN_DRAIN_MS,
  ALERT_WORKER_ENABLED,
  ALERT_WORKER_INTERVAL_MS,
  ALERT_COALESCE_WINDOW_MS,
  ALERT_CAUSE_WINDOW_MS,
  ALERT_RATE_THRESHOLD,
  ALERT_RATE_WINDOW_MS,
  ALERT_RECOVERY_THRESHOLD,
  ALERT_RECOVERY_WINDOW_MS,
  ALERT_LATE_REPLY_AGE_MS,
  FLOWLOG_RETENTION_DAYS,
  HEARTBEAT_INTERVAL_MS,
  SPEND_CEILING_POLL_INTERVAL_MS,
  MCP_STDIO_ENABLED,
  CLIENT_CHANNEL_ENABLED,
  CLIENT_CHANNEL_SDK_USER_PER_MIN,
  CLIENT_CHANNEL_SDK_APP_PER_MIN,
  ALLOW_SUPERUSER_RUNTIME,
  DOCUMENTS_STORAGE_DIR,
  QUOTES_STORAGE_DIR,
  BRANDING_STORAGE_DIR,
  MCP_JWT_SECRET,
  MCP_DCR_ENABLED,
  SSRF_ALLOW_PRIVATE_TARGETS,
  SSRF_INTERNAL_TARGETS,
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
  AGENT_MODEL_CALL_TIMEOUT_MS,
  AGENT_CAPACITY_WAIT_ALERT_MS,
  CLIENT_TURN_SUSPEND_TIMEOUT_MS,
  AGENT_MODEL_BACKGROUND_SHARE_PERCENT,
  AGENT_MODEL_BACKGROUND_MAX_WAIT_MS,
  AGENT_PROMPT_MAX_CHARS,
  HTTP_TOOL_TIMEOUT_MS,
  DB_POOL_MAX,
  LANGGRAPH_POOL_MAX,
  METRICS_POOL_MAX,
  BACKGROUND_POOL_MAX,
  METRICS_TIMEOUT_MS,
  DB_TX_MAX_WAIT_MS,
  DB_TX_TIMEOUT_MS,
  DB_LOCK_TIMEOUT_MS,
  CHATWOOT_DELIVERY_CONCURRENCY,
  CHATWOOT_ACK_POOL_MAX,
  TTS_CHECK_URL,
  TTS_CHECK_MODE,
  TTS_CHECK_TOKEN,
  TTS_CHECK_TIMEOUT_MS,
  MAIL_PROVIDER,
  MAIL_FROM,
  MAIL_REPLY_TO,
  RESEND_API_KEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASSWORD,
} = process.env;

// Domain entries are trimmed, lowercased, and have a leading "@" stripped
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

// SSRF_INTERNAL_TARGETS names the internal services one HTTP tool may reach without turning the SSRF
// guard off for the whole instance. The port is required: another container on a shared Docker
// network can claim the hostname, and the port keeps one entry from covering every service with that
// name. A malformed entry fails the boot by name, because skipping it leaves a list that reads as
// configured and a tool refused for a reason nobody can see. The host goes through `new URL` so it is
// compared in the same normal form the guard reads off the request URL.
export interface InternalTarget {
  host: string;
  port: number;
}

// The host part refuses every character `new URL` would read as the end of the host, the backslash
// included: WHATWG URL treats `\` as `/` in an http URL, so `sidecar\renderer:8080` would parse to host
// `sidecar` and silently open a target nobody wrote.
const INTERNAL_TARGET_RE = /^(\[[0-9a-fA-F:.]+\]|[^:/\\\s[\]@?#]+):(\d{1,5})$/;

export const parseInternalTargets = (
  list: string | undefined,
  envName: string,
): InternalTarget[] => {
  const out: InternalTarget[] = [];
  for (const entry of (list ?? "").split(",").map((e) => e.trim())) {
    if (entry === "") continue;
    const m = entry.match(INTERNAL_TARGET_RE);
    const raw = m?.[2];
    const port = Number(raw);
    let host: string | null = null;
    try {
      host = m?.[1] ? new URL(`http://${m[1]}`).hostname : null;
    } catch {
      host = null;
    }
    if (!m || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `Invalid entry "${entry}" in ${envName}: each entry must be host:port, with the port stated (e.g. sidecar:8080).`,
      );
    }
    out.push({ host: host.replace(/^\[|\]$/g, ""), port });
  }
  return out;
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

// The upper bounds below are part of the same check as `Number.isInteger`: an integer window of 1e12
// minutes still passes Date's ±8.64e15 ms range and resets on an invalid date, and an absurd budget
// is a bucket that never trips while reading as configured. `> 0` alone is not enough: it accepts
// `Infinity` (`1e309`), which leaves a window that never resets (429 for good) or an unlimited max.

// A day. Any real throttle is orders of magnitude under this, and every window whose millisecond
// duration Date cannot represent is orders of magnitude over it.
const MAX_WINDOW_MINUTES = 1440;
// Generous enough that "effectively unlimited" is still expressible, small enough that a slipped
// exponent is caught rather than silently disabling a limiter. Used for every count: budgets, pool
// sizes, concurrency, character caps.
const MAX_COUNT = 1_000_000;
// The runtime's own limit for the five that reach `setInterval` (the webhook, scheduler, debounce,
// compaction and alert workers), and a generous ceiling for the three other millisecond spans.
// `setInterval` takes a 32-bit signed delay and sets anything it cannot represent (NaN, Infinity) to
// about 1ms, so a worker whose tick claims jobs spins against the database instead of idling. The
// other three are date and cache arithmetic, where the same values produce an Invalid Date rather
// than a hot loop; 24 days is past any real span for them too.
const MAX_DURATION_MS = 2_147_483_647;
// The protocol's own limit.
const MAX_PORT = 65_535;
// A century. Any real retention policy is orders of magnitude under this, and every span whose
// millisecond value Date cannot represent is orders of magnitude over it.
const MAX_RETENTION_DAYS = 36_500;

// Every numeric environment variable in this file goes through here: tests/config.test.ts asserts
// that `raw` is the only thing the file hands to `Number`, since a bare `Number(RAW)` lets "15s"
// through as NaN and "1e309" as Infinity. Garbage throws instead of falling back, because a fallback
// turns a typo into a value nobody chose. `minimum` is 1 except where the consumer treats zero as a
// value: `setInterval(fn, 0)` is the same 1ms tick as NaN, and `PORT=0` binds an unroutable port.
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

// The three things an audio check can do with a synthesized reply. Declared, never inferred from
// anything but the URL: with no detector there is nothing to call, and with one the default is
// `shadow`, which records and never changes a send. `enforce` holds a reply back, which a deployment
// should not drift into. The list lives in the TTS settings module because an agent can pick a mode
// too and the console reads that module; re-exported here so the deployment side keeps one name.
export {
  TTS_CHECK_MODES,
  type TtsCheckMode,
} from "@/modules/tts/settings-shared";

export const parseTtsCheckMode = (
  rawMode: string | undefined,
  url: string,
): TtsCheckMode => {
  const mode = (rawMode ?? "").trim().toLowerCase();
  if (mode === "") return url ? "shadow" : "off";
  if (!(TTS_CHECK_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `TTS_CHECK_MODE must be one of ${TTS_CHECK_MODES.join(", ")} (got "${rawMode}"). It decides whether a synthesized audio reply is checked before it goes out.`,
    );
  }
  if (mode !== "off" && !url) {
    throw new Error(
      `TTS_CHECK_MODE=${mode} needs TTS_CHECK_URL: there is no detector to call, and a check that silently never runs is the failure this setting exists to prevent.`,
    );
  }
  return mode as TtsCheckMode;
};

const ttsCheckUrl = (TTS_CHECK_URL ?? "").trim().replace(/\/+$/, "");

const googleClientId = (GOOGLE_CLIENT_ID ?? "").trim();

// Read before the object because the checkpointer pool's default is this value.
const dbPoolMax = parseIntSetting(
  DB_POOL_MAX,
  "DB_POOL_MAX",
  30,
  "It sizes the main Postgres pool.",
  MAX_COUNT,
);

const agentPromptMaxChars = parseIntSetting(
  AGENT_PROMPT_MAX_CHARS,
  "AGENT_PROMPT_MAX_CHARS",
  100_000,
  "It is the ceiling on an agent's system prompt, so a malformed value would disable the guard.",
  MAX_COUNT,
);

export type MailProvider = "resend" | "smtp" | "console" | "memory" | "none";

const MAIL_PROVIDERS: readonly MailProvider[] = [
  "resend",
  "smtp",
  "console",
  "memory",
  "none",
];

// "Name <address>" or a bare address. Loose on purpose: the provider is the real validator, this only
// turns an obvious typo into a boot failure that names the variable instead of a refused send on the
// first sign-in code.
const MAIL_FROM_RE =
  /^(?:[^<>]*<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;

// Which transport sends mail. An explicit MAIL_PROVIDER wins; otherwise the credentials decide. With
// neither set, the suite gets the in-memory outbox, dev logs to the console, and production has no mail,
// which turns off sign-in by code for dashboard viewers (Google sign-in still works). Both sets of
// credentials without MAIL_PROVIDER is refused rather than resolved by precedence: a leftover SMTP_HOST
// silently losing to a new RESEND_API_KEY is the kind of drift nobody notices.
const resolveMailProvider = (env: string): MailProvider => {
  const raw = (MAIL_PROVIDER ?? "").trim().toLowerCase();
  const hasResend = !!RESEND_API_KEY?.trim();
  const hasSmtp = !!SMTP_HOST?.trim();
  if (raw) {
    if (!MAIL_PROVIDERS.includes(raw as MailProvider)) {
      throw new Error(
        `MAIL_PROVIDER must be one of ${MAIL_PROVIDERS.filter((p) => p !== "memory").join(", ")}, got "${MAIL_PROVIDER}".`,
      );
    }
    return raw as MailProvider;
  }
  if (hasResend && hasSmtp) {
    throw new Error(
      "Both RESEND_API_KEY and SMTP_HOST are set. Set MAIL_PROVIDER to resend or smtp to say which one sends mail.",
    );
  }
  if (hasResend) return "resend";
  if (hasSmtp) return "smtp";
  if (env === "test") return "memory";
  return env === "production" ? "none" : "console";
};

const parseMailFrom = (raw: string | undefined, required: boolean) => {
  const value = (raw ?? "").trim();
  if (!value) {
    if (required) {
      throw new Error(
        'MAIL_FROM must be set when mail is sent through Resend or SMTP, e.g. MAIL_FROM="Atendimento <no-reply@example.com>". The address has to belong to a domain the provider has verified.',
      );
    }
    return "fazer.ai agents <no-reply@localhost.test>";
  }
  if (!MAIL_FROM_RE.test(value)) {
    throw new Error(
      `MAIL_FROM must be an address or "Name <address>", got "${raw}".`,
    );
  }
  return value;
};

const parseSmtpSecure = (raw: string | undefined, port: number) => {
  const value = (raw ?? "").trim().toLowerCase();
  // 465 is implicit TLS; 587 and 25 start in plain text and upgrade with STARTTLS, which nodemailer
  // does on its own when the server offers it.
  if (value === "") return port === 465;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`SMTP_SECURE must be "true" or "false", got "${raw}".`);
};

const mailProvider = resolveMailProvider(NODE_ENV || "development");
const smtpPort = parseIntSetting(
  SMTP_PORT,
  "SMTP_PORT",
  587,
  "It is the port the SMTP transport connects to.",
  MAX_PORT,
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
  // "test" belongs in the union: `bun test` sets NODE_ENV=test and it wins over the `.env`, so
  // every `=== "development"` is false under the suite. Guard on `!== "production"` to cover test.
  env: (NODE_ENV || "development") as "development" | "production" | "test",
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
  // Filesystem root for issued document PDFs (`<dir>/<tenantId>/documents/<documentId>.pdf`)
  // and the tenant's letterhead logo (`<dir>/company/<tenantId>-logo.<ext>`). Served ONLY via the
  // authenticated, tenant-scoped /v1/documents routes, never under staticPlugin. The `documents/`
  // segment keeps them clear of the `<tenantId>/<quoteId>.pdf` an upgraded install already has in
  // this directory (see storageKey). The QUOTES_STORAGE_DIR fallback is the upgrade path: Coolify
  // freezes a compose `environment:` value at install time, so without it an older install writes to
  // the in-container default and loses every PDF on the next redeploy.
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
  // Dynamic Client Registration is ON by default: every supported MCP client (Codex, Claude
  // Code) self-registers and aborts before login without `registration_endpoint`, and
  // pre-registering does not help (Codex's loopback port is random, /authorize matches redirect_uri
  // exactly). MCP_DCR_ENABLED=false closes it. A self-registered client still shows as "unverified",
  // /register is rate-limited, and the grant stays role-gated at /authorize.
  mcpDcrEnabled: MCP_DCR_ENABLED !== "false",
  encryptionKey: ENCRYPTION_KEY || "change-me-in-production",
  corsOrigin: CORS_ORIGIN || "localhost:3000",
  databaseUrl: DATABASE_URL,
  // NOTE: LangGraph PostgresSaver checkpointer connection (schema `langgraph`). Should use a
  // NON-superuser role (the thread_id prefix is the tenant fence; RLS on these tables is
  // hardened in a later phase). Falls back to DATABASE_URL.
  langgraphDatabaseUrl: LANGGRAPH_DATABASE_URL || DATABASE_URL,
  // NOTE: Every pool a replica opens has its own size, and their sum is checked against the server's
  // `max_connections` at boot (src/lib/db-budget.ts, docs/deploy.md "Connection budget"). This one
  // is the main Prisma pool (prisma.ts): turns, tools, ingest and the scheduler.
  dbPoolMax,
  // NOTE: The LangGraph checkpointer pool (checkpointer.ts), touched by every graph.invoke. Follows
  // `DB_POOL_MAX` when unset, which is what both pools were sized by before they had a knob each.
  langgraphPoolFollowsMain: (LANGGRAPH_POOL_MAX ?? "").trim() === "",
  langgraphPoolMax: parseIntSetting(
    LANGGRAPH_POOL_MAX,
    "LANGGRAPH_POOL_MAX",
    dbPoolMax,
    "It sizes the LangGraph checkpointer's Postgres pool.",
    MAX_COUNT,
  ),
  // NOTE: Interactive transactions (`runScopedOn`, `asSuperAdminOn`). `maxWait` is how long one waits
  // for a connection; `timeout` how long it may stay open, which Postgres enforces on each statement
  // inside it (a statement past it is cancelled, since the transaction already lost its budget).
  dbTx: {
    maxWaitMs: parseIntSetting(
      DB_TX_MAX_WAIT_MS,
      "DB_TX_MAX_WAIT_MS",
      2_000,
      "It is how long a transaction waits for a free connection before failing.",
      MAX_DURATION_MS,
    ),
    timeoutMs: parseIntSetting(
      DB_TX_TIMEOUT_MS,
      "DB_TX_TIMEOUT_MS",
      5_000,
      "It is how long a transaction may stay open, and how long any one of its statements may run.",
      MAX_DURATION_MS,
    ),
  },
  // NOTE: Postgres `lock_timeout` on the main, checkpointer and metrics pools: a statement waiting on
  // a lock past it fails (55P03) and gives its connection back. 0 turns it off.
  dbLockTimeoutMs: parseIntSetting(
    DB_LOCK_TIMEOUT_MS,
    "DB_LOCK_TIMEOUT_MS",
    5_000,
    "It is how long a statement may wait on a lock; 0 turns the limit off.",
    MAX_DURATION_MS,
    0,
  ),
  // NOTE: Background work (src/lib/pool-class.ts: the scheduler's background kinds, follow-ups and
  // reminders, sweeps, flow-log retention, memory compaction, the observer and syncs among them, and
  // outbound webhook and alert delivery) runs on a pool of its own, so a burst of it, or its
  // transactions stuck behind a lock, cannot take the connections a customer reply needs. A flow-log
  // line is written on the pool of the work that emits it.
  backgroundPoolMax: parseIntSetting(
    BACKGROUND_POOL_MAX,
    "BACKGROUND_POOL_MAX",
    10,
    "It sizes the Postgres pool background work runs on: scheduled follow-ups and reminders, sweeps, flow-log retention, memory compaction, the observer, syncs, and outbound webhook and alert delivery.",
    MAX_COUNT,
  ),
  // NOTE: The console's metrics reads (src/modules/analytics) run on a pool of their own, so a
  // dashboard load cannot take the connections turns need. `timeoutMs` bounds the wait for one of
  // its connections and the run of each request's transaction and statements.
  metrics: {
    poolMax: parseIntSetting(
      METRICS_POOL_MAX,
      "METRICS_POOL_MAX",
      3,
      "It sizes the Postgres pool the metrics screen and the MCP metrics tools read through.",
      MAX_COUNT,
    ),
    timeoutMs: parseIntSetting(
      METRICS_TIMEOUT_MS,
      "METRICS_TIMEOUT_MS",
      15_000,
      "It is how long a metrics request may take, waiting for a connection and running, before it is refused.",
      MAX_DURATION_MS,
    ),
  },
  // NOTE: The Chatwoot receiver's two budgets (docs/chatwoot.md "Webhook receiver").
  // `deliveryConcurrency` is how many acked deliveries are processed at once in each of two lanes
  // (customer messages, and every other event so a takeover never waits behind turns); the rest wait
  // as ledger rows, so a burst costs latency rather than `maxWait` failures. Raise it with the pool.
  // `ackPoolMax` sizes the small pool the ack writes through, so a drained main pool cannot turn the
  // ack into a 500 (which Chatwoot answers by opening the conversation).
  chatwoot: {
    deliveryConcurrency: parseIntSetting(
      CHATWOOT_DELIVERY_CONCURRENCY,
      "CHATWOOT_DELIVERY_CONCURRENCY",
      15,
      "It caps how many Chatwoot deliveries are processed at once in each lane; the rest wait in the ledger.",
      MAX_COUNT,
    ),
    ackPoolMax: parseIntSetting(
      CHATWOOT_ACK_POOL_MAX,
      "CHATWOOT_ACK_POOL_MAX",
      4,
      "It sizes the Postgres pool the Chatwoot webhook ack writes its ledger row through.",
      MAX_COUNT,
    ),
  },
  cdnUrl: CDN_URL ?? "",
  googleClientId,
  googleOAuthEnabled: googleClientId.length > 0,
  // Transactional mail. Today only the sign-in code of dashboard viewers uses it, and `enabled` is what
  // decides whether that sign-in method is offered at all.
  mail: {
    provider: mailProvider,
    enabled: mailProvider !== "none",
    from: parseMailFrom(
      MAIL_FROM,
      mailProvider === "resend" || mailProvider === "smtp",
    ),
    replyTo: (MAIL_REPLY_TO ?? "").trim() || undefined,
    resendApiKey: (RESEND_API_KEY ?? "").trim(),
    smtp: {
      host: (SMTP_HOST ?? "").trim(),
      port: smtpPort,
      secure: parseSmtpSecure(SMTP_SECURE, smtpPort),
      user: (SMTP_USER ?? "").trim(),
      password: SMTP_PASSWORD ?? "",
    },
  },
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
  // Global cap on concurrent agent model calls: the LLM round-trip in the LangGraph agent node
  // (graph.ts) plus the opt-in TTS-normalize call. Conversations drain fully in parallel (the debounce
  // worker does not serialize them); this is the ONLY throttle on model calls, applied process-wide
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
    // How long one call to an agent's own model may take, retries included, when no fallback
    // model is configured, so a provider that accepts the connection and never answers cannot hold
    // the turn. A turn with a fallback is bounded by the fallback's own ceiling instead, the agent's
    // `modelFallback.timeoutMs` or 45 s (src/graph/model-fallback.ts).
    modelCallTimeoutMs: parseIntSetting(
      AGENT_MODEL_CALL_TIMEOUT_MS,
      "AGENT_MODEL_CALL_TIMEOUT_MS",
      120_000,
      "It is how long one call to the agent's own model may take, retries included, when no fallback model is configured.",
      MAX_DURATION_MS,
    ),
    // How long a reply may wait for capacity before the operator is told: a due flush waiting
    // for a slot of a full debounce lane, or a model call waiting for a permit of the semaphore above.
    // Delay, not occupancy: a full lane that drains in seconds is healthy. The lane ticks every 2.5 s
    // and a turn takes about 10 s, so 30 s is several turns of queue.
    capacityWaitAlertMs: parseIntSetting(
      AGENT_CAPACITY_WAIT_ALERT_MS,
      "AGENT_CAPACITY_WAIT_ALERT_MS",
      30_000,
      "It is how long a reply may wait for a debounce slot or a model permit before a capacity warning is logged.",
      MAX_DURATION_MS,
    ),
    // How long a client-channel turn may stay suspended waiting for the browser's tool answers. Past
    // it, the user's next message closes the old turn with every pending call answered as an error
    // instead of being refused (docs/client-channel.md). Short: a browser answers in seconds, and a
    // turn left waiting means the tab is gone.
    clientTurnSuspendTimeoutMs: parseIntSetting(
      CLIENT_TURN_SUSPEND_TIMEOUT_MS,
      "CLIENT_TURN_SUSPEND_TIMEOUT_MS",
      120_000,
      "It is how long a client-channel turn may wait for the browser's tool answers before a new message closes it.",
      MAX_DURATION_MS,
    ),
    // Under contention the model semaphore serves replies before background calls (observation,
    // memory compaction), except that the background is served first while it holds fewer than this
    // percentage of the permits (rounded down, so a small semaphore may have no share), and once one
    // of its calls has waited `backgroundMaxWaitMs`. Without contention neither applies.
    backgroundSharePercent: parseIntSetting(
      AGENT_MODEL_BACKGROUND_SHARE_PERCENT,
      "AGENT_MODEL_BACKGROUND_SHARE_PERCENT",
      10,
      "It is the share of the model permits that observation and compaction keep under a peak of replies.",
      100,
    ),
    backgroundMaxWaitMs: parseIntSetting(
      AGENT_MODEL_BACKGROUND_MAX_WAIT_MS,
      "AGENT_MODEL_BACKGROUND_MAX_WAIT_MS",
      60_000,
      "It is how long an observation or compaction call yields its model permit to replies before it is served ahead of them.",
      MAX_DURATION_MS,
    ),
    // NOTE: Hard cap (characters) on an agent's system prompt, enforced at the service layer for
    // every transport (console/REST/MCP) and at import. A deliberate checkpoint, not a technical
    // ceiling: prompts past tens of KB usually hold knowledge-base content and degrade instruction
    // adherence. Intentionally surfaced only as a save error — no UI affordance points here.
    promptMaxChars: agentPromptMaxChars,
    // How long ONE HTTP tool call may take, headers and body together, before it is aborted.
    // Configurable because each link of the chain must be more patient than the one below it: set
    // equal to a provider's own cap, we abort first and the operator gets our generic failure instead
    // of the provider's message. 30s clears providers that cap at 15-20s; one behind a 30s cap raises
    // it. Nothing structural bounds it (no turn deadline, the Chatwoot webhook acks detached in under
    // 5s); the cost is a customer waiting, which a tool's ackMessage covers.
    httpToolTimeoutMs: parseIntSetting(
      HTTP_TOOL_TIMEOUT_MS,
      "HTTP_TOOL_TIMEOUT_MS",
      30_000,
      "It bounds every HTTP tool call: too low aborts providers that would have answered, too high leaves the customer waiting on one.",
      MAX_DURATION_MS,
    ),
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
    // The traffic-proportional kinds' drain (./modules/scheduler/lanes.ts): at most this many at
    // once, and at most `trafficPerMinute` started in any minute. Five at once is what one tick ran
    // before the drain existed; the per-minute ceiling is what bounds the CPU a backlog can take
    // from live traffic, since a lane of fast jobs at five at a time would start hundreds a minute.
    trafficConcurrency: parseIntSetting(
      SCHEDULER_TRAFFIC_CONCURRENCY,
      "SCHEDULER_TRAFFIC_CONCURRENCY",
      5,
      "It is how many recovery, ingestion and similar scheduler jobs may run at once.",
      100,
    ),
    trafficPerMinute: parseIntSetting(
      SCHEDULER_TRAFFIC_PER_MINUTE,
      "SCHEDULER_TRAFFIC_PER_MINUTE",
      120,
      "It is how many recovery, ingestion and similar scheduler jobs may start in any minute.",
      100_000,
    ),
  },
  // NOTE: The pass that deletes the checkpoint threads whose owner is gone
  // (src/graph/checkpoint-reconcile.ts). It rides with the scheduler worker, so it runs where the
  // scheduler runs. Operational knobs, not settings anyone tunes per tenant.
  checkpointReconcile: {
    intervalMs: parseIntSetting(
      CHECKPOINT_RECONCILE_INTERVAL_MS,
      "CHECKPOINT_RECONCILE_INTERVAL_MS",
      6 * 60 * 60 * 1000,
      "It is how often the checkpoints of threads whose owner is gone are deleted.",
      MAX_DURATION_MS,
    ),
    firstDelayMs: parseIntSetting(
      CHECKPOINT_RECONCILE_FIRST_DELAY_MS,
      "CHECKPOINT_RECONCILE_FIRST_DELAY_MS",
      10 * 60 * 1000,
      "It is how long after the boot the first pass over orphaned checkpoints runs.",
      MAX_DURATION_MS,
    ),
    graceMs: parseIntSetting(
      CHECKPOINT_RECONCILE_GRACE_MS,
      "CHECKPOINT_RECONCILE_GRACE_MS",
      60 * 60 * 1000,
      "It is how old a thread's newest checkpoint must be before the thread can be deleted for having no owner.",
      MAX_DURATION_MS,
    ),
  },
  // NOTE: The scheduler's FAST drain for OBSERVE jobs only (a monitoring agent's turn on a
  // conversation it watches). A verdict that waits a whole scheduler interval reaches a conversation
  // that has already moved on, so due observations are claimed at this cadence instead. It has no
  // switch of its own: it starts and stops with the scheduler worker, under the same single-replica
  // discipline, and it runs inside the scheduler's provider concurrency. Operational, NOT a
  // per-agent setting; the per-agent burst window lives on the agent, and may be shorter than this
  // interval (down to 0): the row a message arms is started at its own instant by the arming
  // process, and this interval is what finds a row armed by another process or left by a restart.
  observeWorker: {
    intervalMs: parseIntSetting(
      OBSERVE_WORKER_INTERVAL_MS,
      "OBSERVE_WORKER_INTERVAL_MS",
      2_500,
      "It is how often the scheduler claims due observations of monitoring agents.",
      MAX_DURATION_MS,
      // A claim is a query. Below this the interval is no longer the safety net it is (the row a
      // message arms is started by its own wake-up, `wakeObserveDrainAt`), only load.
      100,
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
    // How many turns the lane runs at once. Unset (null) it follows the model permits at a multiple,
    // read through `debounceTurnSlots`.
    slots: DEBOUNCE_TURN_SLOTS?.trim()
      ? parseIntSetting(
          DEBOUNCE_TURN_SLOTS,
          "DEBOUNCE_TURN_SLOTS",
          1,
          "It is how many customer turns the debounce lane runs at once.",
          MAX_COUNT,
        )
      : (null as number | null),
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
  // How long SIGTERM/SIGINT waits for the work already running before cutting it and exiting
  // (src/lib/shutdown.ts). The exit lands at most CUT_SETTLE_MS (1.5s) after it, so it must stay below
  // the orchestrator's stop grace period minus that: Docker's default grace is 10s.
  shutdown: {
    drainMs: parseIntSetting(
      SHUTDOWN_DRAIN_MS,
      "SHUTDOWN_DRAIN_MS",
      7_000,
      "It is how long shutdown waits for running turns, and it must fit inside the container's stop grace period.",
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
  // Cadence of the per-tenant `SPEND_CEILING_POLL` scheduler job while the ceiling is on: how often
  // a tenant's month-to-date cost is summed from the local ledger into the snapshot the spend
  // ceiling's gate reads. It is the overshoot bound an operator accepts by leaving it. Default 1 min:
  // the sum is one indexed query per tenant.
  spendCeiling: {
    pollIntervalMs: parseIntSetting(
      SPEND_CEILING_POLL_INTERVAL_MS,
      "SPEND_CEILING_POLL_INTERVAL_MS",
      60_000,
      "It is how often a tenant's month-to-date cost is summed from the usage ledger for the spend ceiling.",
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
    // NOTE: How long one cause (a provider refusing the account, the spend ceiling, a channel error, a
    // dead letter) stays one alert per channel: later events with the same cause bump that delivery's
    // count instead of opening another. Long on purpose, since the cause lasts until someone fixes it.
    causeWindowMs: parseIntSetting(
      ALERT_CAUSE_WINDOW_MS,
      "ALERT_CAUSE_WINDOW_MS",
      10_800_000,
      "It is how long one cause stays one alert per channel; later events with the same cause are counted on it.",
      MAX_DURATION_MS,
    ),
    // NOTE: A provider degraded by transient failures (timeouts, 5xx, 429) that retries recover: one
    // alert when this many failures of one stage and provider land within the window, then again once
    // the window has passed while it stays degraded.
    rateThreshold: parseIntSetting(
      ALERT_RATE_THRESHOLD,
      "ALERT_RATE_THRESHOLD",
      5,
      "It is how many transient failures of one stage and provider within ALERT_RATE_WINDOW_MS make a rate alert.",
      MAX_COUNT,
    ),
    rateWindowMs: parseIntSetting(
      ALERT_RATE_WINDOW_MS,
      "ALERT_RATE_WINDOW_MS",
      900_000,
      "It is the window ALERT_RATE_THRESHOLD counts transient failures over.",
      MAX_DURATION_MS,
    ),
    // NOTE: Stranded deliveries that a recovery or a later turn took care of, with nothing left for a
    // person: none pages alone, and this many within the window make one alert, because a healthy
    // instance strands almost none and a run of them means something is stranding deliveries.
    recoveryThreshold: parseIntSetting(
      ALERT_RECOVERY_THRESHOLD,
      "ALERT_RECOVERY_THRESHOLD",
      3,
      "It is how many recovered stranded deliveries within ALERT_RECOVERY_WINDOW_MS make one alert.",
      MAX_COUNT,
    ),
    recoveryWindowMs: parseIntSetting(
      ALERT_RECOVERY_WINDOW_MS,
      "ALERT_RECOVERY_WINDOW_MS",
      3_600_000,
      "It is the window ALERT_RECOVERY_THRESHOLD counts recovered stranded deliveries over.",
      MAX_DURATION_MS,
    ),
    // NOTE: A stranded message a later turn did answer still pages on its own when the answer came
    // this long after the message arrived: the customer waited, and that is worth a look.
    lateReplyAgeMs: parseIntSetting(
      ALERT_LATE_REPLY_AGE_MS,
      "ALERT_LATE_REPLY_AGE_MS",
      1_800_000,
      "It is how late an answer to a stranded message has to be to alert on its own.",
      MAX_DURATION_MS,
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
  // The client channel (docs/client-channel.md): an agent embedded in a host application, through
  // `POST /v1/agents/:id/client/turn`. Off by default while it is tried with its first host: off, the
  // route answers 404, it is left out of the API reference, and the console shows no client source.
  // `sdk` bounds the browser-facing turn (`POST /v1/sdk/:app/turn`), where no host server stands in
  // front: requests per minute per signed-in user of an app, and per app. A guard against abuse,
  // kept in memory like the other limiters (single replica).
  clientChannel: {
    enabled: CLIENT_CHANNEL_ENABLED === "true",
    sdk: {
      userPerMin: parseIntSetting(
        CLIENT_CHANNEL_SDK_USER_PER_MIN,
        "CLIENT_CHANNEL_SDK_USER_PER_MIN",
        30,
        "It bounds the requests one signed-in user of an embedding app makes per minute.",
        10_000,
      ),
      appPerMin: parseIntSetting(
        CLIENT_CHANNEL_SDK_APP_PER_MIN,
        "CLIENT_CHANNEL_SDK_APP_PER_MIN",
        600,
        "It bounds the requests all users of one embedding app make per minute.",
        100_000,
      ),
    },
  },
  // Corrupted-audio check for synthesized replies (docs/tts.md "Checking the audio"). The
  // detector is deployment-level: infrastructure the operator runs next to this service, like the
  // database, so its address and token stay here. Empty URL = off. `mode` is the DEFAULT for an agent
  // that never chose one; an agent's own `settings.tts.checkMode` applies only while a URL is set.
  ttsCheck: {
    url: ttsCheckUrl,
    mode: parseTtsCheckMode(TTS_CHECK_MODE, ttsCheckUrl),
    token: (TTS_CHECK_TOKEN ?? "").trim(),
    timeoutMs: parseIntSetting(
      TTS_CHECK_TIMEOUT_MS,
      "TTS_CHECK_TIMEOUT_MS",
      30_000,
      "It bounds one call to the audio detector: in enforce mode the reply waits on it, so too high leaves the customer waiting and too low gives up on a detector that would have answered.",
      MAX_DURATION_MS,
    ),
  },
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
    // The internal services an HTTP tool may reach with the guard ON. Read only by the
    // HTTP tool, and there only when the tool's own allowedHosts names the host. See src/lib/ssrf.ts.
    internalTargets: parseInternalTargets(
      SSRF_INTERNAL_TARGETS,
      "SSRF_INTERNAL_TARGETS",
    ),
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
  // Per-client rate-limit ceilings (requests/minute). These are runaway guards, NOT tight
  // throttles: navigating the console fires dozens of parallel reads, and one MCP client funnels
  // every tool call through a single address, so the buckets must be generous. CAVEAT: everyone
  // behind one NAT counts against the same bucket. The static (1000/min) and DCR (10/min) limits are
  // fixed in the middleware. The credential budget is deliberately NOT per-minute: 10/min is 600
  // password guesses an hour, while 20 per 5 minutes is 240 and still absorbs an office behind one NAT.
  rateLimit: {
    userPerMin: parseIntSetting(
      RATE_LIMIT_USER_PER_MIN,
      "RATE_LIMIT_USER_PER_MIN",
      600,
      "It is the ceiling every request that is not static, MCP transport or a webhook delivery counts against.",
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

// `elysia-rate-limit` registers itself as an Elysia plugin seeded with `max:duration:scoping`, so any
// two of the limiters mounted in src/app.ts that share all three are deduplicated by Elysia and the
// later one silently never mounts (no `RateLimit-*` header, nothing logged). This throws rather than
// warns because a collision never tightens anything: it deletes the losing limiter's bucket.
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

if (config.mail.provider === "resend" && !config.mail.resendApiKey) {
  throw new Error("MAIL_PROVIDER=resend needs RESEND_API_KEY.");
}
if (config.mail.provider === "smtp" && !config.mail.smtp.host) {
  throw new Error("MAIL_PROVIDER=smtp needs SMTP_HOST.");
}
// The console transport prints every message, sign-in codes included, into the log. In production that
// hands a viewer session to anyone who can read the logs.
if (config.mail.provider === "console" && config.env === "production") {
  throw new Error(
    "MAIL_PROVIDER=console prints sign-in codes into the log and is refused in production. Configure Resend or SMTP, or set MAIL_PROVIDER=none to disable mail.",
  );
}
// The in-memory outbox only exists for the test suite.
if (config.mail.provider === "memory" && config.env !== "test") {
  throw new Error("MAIL_PROVIDER=memory is only available to the test suite.");
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

// Turn slots per model permit when DEBOUNCE_TURN_SLOTS is unset. A slot is held for the whole turn
// (history, tools, the reply, the flow log) and a permit only for the model call inside it, so a lane
// sized at the permits fills while the semaphore sits idle. Twice keeps the semaphore fed without
// letting a lane of slow turns open far more database work than the permits would; past the
// turn-to-call ratio the extra slots only queue on the semaphore (docs/deploy.md).
export const TURN_SLOTS_PER_PERMIT = 2;

// The debounce lane's size: the explicit setting, else the permits times the multiple above, capped
// where every count is so the largest accepted permit count still boots.
export function debounceTurnSlots(c: typeof config = config): number {
  return (
    c.debounceWorker.slots ??
    Math.min(c.agent.modelConcurrency * TURN_SLOTS_PER_PERMIT, MAX_COUNT)
  );
}

export default config;
