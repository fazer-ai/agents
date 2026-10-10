import { registerAppointmentReminderHandler } from "@/modules/appointments/reminders";
import { registerRedirectFollowUpHandlers } from "@/modules/channel-redirect/followup";
import { registerDeliverySweepHandler } from "@/modules/chatwoot/delivery-sweep";
import { registerDeliveryRecoveryHandler } from "@/modules/chatwoot/recover-delivery";
import { registerHumanReplyRecoveryHandler } from "@/modules/chatwoot/recover-human-reply";
import { registerTakeoverRecoveryHandler } from "@/modules/chatwoot/recover-takeover";
import { registerDebounceHandler } from "@/modules/debounce/handler";
import { registerFlowlogRetentionHandler } from "@/modules/flowlog/retention";
import { registerFollowUpHandlers } from "@/modules/followups/handlers";
import { registerMemoryHandlers } from "@/modules/memory/compact";
import { registerObserveHandler } from "@/modules/observe/job";
import { registerRagIngestHandler } from "@/modules/rag/documents";
import { registerKnowledgeSourceHandler } from "@/modules/rag/source";
import { registerSuggestionReviewHandler } from "@/modules/rag/suggestion-review";
import { JOB_DELETE_ON_DONE } from "@/modules/scheduler/lanes";
import { getDeadLetterHandler } from "@/modules/scheduler/worker";
import { registerSpendPollHandler } from "@/modules/spend-ceiling/poll";
import { registerInboundSweepHandlers } from "@/modules/webhooks/inbound/sweep";
import { registerHeartbeatHandler } from "@/modules/webhooks/outbound/heartbeat";

// Every registration the boot runs, in a process of its own: the registries are process-global, and
// a test file that installed every production handler would change what the next file sees.
registerFollowUpHandlers();
registerRagIngestHandler();
registerHeartbeatHandler();
registerFlowlogRetentionHandler();
registerAppointmentReminderHandler();
registerRedirectFollowUpHandlers();
registerMemoryHandlers();
registerObserveHandler();
registerSuggestionReviewHandler();
registerDeliverySweepHandler();
registerDeliveryRecoveryHandler();
registerTakeoverRecoveryHandler();
registerHumanReplyRecoveryHandler();
registerSpendPollHandler();
registerKnowledgeSourceHandler();
registerInboundSweepHandlers();
registerDebounceHandler();

const kinds = Object.keys(JOB_DELETE_ON_DONE);
console.log(
  JSON.stringify({
    hooked: kinds.filter((k) => getDeadLetterHandler(k)).sort(),
    deleteOnDone: kinds.filter(
      (k) => JOB_DELETE_ON_DONE[k as keyof typeof JOB_DELETE_ON_DONE],
    ),
  }),
);
process.exit(0);
