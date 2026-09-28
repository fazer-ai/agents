import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";

// The slug rules, kept free of the database so the CONSOLE can apply them too.
//
// The console derives the slug live while the operator types the name, and shows the resulting tool
// name in the form. Doing that against a copy of these rules is how the two ends drift: the console
// would accept a name the server then refuses, or preview a tool name the server would not produce.
// One module, imported by both. `templates.ts` re-exports it so existing importers keep their path
// (the same arrangement `graph/tools/catalog.ts` uses for the tool-name catalogs).

// The slug becomes the agent's tool name, so it lives in the same character set a tool name does.
// It is DERIVED from the name (renaming a template renames its tool), so every derivation must pass
// `slugProblem`: a leading digit is prefixed rather than stripped, or "2026" and "2027" would collide.
export function slugifyTemplateName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SLUG_MAX);
  if (!slug) return "documento";
  return (/^[a-z]/.test(slug) ? slug : `doc_${slug}`).slice(0, SLUG_MAX);
}

export function documentToolName(slug: string): string {
  return `send_${slug}`;
}

// A slug whose tool name would collide with a native tool is refused HERE, when it is written,
// because the collision only shows up later as an agent that has two tools with one name and no way
// for the operator to tell which one the model called.
// The REST schema caps this at 40, but MCP and an imported bundle do not go through it, and the slug
// becomes a TOOL NAME: providers cap a function name (OpenAI at 64), and a name over the cap is
// rejected with the whole request — the agent stops replying, for one template nobody thought was
// dangerous. The bound belongs where every transport passes.
export const SLUG_MAX = 40;

export function slugProblem(slug: string): string | null {
  if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
    return "the slug must start with a letter and contain only lowercase letters, digits and underscores";
  }
  if (slug.length > SLUG_MAX) {
    return `the slug must be at most ${SLUG_MAX} characters (it becomes the tool name send_${"<slug>"}, and providers cap a tool name)`;
  }
  if (
    (NATIVE_TOOL_NAMES as readonly string[]).includes(documentToolName(slug))
  ) {
    return `the slug would produce the tool name "${documentToolName(slug)}", which is already a built-in tool`;
  }
  return null;
}
