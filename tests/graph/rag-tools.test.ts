import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  buildRagTools,
  resolveSearchScope,
  resolveSuggestTarget,
} from "@/graph/tools/rag";

// The search_knowledge tool description must surface the selected bases (name — description) so the
// agent knows what it can look up; with no bases it falls back to the generic instruction. With >= 2
// bases it also exposes the optional knowledge_base narrowing parameter, biased toward the default.
const ctxBase = {
  tenantId: 1n,
  base: {} as PrismaClient,
  knowledgeBaseIds: [10n, 11n],
  threadId: "t:playground:1:x",
};

function searchToolOf(ctx: Parameters<typeof buildRagTools>[0]) {
  const tools = buildRagTools(ctx, ["search_knowledge"]);
  const search = tools.find((t) => t.name === "search_knowledge");
  if (!search) throw new Error("search_knowledge not built");
  return search;
}

function searchDesc(ctx: Parameters<typeof buildRagTools>[0]): string {
  return searchToolOf(ctx).description ?? "";
}

describe("search_knowledge description", () => {
  test("lists the selected bases with their descriptions", () => {
    const d = searchDesc({
      ...ctxBase,
      knowledgeBases: [
        { id: 10n, name: "Planos", description: "Tabela de preços e planos" },
        { id: 11n, name: "FAQ", description: null },
      ],
    });
    expect(d).toContain("<knowledge_bases>");
    expect(d).toContain(
      '<knowledge_base name="Planos">Tabela de preços e planos</knowledge_base>',
    );
    expect(d).toContain('<knowledge_base name="FAQ"/>');
  });

  test("falls back to the generic instruction when no bases are known", () => {
    const d = searchDesc({ ...ctxBase, knowledgeBases: [] });
    expect(d).not.toContain("<knowledge_bases>");
    expect(d.toLowerCase()).toContain("search the knowledge base");
  });

  test("with >= 2 bases the narrowing directive biases toward the default (all)", () => {
    const d = searchDesc({
      ...ctxBase,
      knowledgeBases: [
        { id: 10n, name: "Planos", description: null },
        { id: 11n, name: "FAQ", description: null },
      ],
    });
    expect(d).toContain("Leave knowledge_base unset");
    expect(d.toLowerCase()).toContain("highly confident");
  });

  test("with a single base there is no narrowing directive", () => {
    const d = searchDesc({
      ...ctxBase,
      knowledgeBaseIds: [10n],
      knowledgeBases: [{ id: 10n, name: "Planos", description: null }],
    });
    // The single base is still listed (so the model knows what's searchable)...
    expect(d).toContain('<knowledge_base name="Planos"/>');
    // ...but the narrowing directive (only meaningful with >= 2 bases) is absent.
    expect(d).not.toContain("Leave knowledge_base unset");
  });
});

describe("search_knowledge schema (knowledge_base parameter)", () => {
  // The tool exposes its zod schema; with >= 2 bases knowledge_base is a constrained enum (an
  // unknown base name is rejected), with < 2 it is absent (zod strips the unknown key).
  function schemaOf(ctx: Parameters<typeof buildRagTools>[0]) {
    return searchToolOf(ctx).schema as z.ZodTypeAny;
  }

  test(">= 2 bases: only listed base names are accepted", () => {
    const schema = schemaOf({
      ...ctxBase,
      knowledgeBases: [
        { id: 10n, name: "Planos", description: null },
        { id: 11n, name: "FAQ", description: null },
      ],
    });
    expect(
      schema.safeParse({ query: "x", knowledge_base: "Planos" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ query: "x", knowledge_base: "Inexistente" }).success,
    ).toBe(false);
    // The parameter is optional: omitting it is valid (the default, search all).
    expect(schema.safeParse({ query: "x" }).success).toBe(true);
  });

  test("single base: knowledge_base is not part of the schema (stripped)", () => {
    const schema = schemaOf({
      ...ctxBase,
      knowledgeBaseIds: [10n],
      knowledgeBases: [{ id: 10n, name: "Planos", description: null }],
    });
    const parsed = schema.safeParse({ query: "x", knowledge_base: "Planos" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("knowledge_base" in (parsed.data as object)).toBe(false);
    }
  });
});

describe("resolveSearchScope", () => {
  const named = [
    { id: 10n, name: "Planos" },
    { id: 11n, name: "FAQ" },
  ];

  test("a duplicate name resolves to EVERY matching base (nothing excluded)", () => {
    const dup = [
      { id: 10n, name: "Planos" },
      { id: 12n, name: "Planos" },
      { id: 11n, name: "FAQ" },
    ];
    expect(resolveSearchScope("Planos", dup, [10n, 11n, 12n])).toEqual([
      10n,
      12n,
    ]);
  });

  test("an unknown pick falls back to all selected bases", () => {
    expect(resolveSearchScope("Nope", named, [10n, 11n])).toEqual([10n, 11n]);
  });

  test("no pick falls back to all selected bases", () => {
    expect(resolveSearchScope(undefined, named, [10n, 11n])).toEqual([
      10n,
      11n,
    ]);
  });

  test("empty fallback resolves to undefined (all tenant bases, RLS-scoped)", () => {
    expect(resolveSearchScope(undefined, named, [])).toBeUndefined();
    expect(resolveSearchScope("Nope", named, [])).toBeUndefined();
  });
});

function suggestToolOf(ctx: Parameters<typeof buildRagTools>[0]) {
  const tools = buildRagTools(ctx, ["suggest_kb_entry"]);
  const suggest = tools.find((t) => t.name === "suggest_kb_entry");
  if (!suggest) throw new Error("suggest_kb_entry not built");
  return suggest;
}

describe("suggest_kb_entry schema (target base)", () => {
  function schemaOf(ctx: Parameters<typeof buildRagTools>[0]) {
    return suggestToolOf(ctx).schema as z.ZodTypeAny;
  }

  test(">= 2 bases: knowledge_base is REQUIRED and constrained to listed names", () => {
    const schema = schemaOf({
      ...ctxBase,
      knowledgeBases: [
        { id: 10n, name: "Planos", description: null },
        { id: 11n, name: "FAQ", description: null },
      ],
    });
    expect(
      schema.safeParse({ content: "x", knowledge_base: "Planos" }).success,
    ).toBe(true);
    // Omitting the base now fails: the model must say where the entry belongs.
    expect(schema.safeParse({ content: "x" }).success).toBe(false);
    expect(
      schema.safeParse({ content: "x", knowledge_base: "Inexistente" }).success,
    ).toBe(false);
  });

  test("the description tells the model the base is required and lists the options", () => {
    const d =
      suggestToolOf({
        ...ctxBase,
        knowledgeBases: [
          { id: 10n, name: "Planos", description: null },
          { id: 11n, name: "FAQ", description: null },
        ],
      }).description ?? "";
    expect(d).toContain("Set knowledge_base");
    expect(d).toContain("Planos");
    expect(d).toContain("FAQ");
  });

  test("single base: knowledge_base is not part of the schema (filed automatically)", () => {
    const ctx = {
      ...ctxBase,
      knowledgeBaseIds: [10n],
      knowledgeBases: [{ id: 10n, name: "Planos", description: null }],
    };
    const schema = schemaOf(ctx);
    expect(schema.safeParse({ content: "x" }).success).toBe(true);
    const parsed = schema.safeParse({ content: "x", knowledge_base: "Planos" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("knowledge_base" in (parsed.data as object)).toBe(false);
    }
    expect(suggestToolOf(ctx).description).toContain("filed under");
  });
});

describe("resolveSuggestTarget", () => {
  const named = [
    { id: 10n, name: "Planos" },
    { id: 11n, name: "FAQ" },
  ];

  test("a duplicate name resolves to the FIRST matching base (single target)", () => {
    const dup = [
      { id: 10n, name: "Planos" },
      { id: 12n, name: "Planos" },
    ];
    expect(resolveSuggestTarget("Planos", dup, [10n, 12n])).toBe(10n);
  });

  test("no pick with a single named base defaults to it", () => {
    expect(
      resolveSuggestTarget(undefined, [{ id: 10n, name: "Planos" }], [10n]),
    ).toBe(10n);
  });

  test("an unknown pick defaults to the first named base", () => {
    expect(resolveSuggestTarget("Nope", named, [10n, 11n])).toBe(10n);
  });

  test("no named bases falls back to the first selected id", () => {
    expect(resolveSuggestTarget(undefined, [], [99n])).toBe(99n);
  });

  test("nothing configured resolves to null", () => {
    expect(resolveSuggestTarget(undefined, [], [])).toBeNull();
  });
});
