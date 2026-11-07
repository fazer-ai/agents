import type { api } from "@/client/lib/api";

// Every shape below is the endpoint's own (docs/eden-treaty.md): a field the server adds or renames
// reaches this screen at the next type check.
type DatabaseResponse = Awaited<
  ReturnType<(typeof api.api.v1)["instance-health"]["database"]["get"]>
>["data"];
export type Screen = NonNullable<DatabaseResponse>["database"];
export type Statements = Screen["statements"];
export type StatementRow = Extract<
  Statements,
  { available: true }
>["byTotal"][number];
export type TimeoutGroup = Screen["timeouts"][number];
export type TableRow = Screen["tables"][number];
export type DatabaseSignal = Screen["signals"][number];

export const WINDOW_KEYS = ["1h", "24h", "7d"] as const;
export type WindowKey = (typeof WINDOW_KEYS)[number];

export const SECTION_KEYS = ["statements", "timeouts", "tables"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
