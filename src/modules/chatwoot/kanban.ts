import type { ChatwootClient } from "@/modules/chatwoot/client";

// The Chatwoot Pro kanban context for a conversation's card: which board/step it sits in now, the
// board's steps (name → id, plus the operator's per-step note) so kanban_move_card can take a STEP
// NAME (the agent can't know ids), and a best-effort snapshot of the card's own data (title, value,
// priority, status, custom attributes) so the agent SEES the funnel state instead of being blind.
// Resolved at turn prep (network, outside any tx). Shapes confirmed against the Pro fork jbuilders
// (fazer_ai/app/views/api/v1/accounts/kanban/{tasks/_task,board_steps/_board_step}.json.jbuilder).

export interface KanbanStep {
  id: number;
  name: string;
  // The operator's per-step note in Chatwoot (≤120 chars), if set — explains what the step means.
  // This is the "dedicated description of the funnel steps" surfaced to the agent automatically.
  description?: string;
  // A cancelled step is a lost/dropped bucket (not forward progress); flag it so the agent knows.
  cancelled?: boolean;
}

// Best-effort snapshot of the card's current data. Any field is null/empty when absent on the fork
// payload (older fork build, unset field) — the loader never throws on a missing field.
export interface KanbanCard {
  title: string | null;
  // Card description + scheduled dates (ISO 8601 strings from the fork payload). Surfaced so the agent
  // sees the current values before a partial update via update_kanban_task. null when unset/absent.
  description: string | null;
  priority: string | null;
  status: string | null;
  value: number | null;
  startDate: string | null;
  dueDate: string | null;
  attributes: Record<string, unknown>;
  // Current labels on the card (from `task.labels` = cached_label_list_array). Read by set_labels
  // (scope 'task') to append idempotently. Empty when the fork build predates task labels.
  labels: string[];
}

export interface KanbanContext {
  taskId: number;
  boardId: number | null;
  boardName: string | null;
  currentStepId: number | null;
  currentStepName: string | null;
  steps: KanbanStep[];
  card: KanbanCard;
}

// Board steps change rarely → cache per board (mirrors handoff/targets + vocab TTL). The task/card
// lookup itself is per-conversation, so it is NOT cached (a card moves between turns).
const STEPS_TTL_MS = 60_000;
const stepsCache = new Map<string, { value: KanbanStep[]; expires: number }>();

// The fork's board_steps#index wraps the array under `steps`; older shapes used `payload` or a bare
// array. Accept all three so a shape drift never silently empties the step list.
function unwrapArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.steps)) return o.steps;
    if (Array.isArray(o.payload)) return o.payload;
  }
  return [];
}

function parseSteps(raw: unknown): KanbanStep[] {
  const out: KanbanStep[] = [];
  for (const item of unwrapArray(raw)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = Number(o.id);
    const name = o.name;
    if (Number.isInteger(id) && id > 0 && typeof name === "string") {
      const step: KanbanStep = { id, name };
      if (typeof o.description === "string" && o.description.trim()) {
        step.description = o.description.trim();
      }
      if (o.cancelled === true) step.cancelled = true;
      out.push(step);
    }
  }
  return out;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function plainAttributes(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

async function loadBoardSteps(
  client: ChatwootClient,
  cacheKey: string,
  boardId: number,
  now: number,
): Promise<KanbanStep[]> {
  const key = `${cacheKey}:${boardId}`;
  const hit = stepsCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const steps = parseSteps(await client.listKanbanSteps(boardId));
  stepsCache.set(key, { value: steps, expires: now + STEPS_TTL_MS });
  return steps;
}

// Resolves the conversation's card → board + current step + the board's steps + the card snapshot.
// Returns null when the conversation has no linked card. Does NOT swallow errors (the caller treats a
// throw as "no kanban context" and the tool degrades). `cacheKey` scopes the step cache to the
// instance.
export async function loadKanbanContext(
  client: ChatwootClient,
  conversationId: number,
  cacheKey: string,
  now: number = Date.now(),
): Promise<KanbanContext | null> {
  // The conversation payload embeds the whole card under `kanban_task` (same shape as GET
  // /kanban/tasks/:id), so ONE conversation GET yields the board + current step + card snapshot — no
  // separate task fetch. Confirmed against the Pro fork conversations/_conversation.json.jbuilder.
  const task = (await client.kanbanTaskForConversation(conversationId)) as {
    id?: unknown;
    board_id?: unknown;
    board_step_id?: unknown;
    board?: { name?: unknown } | null;
    title?: unknown;
    description?: unknown;
    priority?: unknown;
    status?: unknown;
    value?: unknown;
    start_date?: unknown;
    due_date?: unknown;
    custom_attributes?: unknown;
    labels?: unknown;
  } | null;
  if (task == null) return null;
  const taskId = Number(task.id);
  if (!Number.isInteger(taskId) || taskId <= 0) return null;
  const boardId = Number(task.board_id);
  const currentStepId = Number(task.board_step_id);
  const hasBoard = Number.isInteger(boardId) && boardId > 0;
  // The embedded board.steps carry only {id,name,color}; the per-step description + cancelled flag live
  // on the board_steps endpoint, so resolve the full steps there (cached per board).
  const steps = hasBoard
    ? await loadBoardSteps(client, cacheKey, boardId, now)
    : [];
  const currentStep =
    Number.isInteger(currentStepId) && currentStepId > 0
      ? (steps.find((s) => s.id === currentStepId) ?? null)
      : null;
  return {
    taskId,
    boardId: hasBoard ? boardId : null,
    boardName:
      task.board && typeof task.board.name === "string"
        ? task.board.name
        : null,
    currentStepId: currentStep?.id ?? null,
    currentStepName: currentStep?.name ?? null,
    steps,
    card: {
      title: strOrNull(task.title),
      description: strOrNull(task.description),
      priority: strOrNull(task.priority),
      status: strOrNull(task.status),
      value: numOrNull(task.value),
      startDate: strOrNull(task.start_date),
      dueDate: strOrNull(task.due_date),
      attributes: plainAttributes(task.custom_attributes),
      labels: Array.isArray(task.labels)
        ? task.labels.filter((l): l is string => typeof l === "string")
        : [],
    },
  };
}

// Case-insensitive step-name → step match. Pure; null when nothing matches.
export function matchKanbanStep(
  steps: KanbanStep[],
  name: string,
): KanbanStep | null {
  const lc = name.trim().toLowerCase();
  if (!lc) return null;
  return steps.find((s) => s.name.toLowerCase() === lc) ?? null;
}

// Test-only: drop the step cache so cases don't leak TTL state into one another.
export function __resetKanbanStepsCache(): void {
  stepsCache.clear();
}
