import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codeSkeleton } from "@/tests/client/error-toast-reason.test";
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
  return RENDERS_A_CONTROL.test(src) && writeHandlers(src).length > 0;
}

// One function of a component, by name. Both spellings this tree uses — `async function save()` and
// `const submit = async () => {` — at the component's own indentation, so a callback nested inside
// one is part of its body rather than a handler of its own.
//
// Named and not merely located, because the whole point is to say WHICH handler is unheld: a file
// with six forms is not answered by "this file calls the hook somewhere", which is what the previous
// version of this fence asked and what let `useKnowledgeManager`'s add-text form through with a
// holder that was read and never written.
const HANDLER_HEAD =
  /\n {2}(?:export )?(?:async function (\w+)|const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>|function (\w+))/g;

export function handlers(src: string): { name: string; body: string }[] {
  // Bounded by its own closing brace, not by where the next handler starts. Slicing to the next head
  // makes the LAST handler of a nested component swallow everything after it, and this file's whole
  // subject is per-handler attribution: measured, that made `ChannelsPage`'s `select` — which awaits
  // a callback and no request at all — read as a write of the function three declarations below it.
  const code = codeSkeleton(src);
  return [...src.matchAll(HANDLER_HEAD)].map((m) => {
    const open = code.indexOf("{", m.index + (m[0] as string).length - 3);
    let depth = 0;
    let end = src.length;
    for (let i = open; i >= 0 && i < code.length; i++) {
      const c = code[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    return {
      name: (m[1] ?? m[2] ?? m[3]) as string,
      body: src.slice(m.index, end),
    };
  });
}

// The handlers that write a form's values back. `POST` is also how this API asks two questions whose
// answer is a list (the model catalog, the voice catalog) and how it runs a connection test — none of
// those carry a form's values, so none of them can refuse one.
export function writeHandlers(src: string): string[] {
  return handlers(src)
    .filter((h) =>
      h.body
        .split("\n")
        .some((line) => WRITES.test(line) && !NOT_A_WRITE.test(line)),
    )
    .map((h) => h.name);
}

// The names that carry a capture, directly or through another name. A form with two failure branches
// writes one helper and calls it twice — `const held = (e, sent) => refusal.capture(…)` — and the
// helper lives at component scope, outside every handler body.
function capturingNames(src: string): Set<string> {
  const names = new Set<string>();
  for (;;) {
    const before = names.size;
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=([^;]*)/g)) {
      const name = m[1] as string;
      const rhs = m[2] as string;
      if (names.has(name)) continue;
      if (
        /\.capture\(/.test(rhs) ||
        [...names].some((r) => new RegExp(`\\b${r}\\s*\\(`).test(rhs))
      ) {
        names.add(name);
      }
    }
    if (names.size === before) return names;
  }
}

// A write handler that sends a value this form DECLARED and does not route its failure through a
// refusal holder.
//
// Declared is what bounds it, and the bound is the rule rather than a convenience: the fence's whole
// subject is "a refusal naming an input this form renders reaches that input", so a handler that
// sends nothing the form named cannot receive one. That is what separates a submit from the actions
// beside it — `revoke.post()` carries no body at all, `toggleEnabled` sends the one switch of a list
// row, `saveGuardrails` sends the settings bag whose paths this page deliberately does not declare
// (see PARTIALLY_HELD). Asking every write instead flagged twenty-five handlers, of which one was a
// form.
export function unheldWrites(src: string): string[] {
  if (!RENDERS_A_CONTROL.test(src)) return [];
  const declared = declaredFields(src);
  if (declared.length === 0) return [];
  const sends = new RegExp(
    `\\b(?:${declared.map((f) => f.split(".").pop()).join("|")})\\b`,
  );
  const carriers = capturingNames(src);
  return handlers(src)
    .filter((h) => {
      const writes = h.body
        .split("\n")
        .some((line) => WRITES.test(line) && !NOT_A_WRITE.test(line));
      if (!writes || !sends.test(h.body)) return false;
      if (/\.capture\(/.test(h.body)) return false;
      return ![...carriers].some((n) =>
        new RegExp(`\\b${n}\\s*\\(`).test(h.body),
      );
    })
    .map((h) => h.name);
}

// A holder that is declared and then half-used. Either half alone is silence: a holder nobody
// captures into can only ever answer null at every `at(…)` reading it, and a holder nobody reads
// keeps the toast quiet about a refusal it has placed nowhere.
export function halfUsedHolders(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/const (\w+) = useFieldRefusal\(/g)) {
    const name = m[1] as string;
    const captures = new RegExp(`\\b${name}\\.capture\\(`).test(src);
    const reads = new RegExp(`\\b${name}\\.at\\(`).test(src);
    if (!captures || !reads)
      out.push(`${name} (${captures ? "never read" : "never captured"})`);
  }
  return out;
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

// A holder inside a modal that is not cleared when the modal opens.
//
// The component around a modal STAYS MOUNTED when the dialog closes — that is what `useOnModalOpen`
// exists for, resetting the form on each open — so a holder written into state survives the session
// that produced it. Reopening and typing the refused value again shows the old server sentence under
// the box without anything having been sent. The hook's own note says a holder must not outlive its
// form; a modal wrapper is exactly where "the form" and "the component" stop being the same thing.
export function uncleanedHolders(src: string): string[] {
  if (!/useOnModalOpen\(|\.open\(/.test(src)) return [];
  const holders = [...src.matchAll(/const (\w+) = useFieldRefusal\(/g)].map(
    (m) => m[1] as string,
  );
  const code = codeSkeleton(src);
  // The `useOnModalOpen` callback, and — for a dialog opened from a click that seeds it inline, which
  // is how the agent editor's clone dialog is written — the block around each `.open()`.
  const resets = [
    ...[...code.matchAll(/useOnModalOpen\(/g)].map((m) => {
      let depth = 0;
      for (let i = m.index; i < code.length; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")" && --depth === 0) return src.slice(m.index, i);
      }
      return "";
    }),
    ...[...code.matchAll(/\.open\(/g)].map((m) => {
      let depth = 0;
      for (let i = m.index; i >= 0; i--) {
        if (code[i] === "}") depth++;
        else if (code[i] === "{" && depth-- === 0) return src.slice(i, m.index);
      }
      return "";
    }),
  ].join("\n");
  return holders.filter((h) => !new RegExp(`\\b${h}\\.clear\\(`).test(resets));
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

// A holder whose form is the PAGE, in a file that also opens a dialog for something else. The rule
// above cannot tell the two apart — it asks per file — and clearing a page's holder when an unrelated
// modal opens would be a line that means nothing. The page is unmounted when the operator leaves it,
// so its holder cannot outlive its form the way a modal's does.
const HELD_BY_THE_PAGE: Record<string, string> = {
  "pages/admin/AdminBrandingPage.tsx :: refusal":
    "The branding form is the page itself; the `.open()` in this file is the logo cropper, which writes no field.",
  "pages/agents/AgentEditorPage.tsx :: refusal":
    "The editor's own holder covers `name` and `systemPrompt` on the General TAB, not a dialog. The dialog in this file is the clone one, and it has its own holder (`cloneRefusal`) cleared on open.",
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

  test("the page-holder ledger is pinned to its size", () => {
    expectWaiverLedger("HELD_BY_THE_PAGE", HELD_BY_THE_PAGE, 2);
  });

  test("the partial ledger is pinned to its size", () => {
    expectWaiverLedger("PARTIALLY_HELD", PARTIALLY_HELD, 1);
  });

  test("the predicate sees a form that writes", () => {
    expect(
      writesAForm(`
        <FormField label="x"><Input value={v} /></FormField>

  async function save() {
    const { error } = await api.api.v1.tools.post(body);
  }
      `),
    ).toBe(true);
  });

  test("a POST that asks for a list is not a write", () => {
    // The model and voice catalogs are POSTed because the query is a body, not because anything of
    // the operator's is being stored. A form next to one of those has nothing to place.
    expect(
      writesAForm(`
        <Select value={v} />

  async function loadVoices() {
    const { data } = await api.api.v1.agents.models.list.post({ provider });
  }
      `),
    ).toBe(false);
  });

  test("a screen with no control is not a form", () => {
    expect(
      writesAForm(`
  async function save() {
    const { error } = await api.api.v1.agents.post(body);
  }
      `),
    ).toBe(false);
  });

  test("a handler ends at its own brace, not at the next declaration", () => {
    // A nested component's last handler used to swallow everything after it, which read a callback
    // that awaits nothing as a write of the function three declarations below.
    const src = `
  async function select(next: string | null) {
    await onChange(next);
  }

  function Other() {
    return null;
  }

  async function save() {
    await api.api.v1.tools.post(body);
  }
    `;
    expect(writeHandlers(src)).toEqual(["save"]);
  });

  test("an unheld handler is named, even next to a held one", () => {
    // The shape the file-level rule could not see: two forms in one file, one wired.
    const src = `
      const A = ["x", "y"] as const;
      const a = useFieldRefusal(A);
      <FormField error={a.at("x", v)} />

  async function saveA() {
    const { error } = await api.thing.post({ x });
    if (error) setErr(a.capture(error, f, sent, current));
  }

  async function saveB() {
    const { error } = await api.other.post({ y });
    if (error) setErr("nope");
  }

  async function revoke() {
    const { error } = await api.thing({ id }).revoke.post();
    if (error) setErr("nope");
  }
    `;
    expect(unheldWrites(src)).toEqual(["saveB"]);
  });

  test("a holder that is read and never captured is flagged", () => {
    const src = `
      const addDocRefusal = useFieldRefusal(DOC_FIELDS);
      <FormField error={addDocRefusal.at("title", v)} />
    `;
    expect(halfUsedHolders(src)).toEqual(["addDocRefusal (never captured)"]);
  });

  test("a holder that is captured and never read is flagged too", () => {
    const src = `
      const r = useFieldRefusal(F);
      setError(r.capture(e, f, sent, current));
    `;
    expect(halfUsedHolders(src)).toEqual(["r (never read)"]);
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

  test("every handler that writes a form holds its refusal", () => {
    const unheld = sources(ROOT).flatMap((f) => {
      const file = f.slice(`${ROOT}/`.length);
      if (file in NOT_A_REFUSABLE_FORM) return [];
      return unheldWrites(readFileSync(f, "utf8")).map(
        (h) => `${file} :: ${h}`,
      );
    });
    expect(
      unheld,
      "these write a form and send every refusal to a banner: route the failure through refusal.capture, or name the reason not to",
    ).toEqual([]);
  });

  test("no holder is declared and half-used", () => {
    const half = sources(ROOT).flatMap((f) =>
      halfUsedHolders(readFileSync(f, "utf8")).map(
        (h) => `${f.slice(`${ROOT}/`.length)} :: ${h}`,
      ),
    );
    expect(
      half,
      "a holder that is only read places nothing, and one that is only captured shows nothing",
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

  test("a holder inside a modal is cleared when the modal opens", () => {
    const uncleaned = sources(ROOT)
      .flatMap((f) =>
        uncleanedHolders(readFileSync(f, "utf8")).map(
          (h) => `${f.slice(`${ROOT}/`.length)} :: ${h}`,
        ),
      )
      .filter((h) => !(h in HELD_BY_THE_PAGE));
    expect(
      uncleaned,
      "the component outlives the dialog, so a mark from the last session is still held when it reopens: clear the holder in useOnModalOpen",
    ).toEqual([]);
  });

  test("the predicate flags a modal holder that is never cleared", () => {
    const src = `
      const refusal = useFieldRefusal(F);
      useOnModalOpen(modal, () => {
        setName("");
      });
    `;
    expect(uncleanedHolders(src)).toEqual(["refusal"]);
  });

  test("a dialog seeded from a click is asked the same question", () => {
    // The agent editor's clone dialog has no `useOnModalOpen`: it seeds its input and opens in one
    // onClick, and the holder survives the close exactly the same way.
    const src = `
      const cloneRefusal = useFieldRefusal(F);
      onClick={() => {
        setCloneName(suggested);
        cloneModal.open();
      }}
    `;
    expect(uncleanedHolders(src)).toEqual(["cloneRefusal"]);
  });

  test("a modal holder cleared on open is not flagged", () => {
    const src = `
      const refusal = useFieldRefusal(F);
      useOnModalOpen(modal, () => {
        setName("");
        refusal.clear();
      });
    `;
    expect(uncleanedHolders(src)).toEqual([]);
  });

  test("the abstention ledger is pinned to its size", () => {
    expectWaiverLedger("NOT_A_REFUSABLE_FORM", NOT_A_REFUSABLE_FORM, 2);
  });
});
