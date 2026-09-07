import { describe, expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { TFunction } from "i18next";
import { templateSource } from "@/client/lib/templateEditor";
import {
  templateLeaves,
  templateLists,
} from "@/modules/tool-definitions/response-template";

// TYPING `{{` OFFERS THE SAMPLE'S PATHS, at the caret (issue #563).
//
// #462 named this and left it out of scope, because measuring a caret's coordinates inside a
// textarea is the problem CodeMirror does not have. The picker it shipped instead is a popover the
// operator opens; this is the list arriving where they are typing.
//
// The RULE is `templateWriteAt` + `templateOfferAt`, both tested in `tests/modules`. What is driven
// here is the seam: the range the answer replaces, which of the two vocabularies is offered, and
// what accepting one leaves in the document.

const BODY = {
  cliente: { nome: "Ana" },
  resultados: [{ nome: "A", preco: 10 }],
  tags: ["azul"],
};
const SAMPLE = {
  body: BODY,
  leaves: templateLeaves(BODY),
  lists: templateLists(BODY),
};

// The console's own `t`, reduced to what these options ask of it.
const t = ((_key: string, fallback: string, vars?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, n) =>
    String(vars?.[n] ?? ""),
  )) as unknown as TFunction;

function ask(doc: string, pos: number = doc.length) {
  const state = EditorState.create({ doc });
  return templateSource(SAMPLE, t)(new CompletionContext(state, pos, true));
}

describe("the offer at the caret", () => {
  test("says nothing in prose", () => {
    expect(ask("Nome do cliente: ")).toBeNull();
  });

  test("offers the sample's fields once a token is open", () => {
    const r = ask("Nome: {{");
    expect(r?.from).toBe(8);
    expect(r?.options.map((o) => o.label)).toContain("cliente.nome");
  });

  // THE VALUE IS THE POINT OF THE DETAIL. Two paths named `id` in different branches are told apart
  // by what the API actually answered there, which is on screen right above.
  test("shows what the sample answered at that path", () => {
    const r = ask("{{");
    const nome = r?.options.find((o) => o.label === "cliente.nome");
    expect(nome?.detail).toBe("Ana");
  });

  test("replaces what has been typed so far, not the braces", () => {
    const r = ask("Nome: {{cli");
    expect(r?.from).toBe(8);
    expect(r?.to).toBe(11);
  });

  // THE TWO VOCABULARIES ARE NOT INTERCHANGEABLE: a block repeats over a list, and a field there
  // renders the absent marker over a value that exists.
  test("offers lists, and only lists, after the block marker", () => {
    const r = ask("{{#each ");
    expect(r?.options.map((o) => o.label).sort()).toEqual([
      "resultados",
      "tags",
    ]);
    expect(r?.options.every((o) => /item/.test(o.detail ?? ""))).toBe(true);
  });

  test("offers the item's own fields inside a block", () => {
    const doc = "{{#each resultados}}\n- \n{{/each}}";
    const r = ask(doc, doc.indexOf("- ") + 2 + "{{".length - 2);
    // The caret is on the item line, before any `{{`: nothing is open, so nothing is offered.
    expect(r).toBeNull();
    const open = "{{#each resultados}}\n- {{";
    const inside = templateSource(
      SAMPLE,
      t,
    )(
      new CompletionContext(
        EditorState.create({ doc: open }),
        open.length,
        true,
      ),
    );
    expect(inside?.options.map((o) => o.label).sort()).toEqual([
      "nome",
      "preco",
    ]);
  });

  test("says nothing when the sample carries nothing to offer", () => {
    const empty = { body: undefined, leaves: [], lists: [] };
    const state = EditorState.create({ doc: "{{" });
    expect(
      templateSource(empty, t)(new CompletionContext(state, 2, true)),
    ).toBeNull();
  });
});

// WHAT ACCEPTING ONE LEAVES BEHIND, which is where a half-written token would escape to the model.
// WHEN THE SOURCE HAS TO BE ASKED AGAIN (round 4 of review).
//
// `validFor` is what lets CodeMirror keep one result while the operator keeps typing, and a pattern
// that only excluded braces kept it across a change of VOCABULARY: pausing after `{{` until the
// scalar list opens and then typing `#each ` left the path options in place, filtered against
// `#each `, so the popup emptied and the lists never arrived. The two characters that change the
// answer are the `#` that starts a marker and the whitespace that moves where the path begins;
// neither can appear in a path, so excluding them costs nothing while typing one.
describe("the offer's own validity", () => {
  const keepsResult = (typed: string): boolean => {
    const r = ask("{{");
    const v = r?.validFor;
    if (!(v instanceof RegExp)) throw new Error("no validFor on the result");
    return v.test(typed);
  };

  test("keeps the list alive while a path is being typed", () => {
    expect(keepsResult("cli")).toBe(true);
    expect(keepsResult("cliente.nome")).toBe(true);
    expect(keepsResult("resultados.0.preco")).toBe(true);
  });

  test("asks again when the token turns into a block, or the path moves", () => {
    expect(keepsResult("#")).toBe(false);
    expect(keepsResult("#each ")).toBe(false);
    expect(keepsResult(" ")).toBe(false);
  });
});

describe("accepting an answer", () => {
  // `apply` DISPATCHES; it does not return an edit. So the view is a spy and what it was handed is
  // the assertion, which is also the only way to see the selection it asks for.
  function accept(
    doc: string,
    label: string,
    pos: number = doc.length,
  ): { text: string; caret: number } {
    const r = ask(doc, pos);
    const option = r?.options.find((o) => o.label === label);
    if (!r || !option) throw new Error(`no option ${label} for ${doc}@${pos}`);
    // Collected rather than assigned: TypeScript cannot see an assignment made inside the callback,
    // so a `let` narrows to `never` at the first guard after it.
    const seen: {
      changes: { from: number; to: number; insert: string };
      selection: { anchor: number };
    }[] = [];
    // The view carries a STATE now: the apply re-reads the document at acceptance rather than
    // trusting what the offer was built from.
    const view = {
      state: EditorState.create({ doc }),
      dispatch: (s: unknown) => {
        seen.push(s as (typeof seen)[number]);
      },
    } as never;
    (option.apply as (v: never, c: unknown, f: number, t: number) => void)(
      view,
      option,
      r.from,
      r.to ?? r.from,
    );
    const spec = seen[0];
    if (!spec) throw new Error("apply dispatched nothing");
    const { changes, selection } = spec;
    return {
      text: doc.slice(0, changes.from) + changes.insert + doc.slice(changes.to),
      caret: selection.anchor,
    };
  }

  test("closes a token the operator opened", () => {
    const { text, caret } = accept("Nome: {{", "cliente.nome");
    expect(text).toBe("Nome: {{cliente.nome}}");
    // PAST the closing braces: the next thing typed is the next word of the sentence.
    expect(caret).toBe(text.length);
  });

  // THE ORDINARY CASE, and the one this test had backwards until the browser said so. Typing `{{`
  // makes `closeBrackets` write `{{}}`, so the braces are already there and the caret sits between
  // them. Asserting the caret at the end of the inserted path passed here and left the cursor
  // INSIDE the token on screen: the next thing typed went in with it, and typing a value and then a
  // block produced `{{cliente.nome{{#each resultados}}}}` on one line.
  test("does not add braces the document already has, and steps over them", () => {
    const { text, caret } = accept("Nome: {{}} hoje", "cliente.nome", 8);
    expect(text).toBe("Nome: {{cliente.nome}} hoje");
    expect(caret).toBe("Nome: {{cliente.nome}}".length);
  });

  // THE DOCUMENT MOVES WHILE THE POPUP IS OPEN (round 1 of review). `validFor` keeps ONE result
  // alive while the operator types the path, so the offer is computed against `{{}}` and applied
  // against `{{cli}}`. An `apply` closing over the close-brace position captured at opening is then
  // answering about a document three characters shorter: the caret landed inside the token, and on
  // a deletion the anchor could exceed the document and make the dispatch throw.
  //
  // Driven the way CodeMirror does it: ask ONCE at the opening caret, then apply with the range of
  // a later document. Asking again at the new caret is what the helper above does, and it is
  // exactly the step that hides this.
  test("steps over the close as it stands NOW, not as it stood when the list opened", () => {
    const opened = ask("Nome: {{}} hoje", 8);
    const option = opened?.options.find((o) => o.label === "cliente.nome");
    if (!opened || !option) throw new Error("no option");

    const later = "Nome: {{cli}} hoje";
    const seen: {
      changes: { from: number; to: number; insert: string };
      selection: { anchor: number };
    }[] = [];
    const view = {
      state: EditorState.create({ doc: later }),
      dispatch: (s: unknown) => {
        seen.push(s as (typeof seen)[number]);
      },
    } as never;
    (option.apply as (v: never, c: unknown, f: number, t: number) => void)(
      view,
      option,
      8,
      11,
    );
    const spec = seen[0];
    if (!spec) throw new Error("apply dispatched nothing");
    const text =
      later.slice(0, spec.changes.from) +
      spec.changes.insert +
      later.slice(spec.changes.to);
    expect(text).toBe("Nome: {{cliente.nome}} hoje");
    expect(spec.selection.anchor).toBe("Nome: {{cliente.nome}}".length);
  });

  // THE OLD PATH GOES, and the range that removes it is not the range the list filtered on (rounds
  // 2 and 3 of review). Completing at the start of `{{foo}}` and picking a field wrote
  // `{{cliente.nomefoo}}`; stretching the RESULT's range to fix it filtered every candidate against
  // `foo` instead, so the fix lives in the apply, which reads the document at acceptance.
  test("replaces the path already in the token, not just what was typed", () => {
    const { text, caret } = accept("{{foo}} hoje", "cliente.nome", 2);
    expect(text).toBe("{{cliente.nome}} hoje");
    expect(caret).toBe("{{cliente.nome}}".length);
  });

  test("closes a block marker the same way", () => {
    expect(accept("{{#each ", "resultados").text).toBe("{{#each resultados}}");
  });
});
