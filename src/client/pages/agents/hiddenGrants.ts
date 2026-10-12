import type { GrantState } from "./types";

// The grants a Tools save writes. On questions and rules only what a rule can run is drawn: the
// natives a rule fires (`ruleTools`) and the tenant's own HTTP, code and MCP tools, so a save there
// writes those from the form and every other grant as stored; an edit made to the others before the
// switch stays pending for a switch back, like the hidden guidance (./toolGuidance). `stored` is null
// on the language model, where the form is written whole.
const RULE_SOURCES: ReadonlySet<string> = new Set(["HTTP", "CODE", "MCP"]);

//
// No NATIVE row means every native is granted, so a stored set without one reads as the whole
// catalog (`catalogNative`).
export function grantsToSave(
  form: GrantState[],
  stored: GrantState[] | null,
  ruleTools: readonly string[],
  catalogNative: readonly string[],
): GrantState[] {
  if (stored === null) return form;
  const isRule = (n: string) => ruleTools.includes(n);
  const formNative = form.find((g) => g.source === "NATIVE");
  const storedNative = stored.find((g) => g.source === "NATIVE");
  const others = [
    ...form.filter((g) => RULE_SOURCES.has(g.source)),
    ...stored.filter(
      (g) => g.source !== "NATIVE" && !RULE_SOURCES.has(g.source),
    ),
  ];
  if (!formNative && !storedNative) return others;
  const formTools = formNative
    ? (formNative.enabledTools ?? [])
    : catalogNative;
  const storedTools = storedNative
    ? (storedNative.enabledTools ?? [])
    : catalogNative;
  const enabledTools = [
    ...storedTools.filter((n) => !isRule(n)),
    ...formTools.filter(isRule),
  ];
  return [
    ...others,
    { ...(storedNative ?? formNative), source: "NATIVE", enabledTools },
  ];
}
