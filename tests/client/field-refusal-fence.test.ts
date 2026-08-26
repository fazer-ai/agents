import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// THE GUARD AGAINST THE NEXT FORM THAT SENDS A FIELD REFUSAL TO A BANNER.
//
// #231 put the refused field on the wire, #232 built the state that renders it at the control, and
// this sweep wired the console. What comes back without a guard is the form written next week: it
// will read the server's sentence (the other fence in this directory sees to that) and drop it into
// a toast or an error line, which is far from the input and, on a long form, leaves the operator
// counting down the fields to work out which one the server meant.
//
// Two rules, because a form can fail this in two directions and only one of them is visible:
//
//   1. a form that WRITES holds its refusal — `useFieldRefusal`, or a named reason not to;
//   2. every name a form DECLARES is read back by an `at(…)` call in the same file. A declared name
//      with no control behind it is worse than not declaring it: `placeRefusal` marks it as placed
//      and the caller then keeps the toast silent, so the refusal reaches nobody at all. Measured
//      while wiring ToolEditModal, which declared `allowedHosts` and renders no such input.

const ROOT = "src/client";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

// A control the operator types or picks into. The pickers are named too: a credential or a business
// hours selection is refused by the server like any other value.
const RENDERS_A_CONTROL =
  /<(?:FormField|Input|Textarea|Select|CredentialPicker)\b/;

// A WRITE, and only a write. `POST` is also how this API asks two questions whose answer is a list
// (the model catalog, the voice catalog) and how it runs a connection test — none of those carry a
// form's values, so none of them can refuse one.
const WRITES = /\.(?:post|put|patch)\s*\(/;
const NOT_A_WRITE = /\b(?:list|preview|test|extract|transcribe|discover)\b/;

export function writesAForm(src: string): boolean {
  if (!RENDERS_A_CONTROL.test(src)) return false;
  for (const line of src.split("\n")) {
    if (!WRITES.test(line)) continue;
    if (NOT_A_WRITE.test(line)) continue;
    if (!/\bapi\b/.test(line) && !/^\s*\./.test(line)) continue;
    return true;
  }
  return false;
}

// The names a file declares it can render, from the `as const` list every form keeps next to its
// component. Read from the source rather than imported because the point is to compare the
// declaration against the RENDER, and only the source has both.
export function declaredFields(src: string): string[] {
  const at = src.indexOf("useFieldRefusal(");
  if (at === -1) return [];
  const arg = src.slice(at + "useFieldRefusal(".length).match(/^\s*(\w+)/);
  if (!arg) return [];
  const list = new RegExp(`${arg[1]}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!list) return [];
  return [...(list[1] as string).matchAll(/["']([^"']+)["']/g)].map(
    (m) => m[1] as string,
  );
}

// The names the file actually reads back onto a control.
export function readFields(src: string): Set<string> {
  return new Set(
    [...src.matchAll(/\.at\(\s*["']([^"']+)["']/g)].map((m) => m[1] as string),
  );
}

export function silentDeclarations(src: string): string[] {
  const read = readFields(src);
  return declaredFields(src).filter((name) => !read.has(name));
}

// A form that writes and does not hold its refusal, with the reason. Asserted in both directions, so
// an entry describing code that no longer exists fails too.
const NOT_A_REFUSABLE_FORM: Record<string, string> = {
  "components/GoogleOAuthSection.tsx":
    "Its POSTs are the OAuth dance itself — authorize and disconnect — with no value of the operator's in the body. The fields it renders are the connected account, read-only.",
  "components/McpOAuthSection.tsx":
    "Same section, same two calls, same reason: nothing here is a value the server can refuse by name.",
};

// A form that holds SOME of its refusals, with what is left. Neither rule above can see this — rule
// 1 is satisfied by the hook being called at all — so it is a declaration, pinned by size, and the
// only thing keeping the sweep honest about where it stopped.
const PARTIALLY_HELD: Record<string, string> = {
  "pages/agents/AgentEditorPage.tsx":
    "Holds `name` and `systemPrompt`, the two values it renders a control for directly. Everything else it writes lives in bags (`settings.tts.normalizeCredentialRef`, `guardrails.output.templateMessage`) behind eight tabs, so placing one of those means also taking the operator to the tab that holds it — the deep-link TEXT_CAP_TARGETS already maps for config-health warnings. Left to fazer-ai/agents#349.",
};

describe("a form that writes holds the refusal it gets", () => {
  test("every partially held form still holds something", () => {
    // Both directions: an entry describing a file that stopped calling the hook is describing code
    // that no longer exists, and an entry for a file that got fully wired should be deleted.
    for (const file of Object.keys(PARTIALLY_HELD)) {
      expect(
        readFileSync(join(ROOT, file), "utf8").includes("useFieldRefusal"),
        `${file} is listed as partially held and holds nothing`,
      ).toBe(true);
    }
  });

  test("the partial ledger is pinned to its size", () => {
    expectWaiverLedger("PARTIALLY_HELD", PARTIALLY_HELD, 1);
  });

  test("the predicate sees a form that writes", () => {
    expect(
      writesAForm(`
        <FormField label="x"><Input value={v} /></FormField>
        const { error } = await api.api.v1.tools.post(body);
      `),
    ).toBe(true);
  });

  test("a POST that asks for a list is not a write", () => {
    // The model and voice catalogs are POSTed because the query is a body, not because anything of
    // the operator's is being stored. A form next to one of those has nothing to place.
    expect(
      writesAForm(`
        <Select value={v} />
        const { data } = await api.api.v1.agents.models.list.post({ provider });
      `),
    ).toBe(false);
  });

  test("a screen with no control is not a form", () => {
    expect(
      writesAForm(`const { error } = await api.api.v1.agents.post(body);`),
    ).toBe(false);
  });

  test("a declared name with no control behind it is flagged", () => {
    const src = `
      const FIELDS = ["name", "allowedHosts"] as const;
      const refusal = useFieldRefusal(FIELDS);
      <FormField error={refusal.at("name", current.name)} />
    `;
    expect(silentDeclarations(src)).toEqual(["allowedHosts"]);
  });

  test("a declared name that is read is not flagged", () => {
    const src = `
      const FIELDS = ["name"] as const;
      const refusal = useFieldRefusal(FIELDS);
      <FormField error={refusal.at("name", current.name)} />
    `;
    expect(silentDeclarations(src)).toEqual([]);
  });

  test("every form that writes holds its refusal", () => {
    const unheld = sources(ROOT)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return writesAForm(src) && !src.includes("useFieldRefusal");
      })
      .map((f) => f.slice(`${ROOT}/`.length));
    expect(
      unheld.filter((f) => !(f in NOT_A_REFUSABLE_FORM)),
      "these write a form and send every refusal to a banner: wire useFieldRefusal, or name the reason not to",
    ).toEqual([]);
  });

  test("no form declares a name it never renders", () => {
    const silent = sources(ROOT).flatMap((f) =>
      silentDeclarations(readFileSync(f, "utf8")).map(
        (name) => `${f.slice(`${ROOT}/`.length)} :: ${name}`,
      ),
    );
    expect(
      silent,
      "a declared name with no `at(…)` behind it swallows its refusal: render it, or stop declaring it",
    ).toEqual([]);
  });

  test("the abstention ledger is pinned to its size", () => {
    expectWaiverLedger("NOT_A_REFUSABLE_FORM", NOT_A_REFUSABLE_FORM, 2);
  });
});
