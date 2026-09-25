import type { ChatwootClient } from "@/modules/chatwoot/client";

// WHICH MESSAGES A TURN PUT IN THE CONVERSATION (issue #855), noted where Chatwoot hands their ids
// back rather than at each call site that sends. A turn speaks through the reply, a split into
// balloons, a voice note, an attachment, the handoff's closing line, a template, a private note and
// any tool that writes to the conversation; a list of those sites is the list the next sender is
// missing from. Every one of them goes through the turn's client, so the client is where the note is
// taken.
//
// A create runs on the REAL client, so one that calls another inside it (`sendPrivateNote` is a
// `sendMessage`) is noted once, by the outer call. Every other method runs on the wrapper, so a
// helper that sends through one of the creates is noted, once, by that create.

const CREATES = [
  "sendMessage",
  "sendPrivateNote",
  "sendAudioMessage",
  "sendFileAttachment",
  "sendTemplate",
] as const satisfies readonly (keyof ChatwootClient)[];

// A turn that sends more than this is a runaway, and the line it is written on is bounded.
export const SENT_IDS_CAP = 50;

export interface RecordedClient {
  client: ChatwootClient;
  // The ids Chatwoot returned, in the order the creates RETURNED.
  sentIds: () => number[];
}

export function recordSends(client: ChatwootClient): RecordedClient {
  const ids: number[] = [];
  const note = (res: unknown): void => {
    const id = (res as { id?: unknown } | null)?.id;
    if (
      typeof id === "number" &&
      Number.isSafeInteger(id) &&
      ids.length < SENT_IDS_CAP
    ) {
      ids.push(id);
    }
  };
  const creates = new Set<PropertyKey>(CREATES);
  const recorded = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (!creates.has(prop)) return value.bind(receiver);
      return async (...args: unknown[]) => {
        const res = await (value as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        note(res);
        return res;
      };
    },
  });
  return { client: recorded, sentIds: () => [...ids] };
}
