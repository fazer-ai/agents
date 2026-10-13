import { initSetupState } from "@/api/features/auth/setup.service";
import { setPublisher } from "@/api/features/realtime/realtime.service";
import logger, { configForBootLog } from "@/api/lib/logger";
import ackPrisma from "@/api/lib/prisma-ack";
import app from "@/app";
import config from "@/config";
import { assertConnectionBudget } from "@/lib/db-budget";
import { checkRuntimeRoleAtBoot } from "@/lib/db-guard";
import { releaseProcessLease, startProcessLease } from "@/lib/process-lease";
import { installShutdownHandlers } from "@/lib/shutdown";
import { registerAppointmentReminderHandler } from "@/modules/appointments/reminders";
import { registerRedirectFollowUpHandlers } from "@/modules/channel-redirect/followup";
import { drainStoredChatwootDeliveries } from "@/modules/chatwoot/delivery-queue";
import {
  ensureAllDeliverySweeps,
  registerDeliverySweepHandler,
  startDeadClaimSweep,
  stopDeadClaimSweep,
} from "@/modules/chatwoot/delivery-sweep";
import {
  ensureAllReconcileSweeps,
  registerReconcileSweepHandler,
} from "@/modules/chatwoot/reconcile-sweep";
import { registerDeliveryRecoveryHandler } from "@/modules/chatwoot/recover-delivery";
import { registerHumanReplyRecoveryHandler } from "@/modules/chatwoot/recover-human-reply";
import { registerTakeoverRecoveryHandler } from "@/modules/chatwoot/recover-takeover";
import { enableRouteTokenRewarm } from "@/modules/chatwoot/webhook";
import { registerDebounceHandler } from "@/modules/debounce/handler";
import {
  startDebounceWorker,
  stopDebounceWorker,
} from "@/modules/debounce/worker";
import { registerDocumentApprovalExpiryHandler } from "@/modules/documents/approval";
import { registerDocumentApprovalOutcomeHandler } from "@/modules/documents/approval-outcome";
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
import {
  startInstanceHealthSampler,
  stopInstanceHealthSampler,
} from "@/modules/instance-health/sampler";
import { registerMemoryHandlers } from "@/modules/memory/compact";
import {
  startCompactionWorker,
  stopCompactionWorker,
} from "@/modules/memory/worker";
import { registerObserveHandler } from "@/modules/observe/job";
import { registerOtherInboxSummaryHandler } from "@/modules/other-inboxes/summary-job";
import { registerRagIngestHandler } from "@/modules/rag/documents";
import {
  ensureAllKnowledgeSourceSyncs,
  registerKnowledgeSourceHandler,
} from "@/modules/rag/source";
import { registerSuggestionReviewHandler } from "@/modules/rag/suggestion-review";
import { startScheduler, stopScheduler } from "@/modules/scheduler/worker";
import { ensureAllSpendPolls } from "@/modules/spend-ceiling/arm";
import { registerSpendPollHandler } from "@/modules/spend-ceiling/poll";
import {
  ensureAllInboundSweeps,
  registerInboundSweepHandlers,
} from "@/modules/webhooks/inbound/sweep";
import { registerHeartbeatHandler } from "@/modules/webhooks/outbound/heartbeat";
import {
  startOutboundWorker,
  stopOutboundWorker,
} from "@/modules/webhooks/outbound/worker";

const MAX_PORT_ATTEMPTS = 10;

// Postgres 42501 (insufficient_privilege) surfaces nested inside Prisma's
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

// NOTE: Fail fast, before the port is bound, when this replica's pools can open more connections than
// a database server accepts (src/lib/db-budget.ts). A server that does not answer only warns, like
// the runtime role check below, and does not hide another server's refusal.
for (const { line, checked } of await assertConnectionBudget()) {
  if (checked) logger.info("Connection budget %s", line);
  else logger.warn("Connection budget %s (DB unavailable?); continuing", line);
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

// NOTE: Fail fast if the runtime DB connection cannot uphold isolation; an outage only warns
// (src/lib/db-guard.ts, checkRuntimeRoleAtBoot).
await checkRuntimeRoleAtBoot();

if (config.env === "production" && config.ssrf.allowPrivateTargets) {
  logger.warn(
    "SSRF guard relaxed in production — internal addresses accessible to operators; disable SSRF_ALLOW_PRIVATE_TARGETS",
  );
}

logger.info(
  "Loaded config %s",
  JSON.stringify(configForBootLog({ ...config, port }), null, 2),
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
  registerOtherInboxSummaryHandler();
  registerObserveHandler();
  registerSuggestionReviewHandler();
  registerDocumentApprovalExpiryHandler();
  registerDocumentApprovalOutcomeHandler();
  registerDeliverySweepHandler();
  registerReconcileSweepHandler();
  registerDeliveryRecoveryHandler();
  registerTakeoverRecoveryHandler();
  registerHumanReplyRecoveryHandler();
  registerSpendPollHandler();
  registerKnowledgeSourceHandler();
  registerInboundSweepHandlers();
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
  // NOTE: Arm the per-tenant recovery sweep for Chatwoot deliveries stranded on PROCESSING. A deploy
  // both strands them and runs this, so the boot arm is what reaches the rows the restart created.
  void ensureAllDeliverySweeps().catch((error) =>
    logger.warn({ error }, "Failed to arm Chatwoot delivery sweeps"),
  );
  // NOTE: Arm the per-tenant reconciliation from Chatwoot: what an outage kept from reaching the ledger
  // is found by reading Chatwoot, and a boot is when an outage has just ended.
  void ensureAllReconcileSweeps().catch((error) =>
    logger.warn({ error }, "Failed to arm Chatwoot reconcile sweeps"),
  );
  // NOTE: Arm the per-tenant sweep for inbound deliveries stranded between the ack and the dispatch,
  // for every tenant with an inbound surface: a deploy strands them too.
  void ensureAllInboundSweeps().catch((error) =>
    logger.warn({ error }, "Failed to arm inbound delivery sweeps"),
  );
  // NOTE: Each knowledge source gets its perpetual sync row back, due one interval out.
  void ensureAllKnowledgeSourceSyncs().catch((error) =>
    logger.warn({ error }, "Failed to arm knowledge source syncs"),
  );
  // NOTE: Arm the spend ceiling poll for every tenant whose ceiling is on, so a row lost to a reset
  // is not a ceiling deciding on a figure frozen at its last poll.
  void ensureAllSpendPolls().catch((error) =>
    logger.warn({ error }, "Failed to arm spend ceiling polls"),
  );
}

// NOTE: External alert delivery worker (execution-flow warnings/errors → Discord / webhook).
// Single-replica discipline (globalThis singleton + reentrancy guard); off on extra replicas.
if (config.alertWorker.enabled) {
  startAlertWorker();
  // NOTE: The instance health sampler rides the same flag: it is what enqueues instance alerts, and
  // two replicas sampling would alert twice.
  void startInstanceHealthSampler().catch((error) =>
    logger.warn({ error }, "Failed to start the instance health sampler"),
  );
}

// NOTE: Dedicated fast worker for DEBOUNCE jobs (inbound message coalescing). Separate cadence from
// the scheduler; same single-replica discipline. The handler is registered before the worker starts
// so a claimed debounce job always has a handler.
if (config.debounceWorker.enabled) {
  registerDebounceHandler();
  startDebounceWorker();
}

// NOTE: Dedicated worker for MEMORY_COMPACT and OTHER_INBOX_SUMMARY jobs (summaries). The mirror image of the
// debounce lane: not fast, but long — a summary is a model call with a 60s ceiling, and compaction
// fires for every agent on every closed attendance, so on the scheduler's serial lane a batch of
// them would delay the jobs a customer feels. `registerMemoryHandlers` is idempotent, so registering
// it here as well is what keeps a claimed job from landing without a handler when the scheduler
// itself is disabled.
if (config.compactionWorker.enabled) {
  registerMemoryHandlers();
  registerOtherInboxSummaryHandler();
  startCompactionWorker();
}

// NOTE: The Chatwoot deliveries a previous process acked and never got to: a customer message goes to
// the delivery recovery now, any other event is processed from the body its row stored. Every replica
// serves the webhook, so this runs whatever the worker flags; a row another live replica still holds
// goes to whichever CAS lands first, and the loser skips.
void drainStoredChatwootDeliveries({ minAgeMs: 0 }).catch((error) =>
  logger.warn({ error }, "Failed to drain stored Chatwoot deliveries"),
);

// NOTE: This process's lease, renewed on the ack's pool so a drained main pool cannot make a live
// process look dead, and the pass that settles what a dead process claimed. Every replica
// runs both: a web replica's death is found by the leader, the leader's by whatever starts next.
void startProcessLease(ackPrisma)
  .catch((error) => logger.warn({ error }, "Failed to start the process lease"))
  .finally(() => startDeadClaimSweep());

// A full route-token cache invalidation looks the dropped tokens up again, so a bot nobody retired
// keeps an entry to serve if the lookup starts failing (src/modules/chatwoot/route-token-cache.ts).
enableRouteTokenRewarm();

// SIGTERM/SIGINT stop the lanes, drain the work in flight up to SHUTDOWN_DRAIN_MS, then exit.
installShutdownHandlers({
  stop: () => {
    stopOutboundWorker();
    stopScheduler();
    stopDebounceWorker();
    stopCompactionWorker();
    stopAlertWorker();
    stopDeadClaimSweep();
    stopInstanceHealthSampler();
  },
  boundMs: config.shutdown.drainMs,
  // The lease goes last, after the drain: what this process still holds will not finish, and deleting
  // the lease lets another process settle it at its next pass instead of a lease's lifetime later.
  exit: (code) => {
    void releaseProcessLease().finally(() => process.exit(code));
  },
});
