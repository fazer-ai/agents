import { tool } from "@langchain/core/tools";
import { z } from "zod";

// THE MODEL'S WAY TO SAY "THIS ONE HAS TO BE READ" (issue #859). A voice note is the wrong medium for
// a price table, a list of steps or a code to copy, and the model is the one that knows, while it
// writes, that this reply is one of those. Calling this sends THIS reply as text; the customer's
// stored preference and every later turn are untouched.
//
// Offered on EVERY turn of an agent that turned it on, text and audio alike: the tool definitions are
// part of the prefix a provider caches, so a toolset that changed with the reply's modality would pay
// a cache write on every switch. On a turn that already goes as text it is a no-op that says so.
//
// No arguments, on purpose: whatever the model wrote into one would be customer-derived text in the
// tool's log line, and the decision needs no reason to be carried out. The trail records THAT the
// model chose text (a `tts` line, reason `model_choice`), never why in its own words.
export const REPLY_AS_TEXT_TOOL = "reply_as_text";

// The turn's record of the choice, owned by whoever delivers the reply (the reactive turn, the
// playground) and read once, at delivery. A holder rather than a return value because the tool runs
// inside the graph and the delivery happens after it.
export interface ReplyChoice {
  textChosen: boolean;
}

export const REPLY_AS_TEXT_DONE =
  "Done: this reply will be sent as a text message, not a voice note. Write it to be read.";

export function buildReplyAsTextTool(opts: {
  choice: ReplyChoice;
  note: string | null;
}) {
  const base =
    "Send THIS reply as a text message instead of a voice note. Call it before writing the reply when the customer needs to read or keep what you are about to say: a table of prices, several options to compare, steps to follow, a code, an address or anything to copy. It changes only this reply; the customer's audio preference and later replies are untouched. When the reply already goes as text it changes nothing.";
  const note = opts.note?.trim();
  return tool(
    async () => {
      opts.choice.textChosen = true;
      return REPLY_AS_TEXT_DONE;
    },
    {
      name: REPLY_AS_TEXT_TOOL,
      description: note ? `${base}\n\nOperator guidance: ${note}` : base,
      schema: z.object({}),
    },
  );
}
