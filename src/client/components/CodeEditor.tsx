import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/client/lib/utils";
import { CODE_TOOL_CONTEXT_VARS } from "@/lib/code-tool-vocabulary";
import { mergeDescribedBy, useFormField } from "./FormFieldContext";

// The code tool's editor (issue #538). CodeMirror 6 rather than Monaco for one reason that is a
// property of this deployment and not a preference: the production CSP grants neither `unsafe-eval`
// nor `wasm-unsafe-eval` (src/api/lib/csp.ts), which Monaco needs and CodeMirror does not.
// CodeMirror's one requirement under a strict policy is an injected `<style>` element, and
// `styleSrc` already carries `'unsafe-inline'` in every environment, not only dev.
//
// The theme is written against the console's CSS CUSTOM PROPERTIES rather than against colours, so
// light mode costs nothing: `html[data-theme="light"]` swaps the variables and the editor follows,
// with no theme prop, no re-render and no second `EditorView.theme` to keep in step.

// A tiny highlight style. Deliberately six rules and not a full palette: a body here is thirty lines
// of arithmetic over `input`, and the thing worth seeing at a glance is which words are STRINGS and
// which are keywords, because an unterminated string is the mistake a textarea hides best.
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--color-purple)" },
  { tag: [t.string, t.special(t.string)], color: "var(--color-success)" },
  { tag: [t.number, t.bool, t.null], color: "var(--color-warning)" },
  { tag: t.comment, color: "var(--color-text-muted)", fontStyle: "italic" },
  {
    tag: [t.propertyName, t.definition(t.variableName)],
    color: "var(--color-accent)",
  },
  { tag: t.invalid, color: "var(--color-error)" },
]);

const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--color-bg-tertiary)",
    color: "var(--color-text-primary)",
    borderRadius: "0.5rem",
    border: "1px solid var(--color-border)",
    fontSize: "0.75rem",
  },
  "&.cm-focused": {
    outline: "none",
    borderColor: "var(--color-border-focus)",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "0.5rem 0",
    caretColor: "var(--color-text-primary)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--color-text-placeholder)",
    border: "none",
    fontFamily: "var(--font-mono)",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-cursor": { borderLeftColor: "var(--color-text-primary)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
    {
      backgroundColor: "var(--color-accent-muted)",
    },
  ".cm-placeholder": { color: "var(--color-text-placeholder)" },
  ".cm-tooltip": {
    backgroundColor: "var(--color-bg-secondary)",
    border: "1px solid var(--color-border)",
    borderRadius: "0.5rem",
    color: "var(--color-text-primary)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--color-bg-hover)",
    color: "var(--color-text-primary)",
  },
  ".cm-completionDetail": {
    color: "var(--color-text-muted)",
    fontStyle: "normal",
    marginLeft: "0.5rem",
  },
  ".cm-completionInfo": {
    backgroundColor: "var(--color-bg-secondary)",
    border: "1px solid var(--color-border)",
    borderRadius: "0.5rem",
    color: "var(--color-text-secondary)",
    maxWidth: "22rem",
    padding: "0.5rem 0.625rem",
  },
});

// The completions for `context.`, built once from the vocabulary module. `detail` carries the type
// and whether the value is always there, because that is what decides if the body needs a `??` and
// it is the one thing a name alone cannot tell you.
const CONTEXT_COMPLETIONS: Completion[] = CODE_TOOL_CONTEXT_VARS.map((v) => ({
  label: v.name,
  type: v.type === "object" ? "class" : "property",
  detail: v.always ? v.type : `${v.type}?`,
  info: v.description,
}));

// EXPORTED for the test: what the editor offers after `context.` and after `input.`, as a function
// of the declared argument names. Driving CodeMirror's own completion through a headless DOM to ask
// this would measure jsdom, not the rule.
export function completionsFor(
  path: "context" | "input",
  argumentNames: readonly string[],
): Completion[] {
  if (path === "context") return CONTEXT_COMPLETIONS;
  // NOTE: the arguments as they stand in the panel above, not as they were last saved: renaming one and
  // typing `input.` has to offer the new name, or the completion is a second source of truth about
  // the same form.
  return argumentNames.map((name) => ({
    label: name,
    type: "property",
    detail: "argument",
    info: "Declared in Arguments, above.",
  }));
}

// `context` and `input` are the two names in scope, so a bare word completes to them too. Anything
// else the body writes is the operator's own.
const ROOT_COMPLETIONS: Completion[] = [
  { label: "context", type: "variable", info: "The conversation's values." },
  { label: "input", type: "variable", info: "The arguments the agent sent." },
];

function sourceFor(
  argumentNames: readonly string[],
): (ctx: CompletionContext) => CompletionResult | null {
  return (ctx) => {
    // NOTE: after a DOT, and the dot is what makes this cheap: no parse, no scope analysis, just the two
    // roots this sandbox actually has. `context ?. name` and `context.  name` are the same request,
    // so the whitespace the formatter may leave is allowed on both sides of the dot.
    const dotted = ctx.matchBefore(/(context|input)\s*\??\.\s*[\w$]*/);
    if (dotted) {
      const path = dotted.text.trimStart().startsWith("context")
        ? "context"
        : "input";
      const options = completionsFor(path, argumentNames);
      if (options.length === 0) return null;
      // NOTE: the replaced range starts after the LAST dot, so accepting a completion never eats the
      // `context.` the operator already typed.
      const from = dotted.from + dotted.text.lastIndexOf(".") + 1;
      return { from, options, validFor: /^[\w$]*$/ };
    }
    const word = ctx.matchBefore(/[\w$]+/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    return { from: word.from, options: ROOT_COMPLETIONS, validFor: /^[\w$]*$/ };
  };
}

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  // The names declared in the arguments panel, so `input.` completes to what the operator just
  // declared rather than to what was last saved.
  argumentNames?: readonly string[];
  maxLength?: number;
  placeholder?: string;
  minHeight?: string;
  invalid?: boolean;
  "aria-label"?: string;
  className?: string;
}

export function CodeEditor({
  value,
  onChange,
  argumentNames = [],
  maxLength,
  placeholder,
  minHeight = "18rem",
  invalid,
  className,
  ...rest
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const field = useFormField();
  // NOTE: a compartment so a renamed argument reconfigures the completion source in place.
  // Rebuilding the whole editor would drop the cursor and the undo history on every keystroke in
  // the panel above.
  const completionSlot = useMemo(() => new Compartment(), []);
  const names = useMemo(() => [...argumentNames], [argumentNames]);
  const namesKey = names.join(" ");
  // NOTE: the label and the description go on the element CodeMirror gives the textbox role to, not
  // on the wrapper below. A wrapper `div` has no role, so `aria-label` on it is dropped by the
  // accessibility tree and the field reads as unlabelled.
  const label = rest["aria-label"];
  const describedBy = mergeDescribedBy(field.describedById, undefined);

  // NOTE: the editor is built ONCE. `value` is applied by the effect below and the completion source
  // by its compartment; listing either here would tear the editor down on every keystroke, taking
  // the cursor and the undo history with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the two effects below apply them
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      javascript(),
      syntaxHighlighting(highlight),
      theme,
      EditorView.lineWrapping,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
      ]),
      completionSlot.of(
        autocompletion({ override: [sourceFor(names)], icons: false }),
      ),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
      EditorView.contentAttributes.of({
        ...(label ? { "aria-label": label } : {}),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
      }),
    ];
    if (placeholder) extensions.push(placeholderExt(placeholder));
    if (typeof maxLength === "number") {
      // NOTE: the cap enforced where the browser enforces `maxLength` on a textarea: the change is
      // REFUSED rather than truncated, so a paste that would overflow leaves the document as it
      // was instead of landing half a line. A value already past the cap (imported, or written
      // through the API before the cap existed) still opens and still edits down, because the
      // filter only asks about the length the change would PRODUCE.
      extensions.push(
        EditorState.changeFilter.of((tr) => {
          if (!tr.docChanged) return true;
          const before = tr.startState.doc.length;
          const after = tr.newDoc.length;
          return after <= maxLength || after <= before;
        }),
      );
    }
    const v = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent,
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [completionSlot, maxLength, placeholder, label, describedBy]);

  // NOTE: an external change (the form resetting, a starter body applied) written into the document
  // without disturbing a cursor that is already where the operator put it.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === value) return;
    v.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  // NOTE: `namesKey` and not `names`: a new array holding the same names is not a change worth
  // reconfiguring for, and the parent rebuilds that array on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `namesKey` is what changes
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({
      effects: completionSlot.reconfigure(
        autocompletion({ override: [sourceFor(names)], icons: false }),
      ),
    });
  }, [namesKey, completionSlot]);

  return (
    <div
      ref={host}
      className={cn(
        "w-full overflow-hidden [&_.cm-editor]:min-h-[var(--code-min-h)]",
        invalid || field.invalid ? "[&_.cm-editor]:border-error" : "",
        className,
      )}
      style={{ "--code-min-h": minHeight } as React.CSSProperties}
    />
  );
}
