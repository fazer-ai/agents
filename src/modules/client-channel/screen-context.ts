// The screen context this channel puts ahead of a user's message in the thread
// (`<contexto-da-tela>…</contexto-da-tela>`), and the user's own words without it. The JSON inside
// carries no raw newline, so the first closing tag on its own line ends it.
const SCREEN_CONTEXT =
  /^<contexto-da-tela>\n[\s\S]*?\n<\/contexto-da-tela>\n\n/;

// The serialized context a message may carry, the same bound a browser tool's answer gets. It rides
// in the checkpointed message, which the history ceiling never trims, so the route is the only place
// that can bound it.
export const MAX_SCREEN_CONTEXT_CHARS = 20_000;

export function screenContextTooLarge(
  context: Record<string, unknown> | undefined,
): boolean {
  return (
    context !== undefined &&
    JSON.stringify(context).length > MAX_SCREEN_CONTEXT_CHARS
  );
}

export function withScreenContext(
  message: string,
  context: Record<string, unknown> | undefined,
): string {
  if (!context || Object.keys(context).length === 0) return message;
  return `<contexto-da-tela>\n${JSON.stringify(context)}\n</contexto-da-tela>\n\n${message}`;
}

export function withoutScreenContext(content: string): string {
  return content.replace(SCREEN_CONTEXT, "");
}
