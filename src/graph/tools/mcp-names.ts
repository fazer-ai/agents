// The names the assembly gives an agent's MCP tools, as a pure function of the servers' slugs and
// the tools each grant enables, so the console and the decisions engine ask the same question the
// assembly answers (namespacedToolName in ./mcp.ts).

export const MCP_TOOL_NAME_MAX = 64;

// `mcp__<slug>__<tool>` before any suffix: the slug trimmed to make room when the whole name passes
// the limit, since the bare tool name is the informative part.
export function mcpRuntimeBase(slug: string, tool: string): string {
  const name = `mcp__${slug}__${tool}`;
  if (name.length <= MCP_TOOL_NAME_MAX) return name;
  const room = MCP_TOOL_NAME_MAX - ("mcp".length + 4 + tool.length);
  const trimmed = room > 0 ? slug.slice(0, room) : "";
  return `mcp__${trimmed}__${tool}`.slice(0, MCP_TOOL_NAME_MAX);
}

// The names that may belong to more than one server's tool, depending on the order the servers are
// read in: every tool of servers that share a slug, every name two servers' tools reach once the
// slug is trimmed, and every name a collision suffix may land on. A rule that names one of them may
// call another server's tool, so it is not offered and does not run.
export function ambiguousMcpNames(
  servers: readonly { slug: string; tools: readonly string[] }[],
): Set<string> {
  // A grant with no tool enabled exposes nothing (the assembly skips it), so it shares no name.
  const live = servers.filter((s) => s.tools.length > 0);
  const bySlug = new Map<string, number>();
  for (const s of live) bySlug.set(s.slug, (bySlug.get(s.slug) ?? 0) + 1);
  const byBase = new Map<string, number>();
  const out = new Set<string>();
  let total = 0;
  for (const s of live) {
    // A tool listed twice in one grant is exposed once (filterAllowed).
    for (const tool of new Set(s.tools)) {
      total += 1;
      const base = mcpRuntimeBase(s.slug, tool);
      byBase.set(base, (byBase.get(base) ?? 0) + 1);
      if ((bySlug.get(s.slug) ?? 0) > 1) out.add(base);
    }
  }
  for (const [base, count] of byBase) {
    if (count > 1) out.add(base);
  }
  for (const base of [...out]) {
    for (let i = 2; i <= total + 1; i++) {
      const suffix = `_${i}`;
      out.add(base.slice(0, MCP_TOOL_NAME_MAX - suffix.length) + suffix);
    }
  }
  return out;
}
