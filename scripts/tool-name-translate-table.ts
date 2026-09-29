// The console's `normalizeToolName` NFD-and-strip-\p{Diacritic} step as a SQL `translate()` table,
// generated from THIS runtime's Unicode: a code point whose NFD minus diacritics is one ASCII letter
// maps to that letter lowercased; a non-alphanumeric \p{Diacritic} is deleted (listed past the end
// of the destination string). The migration 20260903120000_rename_http_tools_named_after_natives
// embeds it, and its test compares SQL and console on the first two planes.
//
//   bun scripts/tool-name-translate-table.ts > /tmp/translate.json
import { normalizeToolName } from "@/graph/tools/toolName";

const DIA = /\p{Diacritic}/u;
const src: string[] = [];
const dst: string[] = [];
const del: string[] = [];
for (let cp = 0x01; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const ch = String.fromCodePoint(cp);
  if (cp < 0x80 && /[A-Za-z0-9]/.test(ch)) continue;
  const left = [...ch.normalize("NFD")].filter((c) => !DIA.test(c)).join("");
  if (/^[A-Za-z]$/.test(left)) {
    src.push(ch);
    dst.push(left.toLowerCase());
  } else if (left === "") {
    del.push(ch);
  }
}
// The table is only right if the console agrees on every letter it names.
for (const [i, ch] of src.entries()) {
  if (normalizeToolName(ch) !== dst[i])
    throw new Error(`disagree on U+${ch.codePointAt(0)?.toString(16)}`);
}
const out = {
  src: src.join("") + del.join(""),
  dst: dst.join(""),
  letters: src.length,
  deleted: del.length,
};
if (out.src.includes("'"))
  throw new Error("a quote in the table would break the SQL literal");
console.log(JSON.stringify(out));
