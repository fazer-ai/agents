import { intRange, type NumberRange } from "@/lib/number-range";

// The knowledge numbers the REST body, the MCP tool, the writer and the console all read.
// Browser-safe: source.ts and documents.ts reach the database, this file does not.
export const SYNC_INTERVAL_MINUTES = intRange(5, 24 * 60);
export const CHUNK_SIZE_RANGE = intRange(100, 8000);

// The overlap is measured against the chunk it overlaps: at most half of it. A write that sends the
// overlap alone is held to half the largest chunk here, and to half the stored one by the writer.
export const CHUNK_OVERLAP_RANGE = intRange(
  0,
  Math.floor(CHUNK_SIZE_RANGE.max / 2),
);
export function chunkOverlapRange(chunkSize: number): NumberRange {
  return intRange(0, Math.floor(chunkSize / 2));
}
