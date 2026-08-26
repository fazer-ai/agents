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

export function handlers(src: string): {
  name: string;
  body: string;
  // The same span with comments and string CONTENTS blanked out, offsets preserved. Every question
  // this file asks of a handler is about what it runs, and prose is where those words appear
  // innocently: `useKnowledgeManager`'s reindex button sends no body at all, and read raw it looked
  // like a form write because a comment inside it says "Same text as the banner".
  code: string;
}[] {
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
      code: code.slice(m.index, end),
    };
  });
}

// The handlers that write a form's values back. `POST` is also how this API asks two questions whose
// answer is a list (the model catalog, the voice catalog) and how it runs a connection test — none of
// those carry a form's values, so none of them can refuse one.
export function writeHandlers(src: string): string[] {
  return handlers(src)
    .filter((h) => writes(h.code))
    .map((h) => h.name);
}

function writes(code: string): boolean {
  return code
    .split("\n")
    .some((line) => WRITES.test(line) && !NOT_A_WRITE.test(line));
}

// The names that carry a capture, directly or through another name. A form with two failure branches
// writes one helper and calls it twice — `const held = (e, sent) => refusal.capture(…)` — and the
// helper lives at component scope, outside every handler body.
function capturingNames(code: string): Set<string> {
  const names = new Set<string>();
  for (;;) {
    const before = names.size;
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=([^;]*)/g)) {
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
  const carriers = capturingNames(codeSkeleton(src));
  return handlers(src)
    .filter((h) => {
      if (!writes(h.code) || !sends.test(h.code)) return false;
      if (/\.capture\(/.test(h.code)) return false;
      return ![...carriers].some((n) =>
        new RegExp(`\\b${n}\\s*\\(`).test(h.code),
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

// EVERY holder in the file with the names it declares, not the first one that happens to appear.
//
// A file with one form is the easy case and it is not the common one here: `ChannelsPage` keeps
// three holders, `useKnowledgeManager` three, `AdvancedPanel` two, and the agent editor two. Reading
// only the first meant the fence agreed with itself about one form per file and asked nothing at all
// of the rest — a declared name with no control behind it, in any of them, passed. Attributed per
// holder for the same reason `unheldWrites` names its handler: "this file declares a name it never
// renders" is not a finding anyone can act on.
//
// Read from the source rather than imported because the point is to compare the declaration against
// the RENDER, and only the source has both.
export function declarations(
  src: string,
): { holder: string; fields: string[] }[] {
  return [...src.matchAll(/const (\w+) = useFieldRefusal\(/g)].map((m) => ({
    holder: m[1] as string,
    fields: declaredArg(
      src.slice((m.index as number) + (m[0] as string).length),
      src,
    ),
  }));
}

// The first argument's names, however it is spelled. Both spellings are in the tree: the `as const`
// list beside the component, and — where the list depends on what the form is drawing — an array
// built inline (`CredentialForm`, whose multi-field types contribute one name per input). The inline
// one was skipped entirely by the identifier-only version.
//
// A computed element contributes nothing, which is the honest answer rather than a hole: a spread of
// `fields.map(f => f.key)` is read back by an `at(f.key, …)` the source cannot see either, so both
// sides of the comparison drop it together.
function declaredArg(rest: string, src: string): string[] {
  const lead = rest.match(/^\s*/)?.[0].length ?? 0;
  const arg = rest.slice(lead);
  if (arg.startsWith("[")) {
    let depth = 0;
    for (let i = 0; i < arg.length; i++) {
      if (arg[i] === "[") depth++;
      else if (arg[i] === "]" && --depth === 0)
        return literals(arg.slice(1, i));
    }
    return [];
  }
  const ident = arg.match(/^([A-Za-z_$][\w$]*)/)?.[1];
  if (!ident) return [];
  const list = new RegExp(`${ident}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
  return list ? literals(list[1] as string) : [];
}

function literals(list: string): string[] {
  return [...list.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string);
}

// Every name declared anywhere in the file, which is what "did this handler send something the form
// named" asks: any holder's control can receive it.
export function declaredFields(src: string): string[] {
  return [...new Set(declarations(src).flatMap((d) => d.fields))];
}

// The names read back onto a control — by ONE holder when asked for one, since a name `refusal`
// declares is not rendered by `cloneRefusal.at(…)` two forms away.
export function readFields(src: string, holder?: string): Set<string> {
  const re = holder
    ? new RegExp(`\\b${holder}\\.at\\(\\s*["']([^"']+)["']`, "g")
    : /\.at\(\s*["']([^"']+)["']/g;
  return new Set([...src.matchAll(re)].map((m) => m[1] as string));
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

// A holder in a file that can HIDE its form and never says when.
//
// The other half of the same confusion: `useModalController` keeps the wrapper mounted when the
// dialog closes, so the hook's mounted check answers `true` for a form the operator has already
// dismissed. `capture` then reports "it is on the control", the caller keeps the banner quiet, and a
// refusal the server named reaches nobody. Silence is the one outcome this mechanism must never
// produce, so what makes the form visible is the second argument.
//
// A dialog is not the only way to hide a form, and asking only about dialogs is how the agent
// editor got through the round that added this rule: its `name` and `systemPrompt` live in
// `GeneralTab`, mounted only while `tab === "general"`, and its holder had been waived as a page's
// because the file's dialog belongs to something else. A tab test in the file asks the same
// question of every holder in it.
export function holdersBlindToTheScreen(src: string): string[] {
  if (!/useOnModalOpen\(|\.open\(|\btab === "/.test(src)) return [];
  return [...src.matchAll(/const (\w+) = useFieldRefusal\(([^;]*?)\);/g)]
    .filter((m) => topLevelArgCount(m[2] as string) < 2)
    .map((m) => m[1] as string);
}

// How many arguments a call carries, counting only the commas that belong to IT.
function topLevelArgCount(args: string): number {
  if (!args.trim()) return 0;
  let depth = 0;
  let n = 1;
  for (const c of args) {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) n++;
  }
  return n;
}

// A reading that CANNOT run, because the `??` in front of it never falls through.
//
// `at(…)` answers `string | null`, so it reads naturally as the fallback of a local validation
// error — and it is dead there whenever that local error is a state initialized to `""`, since an
// empty string is not nullish. Nothing about this is visible: the name is declared, the reading is
// written, the fence's other rule sees an `at(…)` and is satisfied, and the refusal is placed onto a
// holder whose one reader can never return it. `capture` has already told the caller "it is on the
// control", so the toast stays quiet too. Measured on `useKnowledgeManager`: the chunk-size box
// checks BOUNDS locally and the schema is `t.Integer`, so a size of 100.5 is refused by name and
// answered with nothing at all.
//
// The left operand is the whole test. `refusal.at(a) ?? refusal.at(b)` — one control drawn for two
// names, which ToolEditModal does — falls through exactly as intended.
export function deadReadings(src: string): string[] {
  const neverNullish = new Set(
    [...src.matchAll(/const \[(\w+),[^\]]*\]\s*=\s*useState\(\s*["'`]/g)].map(
      (m) => m[1] as string,
    ),
  );
  if (neverNullish.size === 0) return [];
  return [
    ...codeSkeleton(src).matchAll(
      /\b([A-Za-z_$][\w$]*)\s*\?\?\s*([A-Za-z_$][\w$]*)\.at\(/g,
    ),
  ]
    .filter((m) => neverNullish.has(m[1] as string))
    .map((m) => `${m[2]}.at behind ${m[1]}`);
}

export function silentDeclarations(src: string): string[] {
  return declarations(src).flatMap(({ holder, fields }) => {
    const read = readFields(src, holder);
    return fields.filter((n) => !read.has(n)).map((n) => `${holder}.${n}`);
  });
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
    "The editor's own holder covers `name` and `systemPrompt`, which no dialog in this file draws — the clone dialog has its own holder (`cloneRefusal`), cleared on open. It IS hidden, by its tab, and answers for that itself: see ALWAYS_ON_SCREEN, which this entry is deliberately not in.",
};

// A holder whose form cannot be hidden, in a file that can hide something else. Separate from the
// ledger above because the two rules ask different questions, and one entry answers only one of
// them: the agent editor's holder is a page's for the clearing rule and a hidden form's for this
// one. Waiving it in both was how the tab case survived the round that found the modal case.
const ALWAYS_ON_SCREEN: Record<string, string> = {
  "pages/admin/AdminBrandingPage.tsx :: refusal":
    "The branding form is drawn unconditionally by the page. The only thing this file hides is the logo cropper, which writes no field.",
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

  test("a declared name inside a COMMENT is not a form write", () => {
    // Measured on `useKnowledgeManager`: the reindex button sends no body at all, and the only
    // mention of a declared name inside it is a comment that says "Same text as the banner".
    const src = `
      const F = ["title", "text"] as const;
      const r = useFieldRefusal(F, m.isOpen);
      <FormField error={r.at("title", v)} /><FormField error={r.at("text", w)} />

  async function reindex(id: string) {
    // Same text as the banner, from the same function.
    const { error } = await api.bases({ id }).reindex.post();
  }
    `;
    expect(unheldWrites(src)).toEqual([]);
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

  test("no reading sits behind a fallback that never falls through", () => {
    const dead = sources(ROOT).flatMap((f) =>
      deadReadings(readFileSync(f, "utf8")).map(
        (d) => `${f.slice(`${ROOT}/`.length)} :: ${d}`,
      ),
    );
    expect(
      dead,
      'a local error state initialized to "" is never nullish, so the refusal behind `??` is unreachable and the toast is already quiet: use `||`',
    ).toEqual([]);
  });

  test("the predicate flags a refusal behind an empty-string local error", () => {
    const src = `
      const [chunkSizeError, setChunkSizeError] = useState("");
      <FormField error={chunkSizeError ?? r.at("chunkSize", v)} />
    `;
    expect(deadReadings(src)).toEqual(["r.at behind chunkSizeError"]);
  });

  test("the same reading behind a truthy fallback is fine", () => {
    const src = `
      const [chunkSizeError, setChunkSizeError] = useState("");
      <FormField error={chunkSizeError || r.at("chunkSize", v)} />
    `;
    expect(deadReadings(src)).toEqual([]);
  });

  test("a local error that CAN be null keeps its fallback", () => {
    // The filter's own control: the rule is about a state that is never nullish, not about `??`.
    // A nullable local error is the shape this pattern is written for.
    const src = `
      const [touched, setTouched] = useState("");
      const localError = invalid ? "Must be a number." : null;
      <FormField error={localError ?? r.at("chunkSize", v)} />
    `;
    expect(deadReadings(src)).toEqual([]);
  });

  test("one control drawn for two names still falls through", () => {
    // `at(…)` answers null when it is not the refused name, which is exactly what `??` is for.
    const src = `
      const [x, setX] = useState("");
      <FormField error={r.at("label", a) ?? r.at("name", b)} />
    `;
    expect(deadReadings(src)).toEqual([]);
  });

  test("a declared name with no control behind it is flagged", () => {
    const src = `
      const FIELDS = ["name", "allowedHosts"] as const;
      const refusal = useFieldRefusal(FIELDS);
      <FormField error={refusal.at("name", current.name)} />
    `;
    expect(silentDeclarations(src)).toEqual(["refusal.allowedHosts"]);
  });

  test("the second holder of a file is asked the same question", () => {
    // The shape the first-call-only version could not see: two forms, and the one that is wrong is
    // not the one declared first.
    const src = `
      const A = ["name"] as const;
      const B = ["name", "slug"] as const;
      const a = useFieldRefusal(A, x.isOpen);
      const b = useFieldRefusal(B, y.isOpen);
      <FormField error={a.at("name", u)} />
      <FormField error={b.at("name", v)} />
    `;
    expect(silentDeclarations(src)).toEqual(["b.slug"]);
  });

  test("a name read by ANOTHER holder does not answer for this one", () => {
    // Two forms with a `name` each is the normal case here — a modal over the panel that opened it —
    // and a file-wide reading let one form's control vouch for the other's declaration.
    const src = `
      const A = ["name"] as const;
      const B = ["name"] as const;
      const a = useFieldRefusal(A, x.isOpen);
      const b = useFieldRefusal(B, y.isOpen);
      <FormField error={a.at("name", u)} />
    `;
    expect(silentDeclarations(src)).toEqual(["b.name"]);
  });

  test("an inline field list is read, not skipped", () => {
    // `CredentialForm` builds its list from the secret type it is drawing. The identifier-only
    // version returned nothing for it, so the whole form was outside the fence.
    const src = `
      const refusal = useFieldRefusal([
        "name",
        "value",
        ...(fields ?? []).map((f) => f.key),
      ]);
      <FormField error={refusal.at("name", u)} />
    `;
    expect(silentDeclarations(src)).toEqual(["refusal.value"]);
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

  test("a holder in a file that hides a form says when its own is showing", () => {
    const blind = sources(ROOT)
      .flatMap((f) =>
        holdersBlindToTheScreen(readFileSync(f, "utf8")).map(
          (h) => `${f.slice(`${ROOT}/`.length)} :: ${h}`,
        ),
      )
      .filter((h) => !(h in ALWAYS_ON_SCREEN));
    expect(
      blind,
      "the component outlives the form when a dialog closes or a tab changes, so a save answering after that places a mark nobody renders: pass what makes the form visible",
    ).toEqual([]);
  });

  test("the always-on-screen ledger is pinned to its size", () => {
    expectWaiverLedger("ALWAYS_ON_SCREEN", ALWAYS_ON_SCREEN, 1);
  });

  test("the predicate flags a holder that takes only its field list", () => {
    const src = `
      const refusal = useFieldRefusal(FIELDS);
      useOnModalOpen(modal, () => {});
    `;
    expect(holdersBlindToTheScreen(src)).toEqual(["refusal"]);
  });

  test("a form behind a tab is asked the same question as one behind a dialog", () => {
    // No dialog in sight, and the form is hidden just as completely: `GeneralTab` is not mounted
    // while the operator reads another tab, and a save started before the switch answers after it.
    const src = `
      const refusal = useFieldRefusal(EDITOR_FIELDS);
      {tab === "general" && <GeneralTab />}
    `;
    expect(holdersBlindToTheScreen(src)).toEqual(["refusal"]);
  });

  test("a holder given the dialog's own state is not flagged", () => {
    // The argument can be an expression: one form reached from two dialogs answers for both.
    const src = `
      const refusal = useFieldRefusal(FIELDS, a.isOpen || b.isOpen);
      useOnModalOpen(modal, () => {});
    `;
    expect(holdersBlindToTheScreen(src)).toEqual([]);
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
