import type { NormalizedChatwootEvent } from "./types";

// The admission lane a delivery waits in: a customer message (a turn) or anything else (a status or
// assignment change, a note, an outgoing echo). Its own module so the ack, which stores it on the row,
// and the queue, which admits by it, read one predicate.
export type AdmissionLane = "turn" | "meta";

export function admissionLaneOf(event: NormalizedChatwootEvent): AdmissionLane {
  return event.message?.messageType === "incoming" && !event.message.private
    ? "turn"
    : "meta";
}
