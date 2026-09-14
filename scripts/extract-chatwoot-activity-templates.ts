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
// was being read.
//
// TWO THINGS THE PARSER HAS TO GET RIGHT, and both have already been got wrong:
//   - EVERY leaf under `conversations.activity`, at any depth, not just the first level.
//   - The value as YAML DECODES it: a single-quoted scalar escapes an apostrophe by doubling it, and
//     a pattern built from the file's spelling waits for two apostrophes Chatwoot never writes.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replaceAll("''", "'");
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  return v;
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: extract-chatwoot-activity-templates.ts <locales dir>");
  process.exit(1);
}

const labels = new Set<string>();
const other = new Set<string>();

for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
  const text = readFileSync(join(dir, file), "utf8");
  // The `conversations.activity` subtree, up to the next key at its own level.
  // `$(?![\s\S])` is end-of-input: JS has no `\Z`, and writing one matches a literal "Z", which
  // truncates the subtree at the first Z in the file.
  const block = text.match(
    /^ {4}activity:\n([\s\S]*?)(?=^ {4}\w|$(?![\s\S]))/m,
  )?.[1];
  if (block === undefined) continue;
  let path: string[] = [];
  for (const line of block.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const depth = Math.floor((indent - 6) / 2);
    path = path.slice(0, Math.max(depth, 0));
    const key = line.match(/^\s*([\w.-]+):\s*$/);
    if (key?.[1] !== undefined) {
      path.push(key[1]);
      continue;
    }
    const leaf = line.match(/^\s*([\w.-]+): (.+)$/);
    if (leaf?.[1] === undefined || leaf[2] === undefined) continue;
    const full = [...path, leaf[1]].join(".");
    const value = unquote(leaf[2]);
    if (!value.includes("%{")) continue;
    if (full.startsWith("labels.")) {
      if (value.includes("%{labels}")) labels.add(value);
    } else {
      other.add(value);
    }
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
