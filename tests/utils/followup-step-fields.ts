// The field names declared on the `FollowUpStep` interface, read off the source the runtime consumes
// rather than copied into a list. A step is a bag of OPTIONAL fields, so no runtime read enumerates
// it (`readFollowUpConfig({})` answers three keys), and a hand-written list goes stale in step with
// the surface, so the two agree and the test passes. Two surfaces consult this: the console's form
// pair (a field it does not carry is DELETED on the next save) and the MCP/REST patch schema (a
// field it does not declare is one no caller is told about). The positive control lives HERE:
// a parse that finds nothing hands back a list every assertion passes over.

const SRC = await Bun.file(
  new URL("../../src/modules/followups/settings.ts", import.meta.url).pathname,
).text();

export function followUpStepFields(): string[] {
  const body = SRC.match(
    /export interface FollowUpStep \{\n([\s\S]*?)\n\}/,
  )?.[1];
  if (!body) throw new Error("FollowUpStep interface not found");
  const names = body
    .split("\n")
    .map((l) => l.trim().match(/^([A-Za-z][A-Za-z0-9]*)\??:/)?.[1])
    .filter((n): n is string => n !== undefined)
    .sort();
  if (names.length < 3 || !names.includes("delayValue")) {
    throw new Error(
      `FollowUpStep parse found ${names.length} fields: ${names}`,
    );
  }
  return names;
}
