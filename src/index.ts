import { initSetupState } from "@/api/features/auth/setup.service";
import { setPublisher } from "@/api/features/realtime/realtime.service";
import logger, { deepSanitizeObject } from "@/api/lib/logger";
import app from "@/app";
import config from "@/config";
import {
  assertRuntimeRoleIsNotSuperuser,
  SuperuserRuntimeError,
} from "@/lib/db-guard";
import { registerAppointmentReminderHandler } from "@/modules/appointments/reminders";
import { registerRedirectFollowUpHandlers } from "@/modules/channel-redirect/followup";
import {
  ensureAllDeliverySweeps,
  registerDeliverySweepHandler,
} from "@/modules/chatwoot/delivery-sweep";
import { registerDebounceHandler } from "@/modules/debounce/handler";
import {
  startDebounceWorker,
  stopDebounceWorker,
} from "@/modules/debounce/worker";
import {
  startAlertWorker,
  stopAlertWorker,
} from "@/modules/flowlog/alert-worker";
import {
  ensureAllFlowlogSweeps,
  registerFlowlogRetentionHandler,
} from "@/modules/flowlog/retention";
import {
  ensureAllTenantSweeps,
  registerFollowUpHandlers,
} from "@/modules/followups/handlers";
import { registerMemoryHandlers } from "@/modules/memory/compact";
import {
  startCompactionWorker,
  stopCompactionWorker,
} from "@/modules/memory/worker";
import { registerRagIngestHandler } from "@/modules/rag/documents";
import { startScheduler, stopScheduler } from "@/modules/scheduler/worker";
import { registerHeartbeatHandler } from "@/modules/webhooks/outbound/heartbeat";
import {
  startOutboundWorker,
  stopOutboundWorker,
} from "@/modules/webhooks/outbound/worker";

const MAX_PORT_ATTEMPTS = 10;

// NOTE: Postgres 42501 (insufficient_privilege) surfaces nested inside Prisma's
// DriverAdapterError; walk the cause chain instead of trusting one shape.
function isPermissionDenied(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; cause?: unknown };
    if (e.code === "42501") return true;
    current = e.cause;
  }
  return false;
}

let port = config.port;

// NOTE: Everything that needs the bound server runs in the listen callback,
// never via a synchronous `app.server` read after `app.listen()`. Under
// `bun --hot` the underlying server is reused and `app.server` is (re)assigned
// on a later tick, so a synchronous read races and yields `undefined:undefined`
// for host/port and a silently-unwired publisher. The callback fires once the
// server is actually bound, on both cold start and hot reload.
for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
  try {
    app.listen(port, (server) => {
      // Wire the realtime service's publisher to the underlying Bun server's
      // `publish(topic, data)`. Realtime topic broadcasts (chat, presence,
      // per-user push) flow through this; without it they silently no-op.
      setPublisher((topic, data) => server.publish(topic, data));
      logger.info(
        `${config.packageInfo.name}@${config.packageInfo.version} running on http://${server.hostname}:${server.port}`,
      );
    });
    break;
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS - 1) {
      logger.warn("Port %d is in use, trying %d...", port, port + 1);
      port++;
      continue;
    }
    throw error;
  }
}

// NOTE: Fail fast if the runtime DB role can bypass RLS — isolation rests on it. A privileged
// role hard-crashes the process (correct: crash-loop until the URL is fixed); a DB-unavailable
// error only warns, since initSetupState below already tolerates a boot-time outage.
try {
  await assertRuntimeRoleIsNotSuperuser();
} catch (error) {
  if (error instanceof SuperuserRuntimeError) throw error;
  logger.warn(
    { error },
    "Could not verify the runtime DB role (DB unavailable?); continuing",
  );
}

if (config.env === "production" && config.ssrf.allowPrivateTargets) {
  logger.warn(
    "SSRF guard relaxed in production — internal addresses accessible to operators; disable SSRF_ALLOW_PRIVATE_TARGETS",
  );
}

logger.info(
  "Loaded config %s",
  JSON.stringify(
    deepSanitizeObject(
      { ...config, port },
      {
        omitKeys: [
          "apiKey",
          "secret",
          "jwtSecret",
          "encryptionKey",
          "databaseUrl",
          "mcpJwtSecret",
          "langgraphDatabaseUrl",
        ],
      },
    ),
    null,
    2,
  ),
);

// NOTE: Resolve first-run setup state once at boot (logs the setup URL/token
// when no users exist). Called explicitly here rather than via app.onStart so
// `bun --hot` reloads don't re-run it and regenerate the token. Tolerant of a
// DB outage: setup stays "required" and the atomic insert still guards it.
try {
  await initSetupState();
} catch (error) {
  if (isPermissionDenied(error)) {
    logger.error(
      { error },
      "Runtime role has no grants on the database (permission denied). This happens after " +
        "`prisma migrate reset` / a `migrate dev` reset, which drop the schema and its grants. " +
        "Fix: run `bun db:bootstrap` and restart (or use `bun db:reset` next time).",
    );
  } else {
    logger.warn({ error }, "Failed to initialize first-run setup state");
  }
}

// NOTE: Outbound webhook delivery worker. Single-replica by construction (reentrancy guard +
// interval); when scaling beyond one replica this needs a leader election or durable claim.
// Started here (not app.onStart) so `bun --hot` reloads don't stack timers, and the worker
// state is held on globalThis so a reload reuses the existing one.
if (config.webhookWorker.enabled) {
  startOutboundWorker();
}

// NOTE: Follow-up/sweep scheduler. Same single-replica discipline as the outbound worker. Handlers
// are registered before the worker starts so a claimed job always has a handler.
if (config.schedulerWorker.enabled) {
  registerFollowUpHandlers();
  registerRagIngestHandler();
  registerHeartbeatHandler();
  registerFlowlogRetentionHandler();
  registerAppointmentReminderHandler();
  registerRedirectFollowUpHandlers();
  registerMemoryHandlers();
  registerDeliverySweepHandler();
  startScheduler();
  // Arm the per-tenant execution-log retention sweep for every existing tenant (best-effort: a
  // boot-time DB outage just means the sweep arms on the next restart).
  void ensureAllFlowlogSweeps().catch((error) =>
    logger.warn({ error }, "Failed to arm flowlog retention sweeps"),
  );
  // Arm the per-tenant follow-up sweep for every existing tenant so follow-ups self-heal after the
  // sweep's row is lost (DB reset, external truncate). Same best-effort discipline as above.
  void ensureAllTenantSweeps().catch((error) =>
    logger.warn({ error }, "Failed to arm follow-up sweeps"),
  );
  // Arm the per-tenant recovery sweep for Chatwoot deliveries stranded on PROCESSING (issue #228).
  // A deploy is both the thing that strands them and the thing that runs this, so the boot arm is
  // what makes the recovery reach the rows the restart itself created.
  void ensureAllDeliverySweeps().catch((error) =>
    logger.warn({ error }, "Failed to arm Chatwoot delivery sweeps"),
  );
}

// NOTE: External alert delivery worker (execution-flow warnings/errors → Discord / webhook).
// Single-replica discipline (globalThis singleton + reentrancy guard); off on extra replicas.
if (config.alertWorker.enabled) {
  startAlertWorker();
}

// NOTE: Dedicated fast worker for DEBOUNCE jobs (inbound message coalescing). Separate cadence from
// the scheduler; same single-replica discipline. The handler is registered before the worker starts
// so a claimed debounce job always has a handler.
if (config.debounceWorker.enabled) {
  registerDebounceHandler();
  startDebounceWorker();
}

// NOTE: Dedicated worker for MEMORY_COMPACT jobs (attendance compaction). The mirror image of the
// debounce lane: not fast, but long — a summary is a model call with a 60s ceiling, and compaction
// fires for every agent on every closed attendance, so on the scheduler's serial lane a batch of
// them would delay the jobs a customer feels. `registerMemoryHandlers` is idempotent, so registering
// it here as well is what keeps a claimed job from landing without a handler when the scheduler
// itself is disabled.
if (config.compactionWorker.enabled) {
  registerMemoryHandlers();
  startCompactionWorker();
}

// NOTE: reached through the EventEmitter surface because `process.on("SIGTERM", …)` no longer
// type-checks. @types/node 25 declares `Process extends InternalEventEmitter<ProcessEventMap>`, so
// the signal handlers are INHERITED from an event map rather than declared as overloads, and
// bun-types 1.4.0 augments `NodeJS.Process` with an explicit `on(event: "memoryPressure", …)`. A
// member declared on the interface shadows the inherited one, so `on` narrows to "memoryPressure"
// alone. Measured against this tsconfig: the literal call, `node:process`, a `NodeJS.Signals` cast,
// `addListener` and `once` all fail; only the EventEmitter surface compiles. Upstream bug in
// bun-types, not in this code — drop the cast once it declares these as overloads.
const processEvents = process as NodeJS.EventEmitter;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  processEvents.on(signal, () => {
    stopOutboundWorker();
    stopScheduler();
    stopDebounceWorker();
    stopCompactionWorker();
    stopAlertWorker();
    process.exit(0);
  });
}
