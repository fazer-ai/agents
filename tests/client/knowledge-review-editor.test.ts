import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  suggestionReviewToForm,
  suggestionReviewToStored,
} from "@/client/pages/agents/knowledgeFormState";

// The Knowledge section holds two things the editor saves in different requests: the knowledge
// grants (written by both the Tools and the Knowledge save, through the grants PUT) and the reviewer
// model (written only by the Knowledge save, in the settings bag). Checked on the source, like the
// other editor save tests, because rendering the editor pulls auth, theme, toast and a live catalog.
const SRC = readFileSync("src/client/pages/agents/AgentEditorPage.tsx", "utf8");

function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start + from.length);
  expect(end, `closing anchor not found after ${from}: ${to}`).toBeGreaterThan(
    -1,
  );
  return src.slice(start, end);
}

describe("the reviewer model in the agent editor", () => {
  test("a Tools save does not mark an unsaved reviewer model as saved", () => {
    const save = between(SRC, "async function saveTools(", "\n  }\n");
    // NOTE: an unconditional rebase of "knowledge" would clear the dirty mark and the navigation
    // guard over a reviewer change the Tools PATCH never carried.
    expect(save).not.toMatch(
      /\n\s*bumpSync\("tools", "knowledge"\);\n\s*settleRefusalFor/,
    );
    expect(save).toContain(
      "suggestionReviewToForm(agentRes.data.agent.settings)",
    );
    expect(save).toMatch(/if \(reviewPending\) bumpSync\("tools"\);/);
  });

  test("save all writes the Knowledge section through its own save", () => {
    const all = between(SRC, "async function saveAllDirty(", "\n  }\n");
    expect(all).toMatch(/if \(dirty\.knowledge\) \{\s*await saveGrants\(\);/);
    expect(all).not.toMatch(/dirty\.tools \|\| dirty\.knowledge/);
  });

  test("the reviewer fields are locked while the Knowledge save runs", () => {
    const tab = readFileSync(
      "src/client/pages/agents/KnowledgeTab.tsx",
      "utf8",
    );
    const section = between(tab, 'id="kb-review"', "</Section>");
    expect(section).toContain("<fieldset disabled={saving}");
    expect(section.indexOf("<fieldset")).toBeLessThan(
      section.indexOf('label={t("editor.provider"'),
    );
    expect(section).toContain("</fieldset>");
  });

  test("the stored block round-trips through the form, and an empty form inherits the agent's model", () => {
    const form = suggestionReviewToForm({
      knowledge: {
        suggestionReview: {
          provider: "openai",
          model: "gpt-5-mini",
          credentialRef: null,
          baseURL: null,
        },
      },
    });
    expect(
      suggestionReviewToForm({ knowledge: suggestionReviewToStored(form) }),
    ).toEqual(form);
    expect(suggestionReviewToForm({}).provider).toBeFalsy();
  });
});
