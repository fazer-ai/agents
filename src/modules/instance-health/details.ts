import { clipText } from "@/lib/text";

// A line that names WHAT is behind a signal's value, appended to its firing alert: the statement
// and the work that timed out, the statement that drifted. The number alone says that something is
// slow; this says which, so the operator does not have to open the screen to know what broke
// (docs/logs.md, "Database"). Set by whoever samples the signal, cleared with null.

const KEY = Symbol.for("fazerai.instanceHealth.details");

function details(): Map<string, string> {
  const g = globalThis as unknown as Record<symbol, Map<string, string>>;
  g[KEY] ??= new Map();
  return g[KEY];
}

export function setSignalDetail(signal: string, detail: string | null): void {
  if (detail) details().set(signal, detail);
  else details().delete(signal);
}

export function signalDetail(signal: string): string | null {
  return details().get(signal) ?? null;
}

// A statement in one line an alert can carry: whitespace collapsed, cut at a length a chat message
// keeps readable.
export function statementLine(sql: string, max = 200): string {
  const one = sql.replace(/\s+/g, " ").trim();
  return one.length > max ? `${clipText(one, max - 1)}…` : one;
}

// The first relation a statement reads or writes, as an operator knows the table: quotes dropped and
// the default `public.` schema left out (`langgraph.checkpoint_blobs` keeps its own). Null when the
// statement names none (`SELECT 1`, `ROLLBACK`).
export function statementTable(sql: string): string | null {
  const ident = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
  const m = sql
    .replace(/\s+/g, " ")
    .match(
      new RegExp(
        String.raw`\b(?:FROM|UPDATE|INTO|JOIN) (${ident}(?: ?\. ?${ident})?)`,
        "i",
      ),
    );
  if (!m?.[1]) return null;
  const parts = m[1].split(/ ?\. ?/).map((p) => p.replace(/^"|"$/g, ""));
  if (parts.length === 2 && parts[0] === "public") return parts[1] ?? null;
  return parts.join(".");
}

function durationText(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

const HTTP_METHOD = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /;

// The work in the words of the alert: a job by its kind, a request by its route, any other label as
// the worker it names (src/lib/work-label.ts), and no label by the pool that ran the statement.
function workText(label: string | null, pool: string | undefined): string {
  if (label === null)
    return `work with no label${pool ? ` (pool ${pool})` : ""}`;
  if (label.startsWith("job:")) return `job ${label.slice(4)}`;
  if (HTTP_METHOD.test(label)) return `request ${label}`;
  return `worker ${label}`;
}

// The line under the statement-timeout count: the work that ran the statement, its scope, its
// budget and its table, then the statement itself.
export interface TimeoutLine {
  sql: string;
  label: string | null;
  // Read from the event's scope when it has one (src/lib/pool-stats.ts, StatementTimeoutEvent).
  tenantId?: string | null;
  fleet?: boolean;
  budgetMs?: number | null;
  pool?: string;
}

export function timeoutDetail(ev: TimeoutLine): string {
  const parts = [workText(ev.label, ev.pool)];
  if (ev.fleet) parts.push("all tenants");
  else if (ev.tenantId != null) parts.push(`tenant ${ev.tenantId}`);
  if (ev.budgetMs != null) parts.push(`${durationText(ev.budgetMs)} budget`);
  const table = statementTable(ev.sql);
  if (table) parts.push(`on ${table}`);
  return `Last timeout: ${parts.join(", ")}. Statement: ${statementLine(ev.sql)}`;
}

// The line under the drift share: how slow the slowest statement runs on average, and on which
// table, then the statement.
export function driftDetail(sql: string, meanMs: number): string {
  const table = statementTable(sql);
  return `Slowest over the last hour: ${durationText(meanMs)} mean${table ? `, on ${table}` : ""}. Statement: ${statementLine(sql)}`;
}
