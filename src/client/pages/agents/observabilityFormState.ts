import { serverNowDate } from "@/client/lib/serverClock";
import {
  type ObservabilityConfig,
  readObservabilityConfig,
  type StorableObservability,
  storableObservability,
} from "@/modules/flowlog/settings";

// The `observability` block's form ↔ stored pair, extracted for the reason the Behavior save states
// about every block: that save REPLACES the block, so a field the form drops is DELETED from the bag
// on the next save. `tts.baseURL` was lost exactly that way once, and this block acquired its second
// key (`fullDetailUntil`, issue #58) with the same exposure — a payload written out by hand loses
// whatever the writer forgot, silently, and only on save.
//
// Reading goes through the runtime's own reader rather than a hand-rolled check, because a bag that
// came from REST or an import can carry the string "true", which the runtime honors: reading it
// stricter here would show a switch off while values were being logged, and then persist that lie.

export type ObservabilityFormState = ObservabilityConfig;

// `now` defaults to the SERVER's clock, and that default is the load-bearing part. The reader
// resolves the debug window here, so on a browser whose clock is wrong an OPEN window reads as
// expired — and the form then holds `null`, which means the next save of any unrelated Behavior
// field serializes that null and disarms a mode the operator never touched. Judging the window in
// the component was not enough: this is the other read of it, and it is the one that persists.
export function observabilityToForm(
  settings: unknown,
  now: Date = serverNowDate(),
): ObservabilityFormState {
  return readObservabilityConfig(settings, now);
}

// Only the STORED keys travel. `fullDetail` is DERIVED from `fullDetailUntil` on read, so sending it
// back would persist a computed value that the next read would recompute anyway — and would let the
// two disagree.
export function observabilityToStored(
  form: ObservabilityFormState,
): StorableObservability {
  return storableObservability(form);
}
