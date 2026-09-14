#!/usr/bin/env bun
// REGENERATES THE TWO TABLES IN `src/modules/chatwoot/label-activity.ts` from the fork's own locale
// files (issue #642). Run it when upgrading Chatwoot, and paste the two arrays it prints:
//
//   bun scripts/extract-chatwoot-activity-templates.ts ../chatwoot/config/locales
//
// WHY A SCRIPT AND NOT A ONE-OFF: the module's whole contract is that the tables are exhaustive. A
// label template missing means a change nobody reads; an ACTIVITY template missing means a sentence
// nothing refuses, and a placeholder is where somebody else's text goes — a WhatsApp group name, a
// contact's push name — so a missing one is a hole somebody can aim at. Reading the tree by hand
// missed 105 leaves the first time (review round 11), all of them nested deeper than the level that
// was being read, and a hand-rolled unquote left YAML's own escaping in 13 more (round 10).
//
// So the file is PARSED, by `Bun.YAML`, and the tree is walked to every leaf. Decoding scalars by
// hand is the bug this had twice: a single-quoted scalar doubles an apostrophe, a double-quoted one
// can carry `\n`, `\t` or `\uXXXX`, and a pattern built from the file's spelling waits for text
// Chatwoot never writes (round 12).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: extract-chatwoot-activity-templates.ts <locales dir>");
  process.exit(1);
}

const labels = new Set<string>();
const other = new Set<string>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Every string leaf under `node`, with the dotted path it sits at.
function walk(
  node: unknown,
  path: string[],
  out: (p: string, v: string) => void,
) {
  if (typeof node === "string") {
    out(path.join("."), node);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node))
    walk(value, [...path, key], out);
}

for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
  const doc = Bun.YAML.parse(readFileSync(join(dir, file), "utf8"));
  if (!isRecord(doc)) continue;
  // Each locale file is `<locale>: { conversations: { activity: … } }`.
  for (const root of Object.values(doc)) {
    if (!isRecord(root)) continue;
    const conversations = root.conversations;
    if (!isRecord(conversations)) continue;
    walk(conversations.activity, [], (path, value) => {
      if (!value.includes("%{")) return;
      if (path.startsWith("labels.")) {
        if (value.includes("%{labels}")) labels.add(value);
      } else {
        other.add(value);
      }
    });
  }
}

const render = (set: Set<string>) =>
  [...set]
    .sort()
    .map((t) => `  ${JSON.stringify(t)},`)
    .join("\n");

console.log(`// LABEL_ACTIVITY_TEMPLATES (${labels.size})`);
console.log(render(labels));
console.log(`\n// OTHER_ACTIVITY_TEMPLATES (${other.size})`);
console.log(render(other));
