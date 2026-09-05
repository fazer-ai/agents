import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  completionKeymap,
  completionStatus,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { TFunction } from "i18next";
import { useEffect, useId, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";
import { CODE_TOOL_CONTEXT_VARS } from "@/lib/code-tool-vocabulary";
import { claimEscape } from "./escapeClaim";
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
  { tag: tags.keyword, color: "var(--color-purple)" },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--color-success)",
  },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--color-warning)" },
  {
    tag: tags.comment,
    color: "var(--color-text-muted)",
    fontStyle: "italic",
  },
  {
    tag: [tags.propertyName, tags.definition(tags.variableName)],
    color: "var(--color-accent)",
  },
  { tag: tags.invalid, color: "var(--color-error)" },
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

// The context descriptions as they reach the POPUP, which is console text and therefore bilingual.
// Twelve static `t()` calls rather than one keyed by `v.name`: a computed key is invisible to
// `bun i18n:extract`, which deletes every key it cannot see, and it is refused by
// `no-dynamic-i18n-key`. Same shape as `nativeTools.ts`, for the same reason. The English defaults
// are the vocabulary's own sentences and a test holds the two equal, so this copy cannot drift from
// the one `code_tool_schema` serves over MCP.
function contextDescriptions(t: TFunction): Record<string, string> {
  return {
    conversation_id: t(
      "codeTools.completion.context.conversation_id",
      "Chatwoot conversation id. Absent when the tool runs outside a conversation (the playground, a test run).",
    ),
    message_id: t(
      "codeTools.completion.context.message_id",
      "Chatwoot id of the message that triggered this turn. Absent outside a conversation.",
    ),
    contact_id: t(
      "codeTools.completion.context.contact_id",
      "Chatwoot contact id. Absent when the conversation has none.",
    ),
    contact_name: t(
      "codeTools.completion.context.contact_name",
      "The contact's name. Absent when the contact has none.",
    ),
    contact_email: t(
      "codeTools.completion.context.contact_email",
      "The contact's e-mail. Absent when the contact has none.",
    ),
    contact_phone: t(
      "codeTools.completion.context.contact_phone",
      "The contact's phone. Absent when the contact has none.",
    ),
    inbox_id: t(
      "codeTools.completion.context.inbox_id",
      "Chatwoot inbox id. Absent outside a conversation.",
    ),
    inbox_name: t(
      "codeTools.completion.context.inbox_name",
      "The inbox's name. Absent when the inbox has none.",
    ),
    company_name: t(
      "codeTools.completion.context.company_name",
      "The tenant's name. Absent when the tenant has none.",
    ),
    agent_name: t(
      "codeTools.completion.context.agent_name",
      "The agent's name. The one value that is always present.",
    ),
    conversationAttributes: t(
      "codeTools.completion.context.conversationAttributes",
      "The conversation's custom attributes, mirrored from Chatwoot and read when the tool is CALLED, so a value set_custom_attribute wrote in an EARLIER step of the turn is already here. Not one written in the same step: the tool calls of a single model message run together, so those two race. Empty object when there are none.",
    ),
    contactAttributes: t(
      "codeTools.completion.context.contactAttributes",
      "The contact's custom attributes, on the same terms as conversationAttributes. Empty object when there are none.",
    ),
  };
}

// The completions for `context.`, built from the vocabulary module. `detail` carries the type and
// whether the value is always there, because that is what decides if the body needs a `??` and it is
// the one thing a name alone cannot tell you. It stays untranslated on purpose: `string` and
// `object` are the language's own words for those types, not prose about them.
function contextCompletions(t: TFunction): Completion[] {
  const described = contextDescriptions(t);
  return CODE_TOOL_CONTEXT_VARS.map((v) => ({
    label: v.name,
    type: v.type === "object" ? "class" : "property",
    detail: v.always ? v.type : `${v.type}?`,
    info: described[v.name] ?? v.description,
  }));
}

// Below this fraction of the cap the counter is noise, exactly as in `Textarea`.
const COUNTER_FROM = 0.8;

// The mark on a write that came from the PROP rather than from the keyboard. The cap below refuses
// an edit, and a controlled write is not an edit: refusing one leaves CodeMirror showing a document
// the form no longer holds, silently, and the operator's next keystroke then writes that stale text
// back over the value they never saw. A body arriving over the cap is exactly the case this
// component exists to let them shorten.
const CONTROLLED = Annotation.define<boolean>();

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// An argument name is any non-empty string: `schemaFromAiFields` only trims it, the service stores a
// `z.record(z.string())`, and the model is offered the key verbatim. So `order-id` and `first name`
// are declarable, and completing them after the dot would write `input.order-id`, which parses as a
// subtraction, or `input.first name`, which does not parse at all. Those names complete to a
// SUBSCRIPT instead, which means eating the dot the operator already typed.
function bracketApply(name: string) {
  const insert = `[${JSON.stringify(name)}]`;
  return (
    view: EditorView,
    _completion: Completion,
    from: number,
    to: number,
  ) => {
    const doc = view.state.doc;
    const afterDot = from >= 1 && doc.sliceString(from - 1, from) === ".";
    // NOTE: `?.` survives, because `input?["x"]` is a conditional expression and `input?.["x"]` is
    // the access. The two characters are always adjacent when they reach here: the source's regex
    // allows whitespace before the `?` and after the `.`, never between them.
    const optional =
      afterDot && from >= 2 && doc.sliceString(from - 2, from - 1) === "?";
    const start = afterDot && !optional ? from - 1 : from;
    view.dispatch({
      changes: { from: start, to, insert },
      selection: { anchor: start + insert.length },
    });
  };
}

// EXPORTED for the test: what the editor offers after `context.` and after `input.`, as a function
// of the declared argument names. Driving CodeMirror's own completion through a headless DOM to ask
// this would measure jsdom, not the rule.
export function completionsFor(
  path: "context" | "input",
  argumentNames: readonly string[],
  t: TFunction,
): Completion[] {
  if (path === "context") return contextCompletions(t);
  const detail = t("codeTools.completion.argumentDetail", "argument");
  const info = t(
    "codeTools.completion.argumentInfo",
    "Declared in Arguments, above.",
  );
  // NOTE: the arguments as they stand in the panel above, not as they were last saved: renaming one and
  // typing `input.` has to offer the new name, or the completion is a second source of truth about
  // the same form.
  return argumentNames.map((name) => ({
    label: name,
    type: "property",
    detail,
    info,
    ...(IDENTIFIER.test(name) ? {} : { apply: bracketApply(name) }),
  }));
}

// `context` and `input` are the two names in scope, so a bare word completes to them too. Anything
// else the body writes is the operator's own.
function rootCompletions(t: TFunction): Completion[] {
  return [
    {
      label: "context",
      type: "variable",
      info: t("codeTools.completion.contextRoot", "The conversation's values."),
    },
    {
      label: "input",
      type: "variable",
      info: t(
        "codeTools.completion.inputRoot",
        "The arguments the agent sent.",
      ),
    },
  ];
}

// Whether the word that ends at `from` is a ROOT variable rather than the tail of something else.
// `matchBefore` matches a SUFFIX, so `mycontext.` and `config.input.` both end in one of the two
// names without either of them being the variable in scope, and offering this sandbox's members
// there writes code about the wrong object. The character before the match settles it: an
// identifier character means the name is the end of a longer one, and a dot means it is already a
// member of something else.
function isRootWord(ctx: CompletionContext, from: number): boolean {
  if (from === 0) return true;
  return !/[\w$.]/.test(ctx.state.doc.sliceString(from - 1, from));
}

export function sourceFor(
  argumentNames: readonly string[],
  t: TFunction,
): (ctx: CompletionContext) => CompletionResult | null {
  return (ctx) => {
    // NOTE: after a DOT, and the dot is what makes this cheap: no parse, no scope analysis, just the two
    // roots this sandbox actually has. `context ?. name` and `context.  name` are the same request,
    // so the whitespace the formatter may leave is allowed on both sides of the dot.
    const dotted = ctx.matchBefore(/(context|input)\s*\??\.\s*[\w$]*/);
    if (dotted && isRootWord(ctx, dotted.from)) {
      const path = dotted.text.trimStart().startsWith("context")
        ? "context"
        : "input";
      const options = completionsFor(path, argumentNames, t);
      if (options.length === 0) return null;
      // NOTE: the replaced range starts after the LAST dot, so accepting a completion never eats the
      // `context.` the operator already typed. A name that is not an identifier is the exception,
      // and it eats the dot itself in `bracketApply`.
      const from = dotted.from + dotted.text.lastIndexOf(".") + 1;
      return { from, options, validFor: /^[\w$]*$/ };
    }
    const word = ctx.matchBefore(/[\w$]+/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    if (!isRootWord(ctx, word.from)) return null;
    return {
      from: word.from,
      options: rootCompletions(t),
      validFor: /^[\w$]*$/,
    };
  };
}

// The attributes that go on CodeMirror's contenteditable, which is the element it gives the
// `textbox` role to. On the wrapper `div` below they would be dropped by the accessibility tree:
// a `div` has no role, so it has no name to label and no validity to report.
function contentAttrs(
  label: string | undefined,
  describedBy: string | undefined,
  invalid: boolean,
): Record<string, string> {
  return {
    ...(label ? { "aria-label": label } : {}),
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(invalid ? { "aria-invalid": "true" } : {}),
  };
}

// The identity of a declared-argument LIST, for the effect that reconfigures the completion source.
// Joining on a separator is wrong here because an argument name is not required to be an identifier:
// it can hold the separator itself, so `["first name", "age"]` and `["first", "name age"]` join to
// the same string and a rename between those two shapes leaves `input.` offering the old names.
// `JSON.stringify` escapes what it has to and cannot collide.
export function namesKeyOf(names: readonly string[]): string {
  return JSON.stringify(names);
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
  const { t, i18n } = useTranslation();
  const field = useFormField();
  // NOTE: a compartment so a renamed argument reconfigures the completion source in place.
  // Rebuilding the whole editor would drop the cursor and the undo history on every keystroke in
  // the panel above.
  const completionSlot = useMemo(() => new Compartment(), []);
  // NOTE: a second compartment for the same reason: the label, the invalid state and the
  // description all change while the editor stays mounted, and `contentAttributes` is read at
  // construction. Without it the attributes freeze at whatever they were when the body first
  // rendered, which for `aria-invalid` means never.
  const attrsSlot = useMemo(() => new Compartment(), []);
  const names = useMemo(() => [...argumentNames], [argumentNames]);
  const namesKey = namesKeyOf(names);
  // NOTE: the label and the description go on the element CodeMirror gives the textbox role to, not
  // on the wrapper below. A wrapper `div` has no role, so `aria-label` on it is dropped by the
  // accessibility tree and the field reads as unlabelled.
  const label = rest["aria-label"];
  // NOTE: the counter `<Textarea>` renders, kept when the body moved off one: the change filter
  // REFUSES an edit at the cap, so without it the field simply stops accepting characters with
  // nothing on screen saying why. Same threshold as the textarea's, so warning arrives before the
  // wall rather than at it, and the same over-limit line for a body that arrived past the cap and
  // has to be edited down.
  const count = value.length;
  const over = typeof maxLength === "number" && count > maxLength;
  const showCount =
    typeof maxLength === "number" && count >= maxLength * COUNTER_FROM;
  // NOTE: the over-limit line is the only thing on screen that says why this body cannot be saved,
  // so it has to reach the accessibility tree the way `<Textarea>`'s does: an id the textbox points
  // at, plus `aria-invalid` on the textbox itself. Both live on CodeMirror's contenteditable, which
  // is the element carrying the `textbox` role.
  const overId = useId();
  const invalidNow = !!invalid || !!field.invalid || over;
  const describedBy = mergeDescribedBy(
    field.describedById,
    over ? overId : undefined,
  );

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
        autocompletion({ override: [sourceFor(names, t)], icons: false }),
      ),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
      attrsSlot.of(
        EditorView.contentAttributes.of(
          contentAttrs(label, describedBy, invalidNow),
        ),
      ),
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
          if (tr.annotation(CONTROLLED)) return true;
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
    // NOTE: Escape belongs to the completion popup while it is open. The dialog around this editor
    // closes on Escape, and Radix hears it first (capture phase on `document`), so the editor
    // cannot stop the event: it declares the claim and `<Modal>` cancels the dismissal. The popup
    // itself is closed here, because a claim that only reported would leave it open when the press
    // it answered was the press meant to close it.
    const release = claimEscape((target) => {
      if (!(target instanceof Node) || !v.dom.contains(target)) return false;
      // NOTE: `null` is the only status that gives Escape back to the dialog. `"pending"` is the
      // debounce window CodeMirror opens the moment a trigger is typed, so an operator who types
      // `context.` and reaches for Escape within ~75 ms would otherwise be asked whether to discard
      // the body: the popup they were dismissing had not finished arriving. `closeCompletion`
      // cancels a pending query as well as an open one.
      if (completionStatus(v.state) === null) return false;
      closeCompletion(v);
      return true;
    });
    return () => {
      release();
      v.destroy();
      view.current = null;
    };
  }, [completionSlot, attrsSlot, maxLength, placeholder]);

  // NOTE: an external change (the form resetting, a starter body applied) written into the document
  // without disturbing a cursor that is already where the operator put it, and kept OUT of the undo
  // history: it is not an edit the operator made, so Ctrl-Z must not resurrect what it replaced.
  // Measured on the tree as it stands, the reachable openings are already safe by accident — the
  // dialog unmounts its content on close, so a reopening builds a new view with an empty history,
  // and an edit's body only arrives before the editor mounts, behind the loading skeleton. This
  // makes it true by construction instead, for the first caller that writes `value` while the
  // editor is on screen.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === value) return;
    v.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: [Transaction.addToHistory.of(false), CONTROLLED.of(true)],
    });
  }, [value]);

  // NOTE: the attributes the accessibility tree reads, reapplied whenever they change. `invalid`
  // and the over-limit description are runtime state, so a construction-time read of them would be
  // a `aria-invalid` that is decided once, before the operator has typed anything.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({
      effects: attrsSlot.reconfigure(
        EditorView.contentAttributes.of(
          contentAttrs(label, describedBy, invalidNow),
        ),
      ),
    });
  }, [attrsSlot, label, describedBy, invalidNow]);

  // NOTE: `namesKey` and not `names`: a new array holding the same names is not a change worth
  // reconfiguring for, and the parent rebuilds that array on every render. The language is here for
  // the other half of what the source closes over: the popup's own text, which has to follow a
  // language switch without the operator reopening the modal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `namesKey` and the language are what change
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({
      effects: completionSlot.reconfigure(
        autocompletion({ override: [sourceFor(names, t)], icons: false }),
      ),
    });
  }, [namesKey, completionSlot, i18n.language]);

  return (
    <div className="w-full">
      <div
        ref={host}
        className={cn(
          "w-full overflow-hidden [&_.cm-editor]:min-h-[var(--code-min-h)]",
          invalid || field.invalid || over ? "[&_.cm-editor]:border-error" : "",
          className,
        )}
        style={{ "--code-min-h": minHeight } as React.CSSProperties}
      />
      {showCount && (
        <span
          className={cn(
            "mt-1 block text-right text-xs",
            over ? "text-error" : "text-text-muted",
          )}
        >
          {`${count}/${maxLength}`}
        </span>
      )}
      {over && typeof maxLength === "number" && (
        <span id={overId} className="mt-1 block text-error text-xs">
          {t(
            "codeTools.codeOverLimit",
            "{{count}} character over the limit. Shorten the body: a save above {{max}} is refused.",
            { count: count - maxLength, max: maxLength },
          )}
        </span>
      )}
    </div>
  );
}
