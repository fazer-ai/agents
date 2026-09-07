import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { TFunction } from "i18next";
import {
  scanTemplate,
  type TemplateSampleOffer,
  templateOfferAt,
  templateWriteAt,
} from "@/modules/tool-definitions/response-template";

// THE RESPONSE TEMPLATE, EDITED AS THE LANGUAGE IT IS (issue #563).
//
// What goes in that field is markdown plus three spellings of our own, and in a `<textarea>` all of
// it is one colour: a `{{path}}` aimed at a key the response does not carry looks exactly like the
// prose around it. Two extensions over the grammar in `response-template.ts`, and NOT a second copy
// of it — the editor and the renderer answering differently about the same token is the defect this
// screen exists to remove.
//
// No markdown grammar. `@codemirror/lang-markdown` is not in the tree, the template is never
// RENDERED as markdown by anything (the runtime hands the text to the model), and highlighting a
// convention nobody enforces is two dependencies for decoration.

const tokenMark = Decoration.mark({ class: "cm-tplToken" });
const blockMark = Decoration.mark({ class: "cm-tplBlock" });
const badMark = Decoration.mark({ class: "cm-tplBad" });

// Drawn off the WHOLE document rather than the visible ranges. A decoration built per viewport has
// to be rebuilt on scroll and cannot straddle the edge, and this field has a bounded height with a
// template measured in lines, not in thousands of them.
function decorationsFor(doc: string): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const s of scanTemplate(doc)) {
    b.add(
      s.from,
      s.to,
      !s.usable ? badMark : s.kind === "token" ? tokenMark : blockMark,
    );
  }
  return b.finish();
}

const highlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorationsFor(view.state.doc.toString());
    }
    update(u: ViewUpdate) {
      if (u.docChanged) {
        this.decorations = decorationsFor(u.state.doc.toString());
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Against the console's own custom properties, like every other theme in this editor, so light mode
// costs nothing and there is no second palette to keep in step.
const tokenTheme = EditorView.theme({
  ".cm-tplToken": { color: "var(--color-accent)", fontWeight: "500" },
  ".cm-tplBlock": { color: "var(--color-text-secondary)", fontWeight: "600" },
  ".cm-tplBad": {
    color: "var(--color-error)",
    textDecoration: "underline wavy",
    textUnderlineOffset: "0.2em",
  },
});

// WHAT THE LIST OFFERS AT THIS CARET. Exported so the rule is driven directly: asking CodeMirror to
// render a popup through happy-dom would measure the DOM, not the offer.
export function templateSource(
  sample: TemplateSampleOffer,
  t: TFunction,
): (ctx: CompletionContext) => CompletionResult | null {
  return (ctx) => {
    const doc = ctx.state.doc.toString();
    const write = templateWriteAt(doc, ctx.pos);
    if (write === null) return null;
    const offer = templateOfferAt(doc, ctx.pos, sample);
    // NOTE: after `{{#each ` only a list renders, so only lists are offered there. A scalar field
    // picked into a block writes something the save refuses, over a value that was sitting right
    // there.
    const options: Completion[] =
      write.kind === "list"
        ? offer.lists.map((l) => ({
            label: l.path,
            type: "class",
            // THE PICKER'S OWN KEY, not a second one saying the same thing. Two keys for one
            // sentence is two translations to keep in step, and the second was born without a real
            // singular ("1 items"), which the plural fence in `tests/client/locale-plurals.test.ts`
            // refuses on sight.
            detail: t("tools.outputTemplateListLength", "{{count}} items", {
              count: l.length,
            }),
            apply: applying(l.path),
          }))
        : offer.leaves.map((leaf) => ({
            label: leaf.path,
            type: "property",
            detail: leaf.value,
            apply: applying(leaf.path),
          }));
    if (options.length === 0) return null;
    // NOTE: `to` is the CARET, never the end of the path being replaced. Measured in the installed
    // `@codemirror/autocomplete`: the filter pattern is `sliceDoc(active.from, active.to)` with
    // `to` taken from this result, so a range covering the old path filtered every candidate
    // against `foo` and hid the ones meant to replace it (round 3 of review). What the answer
    // REPLACES is decided in the apply, off the document as it stands then.
    return {
      from: write.from,
      to: write.to,
      options,
      // NOTE: what may change WITHOUT asking this source again, and it is narrower than "not a
      // brace". `validFor` keeps one result alive while the text still matches, so a pattern that
      // admitted `#each ` kept the SCALAR options after the operator turned the token into a block:
      // the list was then filtered against path labels, the popup emptied, and the lists this field
      // advertises never arrived (round 4 of review). A path carries none of these characters, so
      // excluding them re-asks at exactly the two moments the answer changes — a `#` that starts a
      // marker, and the whitespace that moves where the path begins.
      validFor: /^[^\s{}#/]*$/,
    };
  };
}

// Accepting an answer closes the token when nothing else does, and leaves the caret PAST the close
// either way. Both halves were measured in the browser rather than reasoned:
//
//   - without the close, picking from a list opened by typing `{{` leaves `{{path` on screen, a
//     stray brace that reaches the model verbatim;
//   - `closeBrackets` turns a typed `{{` into `{{}}`, so the ordinary case is the one where the
//     braces already exist, and putting the caret at the end of the inserted path put it INSIDE the
//     token. Everything typed next landed in there: typing a value and then a block produced
//     `{{cliente.nome{{#each resultados}}}}` on one line.
function applying(path: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    // NOTE: asked AGAIN, against the document as it stands at acceptance, rather than closing over
    // the answer the offer was built from (round 1 of review). `validFor` keeps one result alive
    // while the operator types the path, so the offer is computed against `{{}}` and applied
    // against `{{cli}}`: a captured close position is then three characters short, which put the
    // caret inside the token, and a captured one past a DELETION exceeds the document and makes
    // the dispatch throw.
    const write = templateWriteAt(view.state.doc.toString(), to);
    const insert = write?.closeAt == null ? `${path}}}` : path;
    // NOTE: through the end of the path already in the token, which the filter range above is not
    // allowed to cover. Never before the caret, so a document that moved out from under the offer
    // degrades to replacing what was typed.
    const end = Math.max(write?.pathEnd ?? to, to);
    view.dispatch({
      changes: { from, to: end, insert },
      selection: {
        anchor:
          write?.closeAt == null
            ? from + insert.length
            : // Past the `}}` already there, shifted by what this edit changes in length.
              write.closeAt + insert.length - (end - from),
      },
    });
  };
}

export function templateExtensions(
  sample: TemplateSampleOffer,
  t: TFunction,
): Extension {
  return [
    highlight,
    tokenTheme,
    autocompletion({ override: [templateSource(sample, t)], icons: false }),
  ];
}
