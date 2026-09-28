import { serverNowDate } from "@/client/lib/serverClock";
import {
  type ObservabilityConfig,
  readObservabilityConfig,
  type StorableObservability,
  storableObservability,
} from "@/modules/flowlog/settings";

// The `observability` block's form ↔ stored pair: the Behavior save REPLACES the block, so a field
// the form drops is DELETED from the bag on the next save. Reading goes through the runtime's own
// reader because a REST or imported bag can carry the string "true", which the runtime honors; a
// stricter read here would show a switch off while values are logged, then persist that.

export type ObservabilityFormState = ObservabilityConfig;

// `now` defaults to the SERVER's clock, and that default is load-bearing: the reader resolves the
// debug window here, so on a browser with a wrong clock an OPEN window would read as expired, the
// form would hold `null`, and the next unrelated Behavior save would disarm it. This read, not the
// component's, is the one that persists.
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
