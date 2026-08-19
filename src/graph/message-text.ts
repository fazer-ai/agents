import type { MessageContent } from "@langchain/core/messages";

// Normalizes a message's `content` to plain text. Providers hand back either a string or an array
// of content blocks, and both shapes have to be read in two places: the reply path, which posts the
// text, and the history ceiling, which measures it. An unrecognized block collapses to "" rather
// than throwing — neither caller can afford to fail over a shape it did not expect.
export function contentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object" || !("text" in block)) return "";
      return String((block as unknown as { text: unknown }).text);
    })
    .join("");
}
