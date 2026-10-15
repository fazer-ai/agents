// The outbound events grouped by family, as GET /v1/webhooks/events returns them, and what a
// subscription's selection means per group. A group's wildcard (`document.*`) stands for every event
// of the family, including ones added later, so "all" is the wildcard and never the list of today's
// names (docs/api-and-fleet.md, Outbound webhooks).

export interface WebhookEventGroup {
  // null for the events with no family (`heartbeat`), which have no wildcard either.
  family: string | null;
  wildcard: string | null;
  events: readonly string[];
}

export interface GroupSelection {
  // The family wildcard is selected.
  wildcard: boolean;
  // How many of the group's events the selection covers (all of them under the wildcard).
  covered: number;
  total: number;
}

export function groupSelection(
  group: WebhookEventGroup,
  selected: ReadonlySet<string>,
): GroupSelection {
  const total = group.events.length;
  if (group.wildcard && selected.has(group.wildcard))
    return { wildcard: true, covered: total, total };
  return {
    wildcard: false,
    covered: group.events.filter((e) => selected.has(e)).length,
    total,
  };
}

export function isEventCovered(
  group: WebhookEventGroup,
  selected: ReadonlySet<string>,
  event: string,
): boolean {
  return (
    (group.wildcard !== null && selected.has(group.wildcard)) ||
    selected.has(event)
  );
}

// The group's "all" box. Checking it stores the wildcard alone (the explicit names it covers are
// dropped); unchecking it clears the group. A group with no wildcard toggles its names instead.
export function toggleGroup(
  selected: ReadonlySet<string>,
  group: WebhookEventGroup,
): Set<string> {
  const next = new Set(selected);
  const state = groupSelection(group, selected);
  const on = group.wildcard ? state.wildcard : state.covered === state.total;
  for (const e of group.events) next.delete(e);
  if (group.wildcard) next.delete(group.wildcard);
  if (!on) {
    if (group.wildcard) next.add(group.wildcard);
    else for (const e of group.events) next.add(e);
  }
  return next;
}

// One event's box. Unchecking an event under the wildcard turns the group into the explicit list of
// its other events: the wildcard would keep delivering the one just unchecked.
export function toggleEvent(
  selected: ReadonlySet<string>,
  group: WebhookEventGroup,
  event: string,
): Set<string> {
  const next = new Set(selected);
  if (group.wildcard && next.has(group.wildcard)) {
    next.delete(group.wildcard);
    for (const e of group.events) if (e !== event) next.add(e);
    // NOTE: a subscription written by REST or MCP may hold the name beside the wildcard.
    next.delete(event);
    return next;
  }
  if (next.has(event)) next.delete(event);
  else next.add(event);
  return next;
}

export interface GroupSummary {
  group: WebhookEventGroup;
  selection: GroupSelection;
}

// The groups a subscription touches, in catalog order, for the one-line summary in the list. A stored
// name the catalog no longer has is returned apart, so it is shown rather than dropped.
export function summarizeSubscription(
  events: readonly string[],
  groups: readonly WebhookEventGroup[],
): { groups: GroupSummary[]; unknown: string[] } {
  const selected = new Set(events);
  const known = new Set<string>();
  const out: GroupSummary[] = [];
  for (const group of groups) {
    for (const e of group.events) known.add(e);
    if (group.wildcard) known.add(group.wildcard);
    const selection = groupSelection(group, selected);
    if (selection.covered > 0) out.push({ group, selection });
  }
  return { groups: out, unknown: events.filter((e) => !known.has(e)) };
}

// The events of a group whose label or raw name contains the query, case-insensitively, or all of
// them when the family's own name or label does. An empty query keeps every event.
export function matchingEvents(
  group: WebhookEventGroup,
  query: string,
  label: (event: string) => string,
  familyLabel: string,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...group.events];
  if (
    familyLabel.toLowerCase().includes(q) ||
    (group.family ?? "").toLowerCase().includes(q)
  )
    return [...group.events];
  return group.events.filter(
    (e) => e.toLowerCase().includes(q) || label(e).toLowerCase().includes(q),
  );
}
