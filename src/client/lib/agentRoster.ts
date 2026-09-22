import { api } from "@/client/lib/api";

// THE TENANT'S WHOLE AGENT ROSTER, for a page that resolves or offers agents rather than listing
// them. Lifted out of ChannelsPage when the Conversations filter needed the same answer (issue #607):
// a filter built on the first page alone would leave an agent past it with no way to be picked.

type AgentsData = Awaited<ReturnType<typeof api.api.v1.agents.get>>["data"];
export type AgentLite = NonNullable<AgentsData>["agents"][number];

// EVERY agent, not the first page (issue #476 review, round 4). The channels page does not list
// agents, it RESOLVES them: an id bound to an inbox or observing one is rendered by looking it up here, so an
// agent past the first page reads as no agent at all — a responder the picker cannot show, an
// observer whose chip and remove button vanish. `/agents` answers 20 at a time and caps a page at
// 100, so the pages are walked to the total the first one reports.
const AGENTS_PAGE_SIZE = 100;

// One walk of the roster. Null on a failed page; `changed` when the roster moved underneath it, so
// the caller can start over rather than render what came back.
async function walkAgentsOnce(): Promise<
  { agents: AgentLite[] } | "changed" | null
> {
  // BY CREATION, ascending: the default ordering is `updatedAt`, which another admin can move while
  // the pages are being walked — a row sliding from a later page into the first one is read twice
  // and another is never read at all, which here is an observer whose chip and remove button
  // disappear. `createdAt` does not move, and an agent created meanwhile lands at the end.
  const query = { orderBy: "createdAt" as const, order: "asc" as const };
  const first = await api.api.v1.agents.get({
    query: { ...query, page: 1, pageSize: AGENTS_PAGE_SIZE },
  });
  if (!first.data) return null;
  const agents: AgentLite[] = [...first.data.agents];
  const seen = new Set(agents.map((a) => a.id));
  const total = first.data.total;
  // The freshest count the walk saw. Offsets are computed against the roster as it stands at each
  // request, so a DELETION on an already-read page slides every later row one place forward and the
  // walk steps straight over one of them (issue #476 review, round 37): after reading 100 of 150,
  // deleting one of those 100 makes page 2 return the 49 rows from offset 100 of a 149-row roster,
  // and the row that WAS 101 is never read. The counts still add up — 149 held against a total of
  // 149 — so the shortfall cannot detect it; the total MOVING is what does.
  let latestTotal = total;
  for (
    let page = 2;
    agents.length < latestTotal && first.data.agents.length > 0;
    page += 1
  ) {
    const next = await api.api.v1.agents.get({
      query: { ...query, page, pageSize: AGENTS_PAGE_SIZE },
    });
    // A page that failed makes the list INCOMPLETE, and a partial list here is not a smaller list:
    // it is a bound responder rendered as "No agent" and an observer whose chip and remove button
    // are gone. The page says it could not load instead.
    if (next.error) return null;
    if (!next.data) break;
    if (next.data.total !== total) return "changed";
    latestTotal = next.data.total;
    // An EMPTY page with the total unchanged is the end of the roster.
    if (next.data.agents.length === 0) break;
    for (const a of next.data.agents) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      agents.push(a);
    }
  }
  // A short walk against a total that never moved is a page that quietly returned less than it
  // should have. Same answer: do not render a roster with holes in it.
  return agents.length < total ? "changed" : { agents };
}

const AGENTS_WALK_ATTEMPTS = 3;

export async function loadAllAgents(): Promise<AgentLite[] | null> {
  for (let attempt = 0; attempt < AGENTS_WALK_ATTEMPTS; attempt += 1) {
    const walk = await walkAgentsOnce();
    if (walk === null) return null;
    if (walk !== "changed") return walk.agents;
  }
  // A roster that moved under three consecutive walks is not one this page can render honestly.
  return null;
}
