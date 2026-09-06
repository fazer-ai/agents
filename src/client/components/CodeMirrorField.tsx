import {
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  completionKeymap,
  completionStatus,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
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
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/client/lib/utils";
import { claimEscape } from "./escapeClaim";
import { mergeDescribedBy, useFormField } from "./FormFieldContext";

// The console's CodeMirror field, with no language of its own (issue #562). Everything here is true
// of any language: the view built once, the controlled document, the accessibility attributes on the
// contenteditable, the placeholder, the character cap and the Escape claim. What the editor IS —
// the grammar, the completion source, the extra key bindings — arrives as `extensions` from the
// caller, in a compartment, so a rename in the arguments panel above reconfigures the source in
// place instead of tearing the editor down with the cursor and the undo history inside it.
//
// CodeMirror 6 rather than Monaco for one reason that is a property of this deployment and not a
// preference: the production CSP grants neither `unsafe-eval` nor `wasm-unsafe-eval`
// (src/api/lib/csp.ts), which Monaco needs and CodeMirror does not. CodeMirror's one requirement
// under a strict policy is an injected `<style>` element, and `styleSrc` already carries
// `'unsafe-inline'` in every environment, not only dev.
//
// The theme is written against the console's CSS CUSTOM PROPERTIES rather than against colours, so
// light mode costs nothing: `html[data-theme="light"]` swaps the variables and the editor follows,
// with no theme prop, no re-render and no second `EditorView.theme` to keep in step.

// A tiny highlight style, shared by every language this field is given. Deliberately six rules and
// not a full palette: the thing worth seeing at a glance is which words are STRINGS and which are
// structure, because an unterminated string is the mistake a textarea hides best — in a code body
// and in a pasted API response alike.
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
  ".cm-scopeHover": { maxWidth: "22rem", padding: "0.5rem 0.625rem" },
  ".cm-scopeHoverHead": {
    alignItems: "baseline",
    display: "flex",
    gap: "0.5rem",
  },
  ".cm-scopeHoverName": { fontWeight: "500" },
  ".cm-scopeHoverDetail": {
    color: "var(--color-text-muted)",
    fontSize: "0.75rem",
  },
  ".cm-scopeHoverInfo": {
    color: "var(--color-text-secondary)",
    margin: "0.25rem 0 0",
  },
});

// Below this fraction of the cap the counter is noise, exactly as in `Textarea`.
const COUNTER_FROM = 0.8;

// The mark on a write that came from the PROP rather than from the keyboard. The cap below refuses
// an edit, and a controlled write is not an edit: refusing one leaves CodeMirror showing a document
// the form no longer holds, silently, and the operator's next keystroke then writes that stale text
// back over the value they never saw. A body arriving over the cap is exactly the case this
// component exists to let them shorten.
const CONTROLLED = Annotation.define<boolean>();

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

// A cap and the two sentences that report it, together or not at all. They travel as ONE prop
// because a cap without words is the failure this component was built to avoid: the change filter
// refuses the paste whole, and a refusal nobody sees is a field that stopped accepting text for no
// reason. The words come from the caller because they name what is being capped ("the body", "the
// sample"), which the shell has no way to know.
export interface EditorCap {
  max: number;
  // How far over the cap the document stands, for the line that says why it cannot be saved.
  overLimit: (excess: number, max: number) => string;
  // How far over the cap the REFUSED change would have gone, for the line that says why nothing
  // was inserted.
  refused: (excess: number, max: number) => string;
}

export interface CodeMirrorFieldProps {
  value: string;
  onChange: (value: string) => void;
  // The language and anything that goes with it, MEMOIZED BY THE CALLER: its identity is what
  // triggers a reconfiguration, so a fresh array on every render would reconfigure on every render.
  // Placed before the shell's own keymap, so a caller's binding wins over the defaults.
  extensions?: Extension;
  cap?: EditorCap;
  placeholder?: string;
  minHeight?: string;
  // A ceiling on the field, so the DOCUMENT does not decide how tall the form is: past it the editor
  // scrolls inside itself, which is what the `rows` of a textarea gives for free. Optional, because
  // an editor that is the whole point of its screen (the code tool's body) wants to grow.
  maxHeight?: string;
  invalid?: boolean;
  "aria-label"?: string;
  className?: string;
}

export function CodeMirrorField({
  value,
  onChange,
  extensions,
  cap,
  placeholder,
  minHeight = "18rem",
  maxHeight,
  invalid,
  className,
  ...rest
}: CodeMirrorFieldProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const field = useFormField();
  // NOTE: a compartment so the caller can change what the editor IS — a renamed argument
  // reconfiguring a completion source, a language switching under the same document — without the
  // editor being rebuilt, which would drop the cursor and the undo history with it.
  const extSlot = useMemo(() => new Compartment(), []);
  // NOTE: a second compartment for the same reason: the label, the invalid state and the
  // description all change while the editor stays mounted, and `contentAttributes` is read at
  // construction. Without it the attributes freeze at whatever they were when the body first
  // rendered, which for `aria-invalid` means never.
  const attrsSlot = useMemo(() => new Compartment(), []);
  // NOTE: and a third, for the same event the completion source reconfigures for. The placeholder
  // is console text (`starterCode(t)`), so it changes when the operator switches the language with
  // the modal open, and as a lifecycle dependency that switch rebuilt the whole view: cursor,
  // selection and undo history gone, mid-body. The cap below is NOT one of these, because it is a
  // constant of the sandbox and cannot change under a mounted editor.
  const holderSlot = useMemo(() => new Compartment(), []);
  // How far past the cap the last refused change would have gone, and 0 while nothing is refused.
  // The ref is what the filter reads: it runs on every keystroke, and a setState per keystroke to
  // write the same 0 is a render pass for nothing.
  const [refusedExcess, setRefusedExcess] = useState(0);
  const refused = useRef(0);
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
  // NOTE: the NUMBER, not the object. It is what the change filter needs and what the editor is
  // built against, so depending on the object would rebuild the whole view — cursor and undo
  // history included — every time the caller rendered a fresh one. The two sentences are read at
  // render and never from inside the view.
  const capMax = cap?.max;
  const over = capMax !== undefined && count > capMax;
  const showCount =
    capMax !== undefined &&
    (refusedExcess > 0 || count >= capMax * COUNTER_FROM);
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
    const base: Extension[] = [
      lineNumbers(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      // BEFORE the keymap below, so a caller's binding is reached first.
      extSlot.of(extensions ?? []),
      syntaxHighlighting(highlight),
      theme,
      EditorView.lineWrapping,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        // NOTE: a write from the PROP is not an edit, and reporting it hands the form a string it
        // never chose. CodeMirror splits an incoming document on `\r\n?|\n` and re-serializes with
        // `\n`, so a body stored with CRLF (saved over MCP from a Windows client, or imported) can
        // never be held as written: the sync effect sees a document that differs from the prop,
        // writes the prop in again, and the form would take the normalized text as the operator's
        // work. The tool would then be dirty the moment it opens, with Escape offering to discard
        // changes nobody made. `every` and not `some` so that a batch carrying a real edit
        // alongside a controlled write is still reported; the two are indistinguishable today,
        // because the sync effect dispatches alone, and no test can separate them from out here.
        if (u.transactions.every((tr) => tr.annotation(CONTROLLED))) return;
        onChangeRef.current(u.state.doc.toString());
      }),
      attrsSlot.of(
        EditorView.contentAttributes.of(
          contentAttrs(label, describedBy, invalidNow),
        ),
      ),
    ];
    base.push(holderSlot.of(placeholder ? placeholderExt(placeholder) : []));
    if (capMax !== undefined) {
      // NOTE: the change is refused WHOLE rather than trimmed to fit, which is where this parts
      // from `<textarea maxLength>` on purpose. Measured: the browser truncates a paste into a
      // textarea, and for prose losing the tail is harmless. A JavaScript body truncated to fit is
      // a body missing its last lines that saves clean and fails when the agent calls it. So the
      // paste is refused, and the refusal is SAID below: a refusal nobody sees is a field that
      // stopped accepting text for no reason, and on a short body there is not even a counter on
      // screen to hint at a cap. A value already past the cap (imported, or written through the
      // API before the cap existed) still opens and still edits down, because the filter only asks
      // about the length the change would PRODUCE.
      base.push(
        EditorState.changeFilter.of((tr) => {
          if (!tr.docChanged) return true;
          if (tr.annotation(CONTROLLED)) return true;
          const before = tr.startState.doc.length;
          const after = tr.newDoc.length;
          const excess = after > capMax && after > before ? after - capMax : 0;
          if (refused.current !== excess) {
            refused.current = excess;
            setRefusedExcess(excess);
          }
          return excess === 0;
        }),
      );
    }
    const v = new EditorView({
      state: EditorState.create({ doc: value, extensions: base }),
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
  }, [extSlot, attrsSlot, holderSlot, capMax]);

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
    // NOTE: the refusal described a paste against the body being replaced here, so it does not
    // describe anything any more.
    if (refused.current !== 0) {
      refused.current = 0;
      setRefusedExcess(0);
    }
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

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({
      effects: holderSlot.reconfigure(
        placeholder ? placeholderExt(placeholder) : [],
      ),
    });
  }, [holderSlot, placeholder]);

  // NOTE: by the PROP's identity, which is why it has to be memoized by the caller: this is the
  // seam a renamed argument or a switched language travels through, and reconfiguring is the whole
  // point of it being a compartment rather than a lifecycle dependency.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: extSlot.reconfigure(extensions ?? []) });
  }, [extSlot, extensions]);

  return (
    <div className="w-full">
      <div
        ref={host}
        className={cn(
          "w-full overflow-hidden [&_.cm-editor]:min-h-[var(--code-min-h)]",
          // NOTE: on the editor, so CodeMirror's own scroller (already `overflow: auto`) takes over
          // past the ceiling instead of the page growing.
          maxHeight ? "[&_.cm-editor]:max-h-[var(--code-max-h)]" : "",
          invalid || field.invalid || over ? "[&_.cm-editor]:border-error" : "",
          className,
        )}
        style={
          {
            "--code-min-h": minHeight,
            ...(maxHeight ? { "--code-max-h": maxHeight } : {}),
          } as React.CSSProperties
        }
      />
      {showCount && (
        <span
          className={cn(
            "mt-1 block text-right text-xs",
            over ? "text-error" : "text-text-muted",
          )}
        >
          {`${count}/${capMax}`}
        </span>
      )}
      {over && cap !== undefined && capMax !== undefined && (
        <span id={overId} className="mt-1 block text-error text-xs">
          {cap.overLimit(count - capMax, capMax)}
        </span>
      )}
      {refusedExcess > 0 && cap !== undefined && capMax !== undefined && (
        <span role="status" className="mt-1 block text-error text-xs">
          {cap.refused(refusedExcess, capMax)}
        </span>
      )}
    </div>
  );
}
