import { describe, expect, test } from "bun:test";
import {
  templateLeaves,
  templateLists,
  templateOfferAt,
  templateWriteAt,
} from "@/modules/tool-definitions/response-template";

// WHAT A TOKEN AT THIS CARET MAY NAME (issue #563).
//
// The console already answered this for its picker, against the caret the picker was opened at.
// Completion asks the same question against the caret the operator is typing in, and the two must
// not answer differently: an offer that lists a field the picker would not, or the reverse, is two
// opinions about one grammar. So the rule moved here, next to the reader that has to accept what is
// picked.

const BODY = {
  cliente: { nome: "Ana", cidade: "SP" },
  resultados: [
    { nome: "A", preco: 10 },
    { nome: "B", preco: 20, nota: "x" },
  ],
  tags: ["azul", "novo"],
};

// The shape the console holds: the body plus the top-level offer it computed when the sample was
// pasted. The completion is handed this, not a body to walk again per keystroke.
const SAMPLE = {
  body: BODY,
  leaves: templateLeaves(BODY),
  lists: templateLists(BODY),
};

function paths(o: { leaves: { path: string }[] }): string[] {
  return o.leaves.map((l) => l.path);
}

describe("templateOfferAt", () => {
  test("outside every block, the absolute fields and the lists", () => {
    const o = templateOfferAt("Nome: ", 6, SAMPLE);
    expect(o.block).toBeNull();
    expect(paths(o)).toContain("cliente.nome");
    expect(o.lists.map((l) => l.path)).toEqual(
      expect.arrayContaining(["resultados", "tags"]),
    );
  });

  // INSIDE A BLOCK THE PATHS ARE THE ITEM'S, which is the whole reason this is caret-dependent: the
  // same document offers different names three lines apart.
  test("inside a block, the item's own fields, relative", () => {
    const doc = "{{#each resultados}}\n- \n{{/each}}";
    const o = templateOfferAt(doc, doc.indexOf("- ") + 2, SAMPLE);
    expect(o.block).toBe("resultados");
    // The union of the first items, so a field only the second row carries is still offered.
    expect(paths(o).sort()).toEqual(["nome", "nota", "preco"]);
    // A list inside a list is not offered: blocks do not nest.
    expect(o.lists).toEqual([]);
  });

  test("a list of scalars offers the item itself", () => {
    const doc = "{{#each tags}}\n- \n{{/each}}";
    expect(paths(templateOfferAt(doc, doc.indexOf("- ") + 2, SAMPLE))).toEqual([
      ".",
    ]);
  });

  // THE BLOCK IS READ LENIENTLY, because the moment the operator most wants the item fields is just
  // after typing `{{#each xs}}`, when nothing has closed it yet.
  test("answers inside a block that is not closed yet", () => {
    const doc = "{{#each resultados}}\n- ";
    expect(templateOfferAt(doc, doc.length, SAMPLE).block).toBe("resultados");
  });

  test("offers nothing for a block over a path the sample does not carry", () => {
    const doc = "{{#each nao_existe}}\n- \n{{/each}}";
    const o = templateOfferAt(doc, doc.indexOf("- ") + 2, SAMPLE);
    expect(o.block).toBe("nao_existe");
    expect(o.leaves).toEqual([]);
  });
});

// WHAT TYPING `{{` IS ASKING FOR, and what accepting an answer should leave behind.
describe("templateWriteAt", () => {
  test("says nothing when the caret is not inside a token", () => {
    expect(templateWriteAt("Nome: ", 6)).toBeNull();
    expect(templateWriteAt("{{a}} depois", 12)).toBeNull();
  });

  test("opens on a token the operator has started", () => {
    expect(templateWriteAt("Nome: {{", 8)).toEqual({
      kind: "path",
      from: 8,
      to: 8,
      pathEnd: 8,
      closeAt: null,
    });
    expect(templateWriteAt("Nome: {{cli", 11)).toEqual({
      kind: "path",
      from: 8,
      to: 11,
      pathEnd: 11,
      closeAt: null,
    });
  });

  // THE BRACES THE OPERATOR ALREADY TYPED ARE NOT RETYPED, and the ones they did not are added, or
  // picking from the list leaves `{{path` on screen and a stray brace in the model's input.
  //
  // WHERE they are is the answer and not merely THAT they are: measured in the browser,
  // `closeBrackets` turns a typed `{{` into `{{}}`, so this is the ordinary case, and the caller
  // needs the position to put the caret past the close instead of inside the token.
  test("says where the close already is", () => {
    expect(templateWriteAt("Nome: {{}}", 8)).toEqual({
      kind: "path",
      from: 8,
      to: 8,
      pathEnd: 8,
      closeAt: 10,
    });
    expect(templateWriteAt("Nome: {{cli}}", 11)).toEqual({
      kind: "path",
      from: 8,
      to: 11,
      pathEnd: 11,
      closeAt: 13,
    });
  });

  // A BLOCK ASKS FOR A LIST, not for a field: `{{#each cliente.nome}}` renders the absent marker
  // over a name that is right there, and the save refuses it.
  test("asks for a list after the block marker", () => {
    expect(templateWriteAt("{{#each ", 8)).toEqual({
      kind: "list",
      from: 8,
      to: 8,
      pathEnd: 8,
      closeAt: null,
    });
    expect(templateWriteAt("{{#each res}}", 11)).toEqual({
      kind: "list",
      from: 8,
      to: 11,
      pathEnd: 11,
      closeAt: 13,
    });
  });

  // THE SEPARATOR IS PART OF THE GRAMMAR, and offering without it writes something the grammar
  // refuses (round 1 of review). `BLOCK` spells the marker as `#each` followed by `[ \t]+` and then
  // the path, so a caret sitting straight after `each` is not in list position: completing there
  // produced `{{#eachresultados}}`, which no block pattern matches and the Save gate turns down.
  // It is also the ordinary shape, not a corner: `closeBrackets` answers a typed `{{` with `{{}}`,
  // so typing `#each` inside it leaves the caret exactly there.
  test("does not ask for a list until the marker's separator is typed", () => {
    expect(templateWriteAt("{{#each}}", 7)).toBeNull();
    expect(templateWriteAt("{{#each", 7)).toBeNull();
    expect(templateWriteAt("{{#each }}", 8)).toMatchObject({ kind: "list" });
  });

  // AND A HALF-TYPED MARKER IS NOT A PATH PREFIX. Requiring the separator alone only moved the
  // defect one step: `{{#each}}` stopped asking for a list and started asking for a PATH over the
  // text `#each`, so accepting wrote a field name over the marker being typed.
  test("offers nothing over a marker that is still being typed", () => {
    expect(templateWriteAt("{{#", 3)).toBeNull();
    expect(templateWriteAt("{{#ea", 5)).toBeNull();
  });

  // THE WHITESPACE THE GRAMMAR ALLOWS IS NOT PART OF WHAT IS BEING TYPED (round 2 of review).
  // `BLOCK` spells `\{\{\s*` and the token render trims, so `{{ campo }}` and `{{ #each xs }}` are
  // both legal. Anchoring at `{{` put that space into the prefix CodeMirror filters on, so every
  // path was filtered OUT for `{{ campo`, and `{{ #each ` was read as a scalar path — the offer
  // disappearing exactly where the grammar says it should be there.
  test("skips the whitespace the grammar allows after the opening", () => {
    expect(templateWriteAt("{{ field", 8)).toMatchObject({
      kind: "path",
      from: 3,
    });
    expect(templateWriteAt("{{ #each ", 9)).toMatchObject({ kind: "list" });
    expect(templateWriteAt("{{\t#each\tres", 12)).toMatchObject({
      kind: "list",
    });
  });

  // AND THE PATH ALREADY THERE IS WHAT THE ANSWER REPLACES, not the empty string before the caret
  // (round 2 of review). Completing at the start of `{{foo}}` and picking `bar` wrote `{{barfoo}}`;
  // where the concatenation happens to stay a legal path it is worse, because it silently aims at a
  // field nobody chose.
  //
  // AND IT IS NOT THE RANGE THE LIST FILTERS ON (round 3 of review): CodeMirror's pattern is
  // `sliceDoc(from, to)`, measured in the installed package, so `to` has to stay at the caret or
  // every candidate is matched against the path being replaced and the ones meant to replace it
  // disappear. Two ranges, two questions.
  test("replaces through the end of the path while filtering on what was typed", () => {
    expect(templateWriteAt("{{foo}}", 2)).toEqual({
      kind: "path",
      from: 2,
      to: 2,
      pathEnd: 5,
      closeAt: 7,
    });
    // The trailing space the operator wrote survives; only the path is replaced.
    expect(templateWriteAt("{{ foo }}", 3)).toEqual({
      kind: "path",
      from: 3,
      to: 3,
      pathEnd: 6,
      closeAt: 9,
    });
    expect(templateWriteAt("{{#each foo}}", 8)).toEqual({
      kind: "list",
      from: 8,
      to: 8,
      pathEnd: 11,
      closeAt: 13,
    });
  });

  test("does not open inside a close marker", () => {
    expect(templateWriteAt("{{/each}}", 7)).toBeNull();
  });

  // A NEWLINE ENDS THE ATTEMPT. An unclosed `{{` three lines up is a typo, not an invitation to
  // offer completions on every line under it.
  test("does not reach across a line break", () => {
    expect(templateWriteAt("{{\nNome: ", 9)).toBeNull();
  });
});
