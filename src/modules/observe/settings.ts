// What a monitoring agent DOES with what it reads (issue #477), configured under
// `agent.settings.monitoring`. Read leniently, like every other behavior block: a missing or
// malformed field takes its default, so an agent switched to monitoring with no configuration at
// all observes nothing and costs nothing — observation starts the moment a label group is written.

export type MonitoringAnalysis = "incremental" | "on_resolve";

export interface LabelGroup {
  name: string;
  // One value at a time: the verdict REPLACES the group's current value. Additive groups accumulate.
  exclusive: boolean;
  values: string[];
}

export interface MonitoringConfig {
  // `incremental`: a verdict per debounced burst of customer messages, and a final one on resolve.
  // `on_resolve`: the final one only.
  analysis: MonitoringAnalysis;
  // How much of the conversation the model reads, in messages, newest first.
  window: { messages: number };
  // The burst window the OBSERVE job coalesces on, separate from the responder's debounce because
  // a label can wait longer than a reply.
  debounce: { windowSeconds: number; maxWindowSeconds: number };
  labelGroups: LabelGroup[];
  // A private note on the conversation whenever a verdict CHANGES a label, so the team reading the
  // conversation sees why it moved without opening the console.
  noteOnChange: boolean;
}

export const MONITORING_DEFAULTS: Readonly<MonitoringConfig> = Object.freeze({
  analysis: "incremental",
  window: { messages: 20 },
  debounce: { windowSeconds: 20, maxWindowSeconds: 60 },
  labelGroups: [],
  noteOnChange: true,
});

export const WINDOW_MESSAGES_MIN = 4;
export const WINDOW_MESSAGES_MAX = 60;
export const OBSERVE_WINDOW_MIN_SECONDS = 3;
export const OBSERVE_WINDOW_MAX_SECONDS = 600;
export const LABEL_GROUPS_MAX = 5;
export const LABEL_VALUES_MAX = 40;
// ...and how long each of those strings may be (issue #477 review, round 23). A group name and a
// label title are MODEL-FACING: both are copied verbatim into the system prompt's `<labels>` block
// and into the verdict schema's enum, and the title again into the flow line and the private note.
// Only the entry COUNTS were bounded, so a save the console accepted could put a megabyte of text in
// front of every OBSERVE call and make each one fail on the provider's request limit — for an agent
// whose configuration reads as valid everywhere an operator can look.
//
// DROPPED rather than clipped, which is why these live here and not in `text-caps.ts`: a label title
// is not prose, it is an identifier that has to match a row in Chatwoot, so half of one matches
// nothing and would be applied as a value the group does not list. A dropped entry is visible as a
// missing row, which is the same rule that file states for its own list-shaped caps. The write
// boundary refuses them outright (`assertMonitoringLabelGroups`) so nobody loses one silently; this
// is the defence for what is already stored.
//
// Sized off what the two ends actually accept: Chatwoot's own label titles are short, and a group
// name is a JSON property in the published schema.
export const LABEL_GROUP_NAME_MAX = 60;
export const LABEL_VALUE_MAX = 120;

// NAMES THE VERDICT SCHEMA ALREADY OWNS (issue #477 review, round 1). The model answers one property
// per group plus `confidence` and `reason`, in ONE flat object, so a group called either of those
// has its enum overwritten by the metadata field: the model then answers a number or a sentence
// under the group's key and `applyVerdict` can apply nothing. Dropped where every other malformed
// group is dropped, rather than namespaced in the schema, because the flat shape is what makes the
// verdict readable to a person in the flow line and in the private note.
// ...and the names that are not properties at all (issue #477 review, round 3). A group name becomes
// a KEY in three ordinary objects — the published schema's `properties`, the verdict the model
// answers, and the lookups that read it back — and `__proto__` assigned to one of those runs
// JavaScript's prototype setter instead of creating an own property. The schema then REQUIRES a
// property it does not publish, and with `additionalProperties: false` no structured provider can
// satisfy it: a configuration the console accepted classifies nothing, for a reason nothing reports.
// `constructor` and `prototype` are here beside it because they are the same class of surprise.
export const RESERVED_GROUP_NAMES: ReadonlySet<string> = new Set([
  "confidence",
  "reason",
  "__proto__",
  "constructor",
  "prototype",
]);

function clampInt(v: unknown, min: number, max: number, fallback: number) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.round(v), min), max);
}

function label(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

export function readLabelGroups(raw: unknown): LabelGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: LabelGroup[] = [];
  const seen = new Set<string>();
  // A VALUE BELONGS TO ONE GROUP (issue #477 review, round 9). A label is one row in a flat set, and
  // two groups claiming the same one cannot both keep their promise: with exclusive `A=[x,y]`,
  // additive `B=[x,z]`, `x` standing and a verdict `{A:y, B:z}`, honouring A removes the `x` that B
  // is supposed to have accumulated, and honouring B leaves A holding `x` AND `y`. There is no
  // third answer, so the taxonomy is refused rather than half-applied: the FIRST group to list a
  // value owns it, later groups have it removed, and a group left with nothing is dropped like any
  // other empty one. The settings schema refuses the overlap outright so a caller is told; this is
  // what a stored setting that predates the schema normalizes to.
  const owned = new Set<string>();
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const bag = g as Record<string, unknown>;
    const name = label(bag.name, LABEL_GROUP_NAME_MAX);
    if (name === null || seen.has(name)) continue;
    if (RESERVED_GROUP_NAMES.has(name.toLowerCase())) continue;
    const values: string[] = [];
    for (const v of Array.isArray(bag.values) ? bag.values : []) {
      const l = label(v, LABEL_VALUE_MAX);
      if (l !== null && !values.includes(l) && !owned.has(l)) values.push(l);
      if (values.length >= LABEL_VALUES_MAX) break;
    }
    if (values.length === 0) continue;
    for (const v of values) owned.add(v);
    seen.add(name);
    out.push({ name, exclusive: bag.exclusive !== false, values });
    if (out.length >= LABEL_GROUPS_MAX) break;
  }
  return out;
}

export type LabelGroupConflict =
  | { kind: "duplicate-name"; name: string }
  | { kind: "shared-value"; value: string };

// The same walk as `readLabelGroups`, reporting what it would silently drop instead of dropping it
// — and ONLY over the entries the reader would actually RETAIN (issue #477 review, round 21).
//
// The two rules a caller is told about (one group per name, one group per value) exist because the
// reader's answer to a violation is to erase an entire classification axis, so a patch would report
// success while the taxonomy it wrote is not the one stored. The CAPS are the opposite case: the
// schema promises truncation past five groups and forty values, so an entry beyond them is one the
// reader never keeps, and refusing a sixth group for colliding with a retained name — or a
// forty-first value for being owned elsewhere — turns a documented truncation into a 400 over an
// entry nobody would have stored.
//
// Walked rather than sliced because a group the reader DROPS does not consume one of the five: a
// blank or reserved name, or a group left with no usable value, is skipped and the next group takes
// its slot. `groups.slice(0, 5)` would therefore stop short of an entry the reader does retain, and
// miss the conflict this exists to report.
export function firstLabelGroupConflict(
  groups: readonly { name: string; values: readonly string[] }[],
): LabelGroupConflict | null {
  const names = new Set<string>();
  const owner = new Map<string, string>();
  let kept = 0;
  for (const g of groups) {
    if (kept >= LABEL_GROUPS_MAX) break;
    const name = g.name.trim();
    // Blank, over-long and reserved names are refused by their own field-level rules, and the reader
    // skips them without spending a slot. Skipped here for the same reason: whatever this group is,
    // it is not the one holding a name or a value away from another.
    if (
      name === "" ||
      name.length > LABEL_GROUP_NAME_MAX ||
      RESERVED_GROUP_NAMES.has(name.toLowerCase())
    )
      continue;
    if (names.has(name)) return { kind: "duplicate-name", name };
    const values: string[] = [];
    for (const v of g.values) {
      if (values.length >= LABEL_VALUES_MAX) break;
      const value = v.trim();
      if (
        value === "" ||
        value.length > LABEL_VALUE_MAX ||
        values.includes(value)
      )
        continue;
      const had = owner.get(value);
      // The OWNING GROUP, not every occurrence: `["vip", "vip"]` inside ONE group is not two owners.
      if (had !== undefined && had !== name)
        return { kind: "shared-value", value };
      values.push(value);
    }
    if (values.length === 0) continue;
    for (const v of values) owner.set(v, name);
    names.add(name);
    kept++;
  }
  return null;
}

export function readMonitoringConfig(settings: unknown): MonitoringConfig {
  const def = MONITORING_DEFAULTS;
  const m =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).monitoring
      : undefined;
  if (!m || typeof m !== "object") {
    return {
      ...def,
      window: { ...def.window },
      debounce: { ...def.debounce },
      labelGroups: [],
    };
  }
  const bag = m as Record<string, unknown>;
  const window =
    bag.window && typeof bag.window === "object"
      ? (bag.window as Record<string, unknown>)
      : {};
  const debounce =
    bag.debounce && typeof bag.debounce === "object"
      ? (bag.debounce as Record<string, unknown>)
      : {};
  const windowSeconds = clampInt(
    debounce.windowSeconds,
    OBSERVE_WINDOW_MIN_SECONDS,
    OBSERVE_WINDOW_MAX_SECONDS,
    def.debounce.windowSeconds,
  );
  const maxWindowSeconds = clampInt(
    debounce.maxWindowSeconds,
    windowSeconds,
    OBSERVE_WINDOW_MAX_SECONDS,
    Math.max(def.debounce.maxWindowSeconds, windowSeconds),
  );
  return {
    analysis: bag.analysis === "on_resolve" ? "on_resolve" : "incremental",
    window: {
      messages: clampInt(
        window.messages,
        WINDOW_MESSAGES_MIN,
        WINDOW_MESSAGES_MAX,
        def.window.messages,
      ),
    },
    debounce: { windowSeconds, maxWindowSeconds },
    labelGroups: readLabelGroups(bag.labelGroups),
    noteOnChange: !(bag.noteOnChange === false || bag.noteOnChange === "false"),
  };
}

// Observation is ON when there is something to write: an agent with no label group configured has
// nothing to classify into, so no job is armed and no model is called.
export function observationEnabled(cfg: MonitoringConfig): boolean {
  return cfg.labelGroups.length > 0;
}

// EVERY VALUE A CLASSIFIER OWNS, flattened. The unit the collision below is about is the label, and
// which group of which agent claims it does not change that.
export function labelValuesOf(settings: unknown): Set<string> {
  const mon =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).monitoring
      : undefined;
  const raw =
    mon && typeof mon === "object"
      ? (mon as Record<string, unknown>).labelGroups
      : undefined;
  const out = new Set<string>();
  for (const g of readLabelGroups(raw)) for (const v of g.values) out.add(v);
  return out;
}
