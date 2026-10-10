import type { FollowUpStep } from "@/modules/followups/settings";

// The field names declared on the `FollowUpStep` interface. A step is a bag of OPTIONAL fields, so
// no runtime read enumerates it (`readFollowUpConfig({})` answers three keys); the record below is
// held to the interface by the compiler instead, so a field added there without a line here (or a
// line here for a field that does not exist) is a type error rather than a list that goes stale in
// step with the surface. Two surfaces consult this: the console's form pair (a field it does not
// carry is DELETED on the next save) and the MCP/REST patch schema (a field it does not declare is
// one no caller is told about).
const FIELDS = {
  delayValue: true,
  delayUnit: true,
  instructions: true,
  assignLabels: true,
  resolve: true,
  ignoreAppointmentPause: true,
} satisfies Record<keyof FollowUpStep, true>;

export function followUpStepFields(): string[] {
  return Object.keys(FIELDS).sort();
}
