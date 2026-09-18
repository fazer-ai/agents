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

// SPLIT BY THE KEY THEY CAME FROM (issue #645, review round 1). `conversations.activity.labels`
// has exactly two leaves, `added` and `removed`, and the difference decides whether a line can be
// the reset's own cleanup: the reset only ever REMOVES, so an addition that lands out of order must
// not be read as one. The union of the two is what the single table used to hold.
const labelsAdded = new Set<string>();
const labelsRemoved = new Set<string>();
const other = new Set<string>();
// A SECOND PRODUCER OF ACTIVITY ROWS (round 17). `DataImports::Intercom::ActivityContentBuilder`
// writes `message_type: activity` with `content_attributes: {}` — no bag to tell it apart — and
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
      // A SENTENCE WITH NO PLACEHOLDER IS STILL A SENTENCE TO REFUSE. Requiring `%{` dropped 98 of
      // them; none is readable as a label change today, but that is a property of the strings the
      // fork happens to ship and not of anything this code enforces, so the filter was one upgrade
      // away from being a hole. Only the LABEL side needs a placeholder, and a specific one: a
      // template with no `%{labels}` has nothing to read back (round 17).
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
