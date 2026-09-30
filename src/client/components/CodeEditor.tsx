import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  startCompletion,
} from "@codemirror/autocomplete";
import { javascript, localCompletionSource } from "@codemirror/lang-javascript";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import {
  type EditorView,
  hoverTooltip,
  type KeyBinding,
  keymap,
} from "@codemirror/view";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  CODE_TOOL_CONTEXT_VARS,
  CODE_TOOL_GLOBALS,
} from "@/lib/code-tool-vocabulary";
import { CodeMirrorField } from "./CodeMirrorField";

// The code tool's JavaScript editor, the language half of `CodeMirrorField`. Everything below is about
// the LANGUAGE (the grammar, what `input.` completes to, the scope hover, the key that shows it), and
// nothing below knows how a view is built or how a document is kept controlled. Design: docs/ui.md,
// "The code tool editor".

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
    contact_identifier: t(
      "codeTools.completion.context.contact_identifier",
      "The Chatwoot contact's identifier: the id your own system gave this customer. Absent when the contact has none.",
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
    // Back over the whitespace the source's regex allows after the dot, because the range
    // starts at the NAME: `input.  ord` replaced from `ord` alone would leave `input.  ["order-id"]`.
    let dot = from;
    while (dot > 0 && /\s/.test(doc.sliceString(dot - 1, dot))) dot--;
    const afterDot = dot >= 1 && doc.sliceString(dot - 1, dot) === ".";
    // `?.` survives, because `input?["x"]` is a conditional expression and `input?.["x"]` is
    // the access. The two characters are always adjacent when they reach here: the source's regex
    // allows whitespace before the `?` and after the `.`, never between them.
    const optional =
      afterDot && dot >= 2 && doc.sliceString(dot - 2, dot - 1) === "?";
    const start = afterDot ? (optional ? dot : dot - 1) : from;
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
    ...globalCompletions(t),
  ];
}

// What the sandbox puts in scope besides the two parameters. Only the four it installs itself carry
// a description; `JSON` and `Math` explain themselves, and a sentence per constructor is prose
// nobody reads in four locales.
function globalCompletions(t: TFunction): Completion[] {
  const described = describedGlobals(t);
  return CODE_TOOL_GLOBALS.map((g) => ({
    label: g.name,
    type: g.kind,
    detail: t("codeTools.completion.globalDetail", "sandbox"),
    ...(described[g.name] ? { info: described[g.name] } : {}),
  }));
}

// What the pointer is over, answered with the SAME `Completion` the list would have offered for that
// name, so hover and completion cannot disagree; a name this editor does not know answers nothing
// rather than a guess. The PARSER answers, not the characters around the cursor: `mycontext.contact_id`
// ends in one of the names without being it, and a look-back cannot tell without a lexer of its own.
export function hoverInfo(
  state: EditorState,
  pos: number,
  argumentNames: readonly string[],
  t: TFunction,
): { from: number; to: number; completion: Completion } | null {
  const tree = syntaxTree(state);
  // Both sides, because a pointer resting ON the last character of a name resolves to what follows
  // it: hovering the `d` of `contact_id` would otherwise answer for the `.` or the `)` after it.
  for (const side of [1, -1] as const) {
    const node = tree.resolveInner(pos, side);
    const text = state.doc.sliceString(node.from, node.to);
    const range = { from: node.from, to: node.to };

    if (node.name === "VariableName") {
      const found = rootCompletions(t).find((c) => c.label === text);
      if (found) return { ...range, completion: found };
      continue;
    }

    // `context.contact_id` and `input.cpf`, plus `context["contact_id"]` for the names that are not
    // identifiers, which is the same pair of spellings the completion writes.
    const quoted = node.name === "String";
    if (node.name !== "PropertyName" && !quoted) continue;
    const member = node.parent;
    if (member?.name !== "MemberExpression") continue;
    const objectNode = member.firstChild;
    if (objectNode?.name !== "VariableName") continue;
    const root = state.doc.sliceString(objectNode.from, objectNode.to);
    if (root !== "context" && root !== "input") continue;
    // A quoted subscript carries its quotes AND its escapes; the label never does, so stripping the
    // quotes is not enough. The editor writes such escapes itself: an argument named `sa"id` completes
    // through `bracketApply` as `input["sa\"id"]`, which only decoding matches back to the name.
    const name = quoted ? decodeStringLiteral(text) : text;
    if (name === null) continue;
    const found = completionsFor(root, argumentNames, t).find(
      (c) => c.label === name,
    );
    if (found) return { ...range, completion: found };
  }
  return null;
}

// The text a quoted subscript names. `JSON.parse` rather than a hand-written escape table, which
// misses the escapes nobody listed: the double-quoted form is what `bracketApply` writes with
// `JSON.stringify`, so the same grammar reads it back, `\\uXXXX` included. A single-quoted literal
// (typed by hand) is re-quoted into the JSON literal for the same string, so one parser answers for
// both. Unterminated returns null: a literal being typed is not a name yet, and answering for its
// prefix would put another argument's sentence under the pointer.
function decodeStringLiteral(literal: string): string | null {
  const quote = literal[0];
  if (quote !== '"' && quote !== "'") return null;
  if (literal.length < 2 || literal[literal.length - 1] !== quote) return null;
  let json = literal;
  if (quote === "'") {
    let inner = "";
    for (let i = 1; i < literal.length - 1; i++) {
      const ch = literal[i];
      if (ch === "\\") {
        const escaped = literal[++i];
        if (escaped === undefined) return null;
        inner += escaped === "'" ? "'" : `\\${escaped}`;
        continue;
      }
      inner += ch === '"' ? '\\"' : ch;
    }
    json = `"${inner}"`;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

// The tooltip itself. `above` so it does not cover the line being read, and no `strictSide` because
// a tooltip that flips below at the top of the field is better than one that is clipped away.
function scopeHover(argumentNames: string[], t: TFunction): Extension {
  return hoverTooltip((view, pos) => {
    const hit = hoverInfo(view.state, pos, argumentNames, t);
    if (!hit) return null;
    return {
      pos: hit.from,
      end: hit.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-scopeHover";
        const head = dom.appendChild(document.createElement("div"));
        head.className = "cm-scopeHoverHead";
        const name = head.appendChild(document.createElement("span"));
        name.className = "cm-scopeHoverName";
        name.textContent = String(hit.completion.label);
        if (hit.completion.detail) {
          const detail = head.appendChild(document.createElement("span"));
          detail.className = "cm-scopeHoverDetail";
          detail.textContent = hit.completion.detail;
        }
        if (typeof hit.completion.info === "string") {
          const info = dom.appendChild(document.createElement("p"));
          info.className = "cm-scopeHoverInfo";
          info.textContent = hit.completion.info;
        }
        return { dom };
      },
    };
  });
}

// The ONE key the console advertises, ours rather than CodeMirror's: none of CodeMirror's three
// reaches a Mac, and none of them fails visibly. `Ctrl-i` is bound beside `Mod-i` so that a wrong
// platform guess in `scopeKeyLabel` still names a key that works; CodeMirror's three stay installed
// as a silent fallback. Which chords macOS delivers: docs/ui.md, "The code tool editor".
export const SHOW_SCOPE_KEYS: readonly KeyBinding[] = [
  { key: "Mod-i", run: startCompletion, preventDefault: true },
  { key: "Ctrl-i", run: startCompletion, preventDefault: true },
];

// What to CALL that key in front of the operator. `Mod` is one binding and two names, and printing
// the wrong one is worse than printing none: it is a key the reader can press and watch do nothing.
//
// Each name follows its own platform, not CodeMirror's notation: Apple writes modifiers joined and
// symbolic (⌘I, never ⌘+I or Cmd-I), Microsoft writes them spelled out and joined by a plus
// (Ctrl+I). `Mod-i` is the BINDING's name and belongs in the keymap, not in front of a reader.
export function scopeKeyLabel(mac: boolean = isMacLike()): string {
  return mac ? "\u2318I" : "Ctrl+I";
}

// A MIRROR of `browser.mac` in @codemirror/view (dist/index.js:16-18), which is not exported. iOS is
// Mac-like there, detected through the Apple vendor plus a touch or Mobile signal, because iPadOS
// reports `MacIntel` and an iPhone reports `iPhone`: testing `platform` alone would print `Ctrl+I` to
// an iPhone whose bound key is ⌘I. Only the NAME is at stake, since both chords are bound above.
export function isMacLike(
  nav: Navigator | undefined = globalThis.navigator,
): boolean {
  if (!nav) return false;
  const safari = /Apple Computer/.test(nav.vendor || "");
  const ios =
    safari &&
    (/Mobile\/\w+/.test(nav.userAgent || "") || nav.maxTouchPoints > 2);
  return ios || /Mac/.test(nav.platform || "");
}

// The completion extension, in ONE place. It is installed at build and again by the reconfigure
// effect below, which also runs on mount, so the build-time copy never serves a completion and a
// difference between the two sites is invisible to every test. One function makes them the same by
// construction.
function completionExt(names: string[], t: TFunction): Extension {
  return [
    autocompletion({
      // `override` REPLACES the language's sources, so `localCompletionSource` is composed back in
      // here: without it the operator's own `const` is in scope for the parser and in no list.
      override: [sourceFor(names, t), localCompletionSource],
      icons: false,
    }),
    // The hover closes over the same two values the sources do, so it rides in the same compartment
    // and the reconfigure below carries both: a renamed argument changes what the pointer answers on
    // the same dispatch that changes what the list offers.
    scopeHover(names, t),
  ];
}

// Static `t()` calls, because the extractor cannot see a computed key (the same reason
// `contextDescriptions` is written out by hand).
function describedGlobals(t: TFunction): Record<string, string> {
  return {
    TIMEZONE: t(
      "codeTools.completion.global.TIMEZONE",
      "The agent's IANA time zone, as a string.",
    ),
    NOW_LOCAL: t(
      "codeTools.completion.global.NOW_LOCAL",
      "The moment the call started, in the agent's zone, as an ISO string.",
    ),
    console: t(
      "codeTools.completion.global.console",
      "log, warn, error, info and debug. What they print reaches the agent as the Output block, after the returned value.",
    ),
    Date: t(
      "codeTools.completion.global.Date",
      "Runs in the agent's zone rather than UTC, so `new Date().getHours()` is the hour where the agent is.",
    ),
  };
}

// The alphabet of the word being typed. An argument name is any string the operator declares and
// this console is Portuguese: `a\u00e7\u00e3o` is an ordinary field name, and an ASCII matcher drops
// the offer at the `\u00e7`, which is the letter that identifies it.
const WORD_CHARS = "\\p{ID_Continue}$";
const WORD_ONLY = new RegExp(`^[${WORD_CHARS}]*$`, "u");

// Whether the name that starts at `from` is a ROOT variable rather than a member of something else,
// asked of the PARSER. `matchBefore` matches a suffix, so `mycontext.` and `config.input.` end in one
// of the two names without being the variable in scope. Counting characters backwards is wrong: a
// non-ASCII letter before the name (`\u00e9context` is one identifier), a private field's `#`, a dot
// across a space or a comment all fool it. The parser calls a reference `VariableName` and a member
// `PropertyName`, and the node has to START here, which separates `context` from `mycontext`.
function isRootWord(ctx: CompletionContext, from: number): boolean {
  const node = syntaxTree(ctx.state).resolveInner(from, 1);
  return node.name === "VariableName" && node.from === from;
}

// The same question where there is no name yet: an explicit request with nothing typed. A cursor
// right after a member operator is a property position, whatever whitespace or comment precedes it.
// `\u26a0` is the parser failing to place what is here, which is what `const context.` and
// `class A { context.` look like. The positions where the scope key is worth pressing never produce
// it: an empty body is `Script`, and `const x = `, `a + `, `foo(` and `{a: ` each name a node.
function atRootPosition(ctx: CompletionContext): boolean {
  const name = syntaxTree(ctx.state).resolveInner(ctx.pos, -1).name;
  return name !== "." && name !== "\u26a0";
}

// A string, a comment and a regexp are places where a dot is a character, not a member access, and
// accepting an entry there rewrites the quoted words or the pattern. The parse is already in the
// state for the highlighting, and it tells `a / input` (division) from `/input./` (a pattern), which
// the characters cannot. The INNERMOST node decides, with no walk up the ancestors: the hole in a
// template string resolves to the expression inside, and a walk would block `${context.name}`.
const NOT_CODE = new Set([
  "String",
  "TemplateString",
  "RegExp",
  "LineComment",
  "BlockComment",
]);

function inNotCode(ctx: CompletionContext): boolean {
  return NOT_CODE.has(syntaxTree(ctx.state).resolveInner(ctx.pos, -1).name);
}

export function sourceFor(
  argumentNames: readonly string[],
  t: TFunction,
): (ctx: CompletionContext) => CompletionResult | null {
  return (ctx) => {
    if (inNotCode(ctx)) return null;
    // After a DOT, and the dot is what makes this cheap: no parse, no scope analysis, just the two
    // roots this sandbox actually has. `context ?. name` and `context.  name` are the same request,
    // so the whitespace the formatter may leave is allowed on both sides of the dot.
    const dotted = ctx.matchBefore(
      new RegExp(`(context|input)\\s*\\??\\.\\s*[${WORD_CHARS}]*`, "u"),
    );
    if (dotted && isRootWord(ctx, dotted.from)) {
      const path = dotted.text.trimStart().startsWith("context")
        ? "context"
        : "input";
      const options = completionsFor(path, argumentNames, t);
      if (options.length === 0) return null;
      // The replaced range starts after the LAST dot, so accepting a completion never eats the
      // `context.` the operator already typed. A name that is not an identifier is the exception,
      // and it eats the dot itself in `bracketApply`.
      const afterDot = dotted.text.lastIndexOf(".") + 1;
      const gap = /^\s*/.exec(dotted.text.slice(afterDot))?.[0].length ?? 0;
      const from = dotted.from + afterDot + gap;
      return { from, options, validFor: WORD_ONLY };
    }
    const word = ctx.matchBefore(new RegExp(`[${WORD_CHARS}]+`, "u"));
    // NOTE: `matchBefore` needs a character to match, so on a blank line it answers `null`. That is
    // exactly where the scope key is worth pressing: an operator staring at an empty body asking what
    // exists. An EXPLICIT request answers at the cursor; typing whitespace still opens nothing on
    // its own. The root check runs either way, so a request made after `foo.` still offers nothing:
    // `context` and `input` are variables, never members of somebody else's object.
    if (!word && !ctx.explicit) return null;
    if (word ? !isRootWord(ctx, word.from) : !atRootPosition(ctx)) return null;
    const from = word ? word.from : ctx.pos;
    return { from, options: rootCompletions(t), validFor: WORD_ONLY };
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
  const { t, i18n } = useTranslation();
  const names = useMemo(() => [...argumentNames], [argumentNames]);
  const namesKey = namesKeyOf(names);
  // `namesKey` and not `names`: the parent rebuilds that array on every render, and this memo IS
  // the reconfiguration trigger (`CodeMirrorField` reconfigures on its identity), so a fresh array
  // would reconfigure per render. The language is here because the popup's own text has to follow a
  // language switch without the operator reopening the modal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `namesKey` and the language are what change
  const extensions = useMemo(
    () => [
      javascript(),
      completionExt(names, t),
      // NOTE: its own keymap, ahead of the field's defaults, because that is the precedence the
      // shell gives a caller's extensions.
      keymap.of([...SHOW_SCOPE_KEYS]),
    ],
    [namesKey, i18n.language],
  );
  const cap = useMemo(
    () =>
      typeof maxLength === "number"
        ? {
            max: maxLength,
            overLimit: (excess: number, max: number) =>
              t(
                "codeTools.codeOverLimit",
                "{{count}} character over the limit. Shorten the body: a save above {{max}} is refused.",
                { count: excess, max },
              ),
            refused: (excess: number, max: number) =>
              t(
                "codeTools.codeChangeRefused",
                "Nothing was inserted: the body would be {{count}} character over the {{max}} limit.",
                { count: excess, max },
              ),
          }
        : undefined,
    [maxLength, t],
  );
  return (
    <CodeMirrorField
      value={value}
      onChange={onChange}
      extensions={extensions}
      cap={cap}
      placeholder={placeholder}
      minHeight={minHeight}
      invalid={invalid}
      className={className}
      aria-label={rest["aria-label"]}
    />
  );
}
