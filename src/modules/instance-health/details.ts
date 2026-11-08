import config from "@/config";
import { clipText } from "@/lib/text";

// A line that names WHAT is behind a signal's value, appended to its firing alert: the statement
// and the work that timed out, the statement that drifted. The number alone says that something is
// slow; this says which, so the operator does not have to open the screen to know what broke
// (docs/logs.md, "Database"). Set by whoever samples the signal, as fields, cleared with null.

const KEY = Symbol.for("fazerai.instanceHealth.details");

// The work behind a timeout, as the database screen names it in the console's language.
export type WorkFacts =
  | { kind: "job" | "request" | "worker"; name: string }
  | { kind: "none"; pool: string | null };

// What is behind a signal's value, as fields: the screen writes its own line from them, translated
// and formatted by the locale, and the alert, REST and MCP carry the English line built from the same
// fields (detailText).
export interface TimeoutFacts {
  kind: "timeout";
  work: WorkFacts;
  tenantId: string | null;
  fleet: boolean;
  budgetMs: number | null;
  table: string | null;
  statement: string;
}
export interface DriftFacts {
  kind: "drift";
  meanMs: number;
  // The budget that statement ran under, which the share is of.
  budgetMs: number;
  table: string | null;
  statement: string;
}
export type SignalFacts = TimeoutFacts | DriftFacts;

function details(): Map<string, SignalFacts> {
  const g = globalThis as unknown as Record<symbol, Map<string, SignalFacts>>;
  g[KEY] ??= new Map();
  return g[KEY];
}

export function setSignalDetail(
  signal: string,
  facts: SignalFacts | null,
): void {
  if (facts) details().set(signal, facts);
  else details().delete(signal);
}

export function signalFacts(signal: string): SignalFacts | null {
  return details().get(signal) ?? null;
}

export function signalDetail(signal: string): string | null {
  const facts = signalFacts(signal);
  return facts ? detailText(facts) : null;
}

// A statement in one line an alert can carry: comments dropped, whitespace collapsed, cut at a length
// a chat message keeps readable.
export function statementLine(sql: string, max = 200): string {
  // A `--` comment runs to its line's end: joined onto one line it would swallow the rest, so it is
  // left out. Values arrive as `$N`, so no quoted text carries a `--`.
  const one = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

// The work by its label: a job by its kind, a request by its route, any other label as the worker it
// names (src/lib/work-label.ts), and no label by the pool that ran the statement.
export function workFacts(
  label: string | null,
  pool: string | undefined,
): WorkFacts {
  if (label === null) return { kind: "none", pool: pool ?? null };
  if (label.startsWith("job:")) return { kind: "job", name: label.slice(4) };
  if (HTTP_METHOD.test(label)) return { kind: "request", name: label };
  return { kind: "worker", name: label };
}

function workText(w: WorkFacts): string {
  if (w.kind === "none")
    return `work with no label${w.pool ? ` (pool ${w.pool})` : ""}`;
  return `${w.kind} ${w.name}`;
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

export function timeoutFacts(ev: TimeoutLine): TimeoutFacts {
  return {
    kind: "timeout",
    work: workFacts(ev.label, ev.pool),
    tenantId: ev.tenantId ?? null,
    fleet: ev.fleet ?? false,
    budgetMs: ev.budgetMs ?? null,
    table: statementTable(ev.sql),
    statement: statementLine(ev.sql),
  };
}

// The line under the drift share: how slow the slowest statement runs on average, and on which
// table, then the statement.
export function driftFacts(
  sql: string,
  meanMs: number,
  budgetMs: number = config.dbTx.timeoutMs,
): DriftFacts {
  return {
    kind: "drift",
    meanMs,
    budgetMs,
    table: statementTable(sql),
    statement: statementLine(sql),
  };
}

// The English line the alert channel (which has no locale), REST and MCP carry.
export function detailText(f: SignalFacts): string {
  if (f.kind === "drift") {
    return `Closest to its budget over the last hour: ${durationText(f.meanMs)} mean, ${durationText(f.budgetMs)} budget${f.table ? `, on ${f.table}` : ""}. Statement: ${f.statement}`;
  }
  const parts = [workText(f.work)];
  if (f.fleet) parts.push("all tenants");
  else if (f.tenantId != null) parts.push(`tenant ${f.tenantId}`);
  if (f.budgetMs != null) parts.push(`${durationText(f.budgetMs)} budget`);
  if (f.table) parts.push(`on ${f.table}`);
  return `Last timeout: ${parts.join(", ")}. Statement: ${f.statement}`;
}

export function timeoutDetail(ev: TimeoutLine): string {
  return detailText(timeoutFacts(ev));
}

export function driftDetail(
  sql: string,
  meanMs: number,
  budgetMs: number = config.dbTx.timeoutMs,
): string {
  return detailText(driftFacts(sql, meanMs, budgetMs));
}
