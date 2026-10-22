// The consult-back of a GENERIC instance (`config.fetchBack`): a gateway whose notification carries
// only an id (Mercado Pago's `{"type":"payment","data":{"id":"…"}}`) is answered by running one of
// the tenant's own HTTP tools with that id and mapping the tool's RESPONSE, never the notification,
// into the closed event set. The conversation comes from the response's `conversation_ref`, which
// correlates only on this instance (the ref the operator's "create charge" tool minted), so nothing
// the sender writes chooses the conversation. Pure parsing and mapping here; the receptor runs the
// tool (./fetch-back-run.ts) and the writer checks the tool (./service.ts). docs/integrations.md.

import { parseDbId } from "@/lib/db-id";
import { GENERIC_TEXT_MAX_CHARS, type MapResult } from "./types";

export const FETCH_BACK_STATUSES_MAX = 20;
const ID_SOURCE = /^(query|header|body)\.(.+)$/;
const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,9}$/;
const ARG = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// What may travel into a URL path or query of the operator's tool: an id, nothing that changes the
// resource it names (`/`, `.`, `?`, `#`, `%`) and nothing long.
export const RESOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface FetchBackStatus {
  status: string;
  text: string | null;
  paid: boolean;
}

export interface FetchBackConfig {
  toolId: bigint;
  idFrom: { source: "query" | "header" | "body"; name: string };
  idArg: string;
  conversationRefPath: string;
  statusPath: string;
  eventIdPath: string | null;
  valuePath: string | null;
  currencyPath: string | null;
  statuses: FetchBackStatus[];
}

export type FetchBackProblem = { field: string; problem: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// `undefined` is "this instance takes GENERIC's own body". Anything present is fully usable or a
// problem naming the field, read the same way by the writer and the receptor.
export function parseFetchBackConfig(
  raw: unknown,
): FetchBackConfig | FetchBackProblem | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { field: "", problem: "must be an object" };
  }
  const c = raw as Record<string, unknown>;
  const toolId = typeof c.toolId === "string" ? parseDbId(c.toolId) : null;
  if (toolId === null) {
    return { field: "toolId", problem: "must name an HTTP tool by its id" };
  }
  const idFromRaw = str(c.idFrom);
  const m = idFromRaw ? ID_SOURCE.exec(idFromRaw) : null;
  if (
    !m ||
    !(m[1] === "body" ? PATH : /^[A-Za-z0-9._~-]{1,128}$/).test(m[2] as string)
  ) {
    return {
      field: "idFrom",
      problem:
        "must be query.<parameter>, header.<name> or body.<dot.path> (e.g. query.data.id)",
    };
  }
  const idArg = str(c.idArg);
  if (!idArg || !ARG.test(idArg)) {
    return { field: "idArg", problem: "must name a field of the tool" };
  }
  const path = (
    key:
      | "conversationRefPath"
      | "statusPath"
      | "eventIdPath"
      | "valuePath"
      | "currencyPath",
    required: boolean,
  ): string | null | FetchBackProblem => {
    const v = str(c[key]);
    if (v === null) {
      return required
        ? { field: key, problem: "is required (a dot path in the response)" }
        : null;
    }
    return PATH.test(v)
      ? v
      : { field: key, problem: "must be a dot path such as a.b.c" };
  };
  const conversationRefPath = path("conversationRefPath", true);
  const statusPath = path("statusPath", true);
  const eventIdPath = path("eventIdPath", false);
  const valuePath = path("valuePath", false);
  const currencyPath = path("currencyPath", false);
  for (const p of [
    conversationRefPath,
    statusPath,
    eventIdPath,
    valuePath,
    currencyPath,
  ]) {
    if (p !== null && typeof p === "object") return p;
  }
  if (!Array.isArray(c.statuses) || c.statuses.length === 0) {
    return {
      field: "statuses",
      problem: "must list at least one status to act on",
    };
  }
  if (c.statuses.length > FETCH_BACK_STATUSES_MAX) {
    return {
      field: "statuses",
      problem: `lists more than ${FETCH_BACK_STATUSES_MAX} statuses`,
    };
  }
  const statuses: FetchBackStatus[] = [];
  const seen = new Set<string>();
  for (const [i, s] of c.statuses.entries()) {
    const field = `statuses.${i}`;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      return { field, problem: "must be an object" };
    }
    const row = s as Record<string, unknown>;
    const status = str(row.status);
    if (!status || status.length > 64) {
      return {
        field: `${field}.status`,
        problem: "is required (at most 64 characters)",
      };
    }
    if (seen.has(status)) {
      return {
        field: `${field}.status`,
        problem: `"${status}" is listed twice`,
      };
    }
    seen.add(status);
    const text = str(row.text);
    if (text !== null && text.length > GENERIC_TEXT_MAX_CHARS) {
      return {
        field: `${field}.text`,
        problem: `is over ${GENERIC_TEXT_MAX_CHARS} characters`,
      };
    }
    const paid = row.paid === true;
    if (text === null && !paid) {
      return {
        field: `${field}.text`,
        problem: "is required for a status that is not a payment",
      };
    }
    statuses.push({ status, text, paid });
  }
  return {
    toolId,
    idFrom: {
      source: m[1] as "query" | "header" | "body",
      name: m[2] as string,
    },
    idArg,
    conversationRefPath: conversationRefPath as string,
    statusPath: statusPath as string,
    eventIdPath: eventIdPath as string | null,
    valuePath: valuePath as string | null,
    currencyPath: currencyPath as string | null,
    statuses,
  };
}

export function isFetchBackProblem(
  v: FetchBackConfig | FetchBackProblem,
): v is FetchBackProblem {
  return "problem" in v;
}

export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (!Object.hasOwn(cur as object, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// A JSON number past 2^53 already arrived rounded (`9007199254740993` parses as `…992`), so it names
// another resource: only safe integers are taken, and anything else is absent.
const scalar = (v: unknown): string | null =>
  typeof v === "string" && v !== ""
    ? v
    : typeof v === "number" && Number.isSafeInteger(v)
      ? String(v)
      : null;

// The id the notification names, or null when it names none this receptor will look up.
export function noticeResourceId(
  cfg: FetchBackConfig,
  src: {
    parsedBody: unknown;
    getHeader: (name: string) => string | null;
    getQuery: (name: string) => string | null;
  },
): string | null {
  const { source, name } = cfg.idFrom;
  const v =
    source === "query"
      ? src.getQuery(name)
      : source === "header"
        ? src.getHeader(name)
        : scalar(readPath(src.parsedBody, name));
  return v !== null && RESOURCE_ID.test(v) ? v : null;
}

// The provider's answer about one resource, in the closed event set. A status the operator did not
// list is `unhandled` (a payment still pending is noise, not drift); a response without the ref or
// the status is `invalid`.
export function mapFetchedResource(
  cfg: FetchBackConfig,
  resourceId: string,
  response: unknown,
): MapResult {
  const ref = scalar(readPath(response, cfg.conversationRefPath));
  const status = scalar(readPath(response, cfg.statusPath));
  const missing = [
    ref === null ? cfg.conversationRefPath : null,
    status === null ? cfg.statusPath : null,
  ].filter((p): p is string => p !== null);
  if (missing.length) {
    return { ok: false, reason: "invalid", detail: missing.join(", ") };
  }
  const rule = cfg.statuses.find((s) => s.status === status);
  if (!rule) return { ok: false, reason: "unhandled" };
  const eventId =
    (cfg.eventIdPath ? scalar(readPath(response, cfg.eventIdPath)) : null) ??
    resourceId;
  const value = cfg.valuePath ? readPath(response, cfg.valuePath) : undefined;
  const currency = cfg.currencyPath
    ? scalar(readPath(response, cfg.currencyPath))
    : null;
  return {
    ok: true,
    event: {
      kind: rule.paid ? "conversion" : "agent_nudge",
      externalId: ref as string,
      // Each half encoded, so a `:` inside one cannot pass for the separator (`a:b`+`c` and
      // `a`+`b:c`); a plain id and status read as before, `123:approved`.
      dedupeKey: `${encodeURIComponent(eventId)}:${encodeURIComponent(status as string)}`,
      status: status as string,
      ...(rule.text ? { text: rule.text } : {}),
      ...(rule.paid && typeof value === "number" && Number.isFinite(value)
        ? { value }
        : {}),
      ...(rule.paid && currency && /^[A-Za-z]{3}$/.test(currency)
        ? { currency: currency.toUpperCase() }
        : {}),
    },
  };
}
