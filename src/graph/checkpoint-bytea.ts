import pg from "pg";

// The text parser for `bytea[]` on the checkpointer's pool. The saver reads every checkpoint's channel
// values and pending writes as `array_agg(array[…bytea])`, and the default parser (postgres-array)
// walks that text one character at a time, allocating per character: about 30 ms per MB of
// checkpoint, on the event loop, on every load of a long thread. Postgres writes each element of a
// `bytea[]` in hex as `"\\x<hex>"` and a missing one as `NULL`, so the elements are found with
// `indexOf` and decoded by `Buffer.from(hex)`. Anything outside that shape (`bytea_output = escape`,
// a lower-bound prefix such as `[0:1]=`, unbalanced braces) goes to the default parser whole, so the
// value the saver receives is the default parser's in every case.

type ByteaArray = (Buffer | null | ByteaArray)[];

type TypeId = Parameters<typeof pg.types.getTypeParser>[0];

const BYTEA_ARRAY_OID = 1001 as TypeId;

const defaultParser = pg.types.getTypeParser(BYTEA_ARRAY_OID, "text") as (
  value: string,
) => ByteaArray;

const OPEN = 123; // {
const CLOSE = 125; // }
const COMMA = 44; // ,
const QUOTE = 34; // "
const BACKSLASH = 92; // \
const LOWER_X = 120; // x

// The fast path, or null when the text is not in the shape it reads.
export function parseHexByteaArray(source: string): ByteaArray | null {
  if (source.charCodeAt(0) !== OPEN) return null;
  const root: ByteaArray = [];
  const open: ByteaArray[] = [];
  let i = 1;
  let current: ByteaArray = root;
  const n = source.length;
  while (i < n) {
    const ch = source.charCodeAt(i);
    if (ch === OPEN) {
      const inner: ByteaArray = [];
      current.push(inner);
      open.push(current);
      current = inner;
      i++;
    } else if (ch === CLOSE) {
      const outer = open.pop();
      i++;
      if (outer === undefined) return i === n ? root : null;
      current = outer;
    } else if (ch === COMMA) {
      i++;
    } else if (ch === QUOTE) {
      const end = source.indexOf('"', i + 1);
      if (
        end < 0 ||
        source.charCodeAt(i + 1) !== BACKSLASH ||
        source.charCodeAt(i + 2) !== BACKSLASH ||
        source.charCodeAt(i + 3) !== LOWER_X
      ) {
        return null;
      }
      current.push(Buffer.from(source.slice(i + 4, end), "hex"));
      i = end + 1;
    } else if (source.startsWith("NULL", i)) {
      current.push(null);
      i += 4;
    } else {
      return null;
    }
  }
  return null;
}

export function parseByteaArray(source: string): ByteaArray {
  return parseHexByteaArray(source) ?? defaultParser(source);
}

// The `types` option for a pg Pool: `bytea[]` in text by the parser above, everything else as pg
// parses it.
export const checkpointTypes = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === BYTEA_ARRAY_OID && format !== "binary") return parseByteaArray;
    return pg.types.getTypeParser(oid, format ?? "text");
  },
};
