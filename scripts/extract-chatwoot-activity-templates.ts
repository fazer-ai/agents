#!/usr/bin/env bun
// REGENERATES THE TWO TABLES IN `src/modules/chatwoot/label-activity.ts` from the fork's own locale
// files. Run it when upgrading Chatwoot, and paste the two arrays it prints:
//
//   bun scripts/extract-chatwoot-activity-templates.ts ../chatwoot/config/locales
//
// The module's contract is that the tables are exhaustive (a missing ACTIVITY template is a sentence
// nothing refuses, whose placeholder carries someone else's text), so the YAML is PARSED by
// `Bun.YAML` and walked to every leaf: decoding scalars by hand or reading one level deep misses some.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: extract-chatwoot-activity-templates.ts <locales dir>");
  process.exit(1);
}

// SPLIT BY THE KEY THEY CAME FROM. `conversations.activity.labels` has exactly two leaves, `added`
// and `removed`, and the difference decides whether a line can be the reset's own cleanup: the
// reset only ever REMOVES, so an addition that lands out of order must not be read as one.
const labelsAdded = new Set<string>();
const labelsRemoved = new Set<string>();
const other = new Set<string>();
// A SECOND PRODUCER OF ACTIVITY ROWS. `DataImports::Intercom::ActivityContentBuilder` writes
// `message_type: activity` with `content_attributes: {}` (no bag to tell it apart), and
// renders from `data_imports.<vendor>.activities.*`, a subtree nothing under `conversations.activity`
// covers. "%{actor} added a participant" is then read by the English label template as the label
// `a participant`. Kept apart from the others because that builder appends the Intercom part's own
// body as `"<sentence>: <body>"`, so these have to be refused with that tail as well.
const imports = new Set<string>();
const unknownLabelPaths = new Set<string>();

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
    if (isRecord(conversations))
      // NOTE: a sentence with no placeholder is still a sentence to refuse: that none reads as a
      // label change is a property of the strings the fork ships, not of anything enforced here.
      // Only the LABEL side needs one, `%{labels}`: without it there is nothing to read back.
      walk(conversations.activity, [], (path, value) => {
        if (path.startsWith("labels.")) {
          if (!value.includes("%{labels}")) return;
          // `labels.added` / `labels.removed`, and anything else under `labels.` is a leaf this
          // script has never seen: printed apart rather than folded into one of the two, because a
          // sentence filed under the wrong verb is exactly the misreading this split exists to fix.
          if (path === "labels.added") labelsAdded.add(value);
          else if (path === "labels.removed") labelsRemoved.add(value);
          else unknownLabelPaths.add(`${path}: ${value}`);
        } else {
          other.add(value);
        }
      });
    walk(root.data_imports, [], (path, value) => {
      if (path.includes(".activities.")) imports.add(value);
    });
  }
}

const render = (set: Set<string>) =>
  [...set]
    .sort()
    .map((t) => `  ${JSON.stringify(t)},`)
    .join("\n");

if (unknownLabelPaths.size > 0) {
  console.log(
    `// !! LEAVES UNDER labels. THAT ARE NEITHER added NOR removed (${unknownLabelPaths.size})`,
  );
  console.log(
    [...unknownLabelPaths]
      .sort()
      .map((t) => `//   ${t}`)
      .join("\n"),
  );
}
console.log(`// LABEL_ADDED_TEMPLATES (${labelsAdded.size})`);
console.log(render(labelsAdded));
console.log(`\n// LABEL_REMOVED_TEMPLATES (${labelsRemoved.size})`);
console.log(render(labelsRemoved));
console.log(`\n// OTHER_ACTIVITY_TEMPLATES (${other.size})`);
console.log(render(other));
console.log(`\n// IMPORT_ACTIVITY_TEMPLATES (${imports.size})`);
console.log(render(imports));
