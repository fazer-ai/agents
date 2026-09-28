// Allowlist of stdio MCP launchers shipped in the runtime image (Dockerfile). A stdio
// McpServerConnection's `command` must start with one of these; the rest is the launcher's args.
// Dependency-free so the server (validation) and the client (the launcher picker) share it.
//   bunx: npm-published servers, the drop-in wherever a server's docs say `npx`
//         (`bunx <pkg>`, or `bunx -p <pkg> <bin>` when the bin name differs).
//   uvx:  Python servers (from `uv`, a static musl binary that provisions CPython).
// npx is intentionally NOT here: the Bun image has no Node.
export const MCP_STDIO_LAUNCHERS = ["bunx", "uvx"] as const;

export type McpStdioLauncher = (typeof MCP_STDIO_LAUNCHERS)[number];

export const DEFAULT_MCP_STDIO_LAUNCHER: McpStdioLauncher = "bunx";

export function isMcpStdioLauncher(s: string): s is McpStdioLauncher {
  return (MCP_STDIO_LAUNCHERS as readonly string[]).includes(s);
}

// The launcher is the first whitespace-delimited token of `command`.
export function stdioCommandLauncher(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

// Parse a stored stdio `command` ("bunx -y @scope/srv") into { launcher, args } for the edit form.
// An `npx ...` command maps to bunx (bunx is the drop-in replacement); any other unknown first token
// falls back to the default launcher with the remaining tokens as args (pre-launch: no real legacy
// rows, so this branch is effectively dead — it only avoids crashing the picker on odd input).
export function parseStdioCommand(command: string): {
  launcher: McpStdioLauncher;
  args: string;
} {
  const parts = command.trim().split(/\s+/);
  const first = parts[0] ?? "";
  const rest = parts.slice(1).join(" ");
  if (isMcpStdioLauncher(first)) return { launcher: first, args: rest };
  if (first === "npx") return { launcher: "bunx", args: rest };
  return { launcher: DEFAULT_MCP_STDIO_LAUNCHER, args: rest };
}

// Compose a launcher + args string back into the stored `command`.
export function composeStdioCommand(launcher: string, args: string): string {
  return `${launcher} ${args}`.trim();
}

// Conservative charset for a single command token. Covers everything a real MCP launcher arg needs:
// package specs (`@scope/name@version`), versions (`@latest`), flags (`-p`, `--from`, `--package`),
// key=value, paths, URLs (the `:` / `/`). Deliberately EXCLUDES shell metacharacters
// (`; | & $ \` ( ) < > ' " \ {} *` etc.), whitespace-in-token, and control chars.
const STDIO_TOKEN_RE = /^[A-Za-z0-9@._:/=+,-]+$/;
const MAX_STDIO_COMMAND_LEN = 512;

// True when every whitespace-delimited token of `command` is within the safe charset and the whole
// string is within the length cap. This is DEFENSE IN DEPTH, not the primary barrier: the MCP stdio
// transport spawns shell-free (cross-spawn, `shell: false`), so a `; shutdown now` is never parsed by
// a shell — its first token would just be a literal (non-launcher) executable name and the launcher
// allowlist already rejects it. We still reject metacharacters/control chars so the input stays
// benign if the spawn path ever changes and to refuse obviously-hostile values outright.
export function hasSafeStdioCommandChars(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MAX_STDIO_COMMAND_LEN) return false;
  return trimmed.split(/\s+/).every((tok) => STDIO_TOKEN_RE.test(tok));
}
