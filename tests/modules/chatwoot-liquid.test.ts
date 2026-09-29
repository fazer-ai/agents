import { describe, expect, test } from "bun:test";
import {
  asRendered,
  composeForChatwoot,
  literalForChatwoot,
  markValue,
  replaceInOperatorText,
} from "@/modules/chatwoot/liquid";
import { attachSignature } from "@/modules/signature/service";

// THE ESCAPE ITSELF. What makes it right is how Chatwoot's Liquid 5.4 renders it, and
// no Ruby runs here, so the outputs are pinned: each was rendered through the fork's own transform
// (`Liquidable#modified_liquid_content` + `Liquid::Template.parse(...).render`, with the rescue that
// keeps a template that fails to parse) and came back equal to the input. Changing a pinned string
// means rendering it there again.
describe("literalForChatwoot", () => {
  test.each([
    // The two acceptance lines of the issue: a known variable (filled) and unknown ones (emptied).
    [
      "Seu cadastro: {{contact.email}} fim",
      "Seu cadastro: {{ '{{' }}contact.email}} fim",
    ],
    [
      "Confira {{contact.x}} e {{numero_caso}} e {{foo}}",
      "Confira {{ '{{' }}contact.x}} e {{ '{{' }}numero_caso}} e {{ '{{' }}foo}}",
    ],
    // A tag, which Liquid would execute.
    ["x {% if a %}y{% endif %}", "x {{ '{%' }} if a %}y{{ '{%' }} endif %}"],
    // A code span that closes Chatwoot's own `{% raw %}` wrapper early: left with its backticks it
    // renders the email between them. Every backtick is printed by a tag instead.
    [
      "`{% endraw %}{{contact.email}}{% raw %}`",
      "{{ '%60' | url_decode }}{{ '{%' }} endraw %}{{ '{{' }}contact.email}}{{ '{%' }} raw %}{{ '%60' | url_decode }}",
    ],
    // A `}` right after an escaped `{{`: a `{% raw %}` block there would end in `{% endraw %}}`, which
    // Liquid reads as one malformed token, and Chatwoot would store the markup verbatim.
    ["-{raw{ '{{}-", "-{raw{ '{{ '{{' }}}-"],
    // A lone `{` right before a backtick would run into the tag that prints the backtick.
    ["a{`b {{", "a{{ '{' }}{{ '%60' | url_decode }}b {{ '{{' }}"],
  ])("%p", (input, wire) => {
    expect(literalForChatwoot(input)).toBe(wire);
  });

  // Nothing to escape, nothing added: a text with no `{{` and no `{%` has no tag for Liquid to read,
  // backticks and braces included, and every ordinary reply goes out byte for byte.
  test.each([
    "no delimiters `code` here",
    "preço {x} e } e { e {a}b} e 100% e <b>n</b> e & e ção 😀",
    "",
  ])("untouched: %p", (input) => {
    expect(literalForChatwoot(input)).toBe(input);
  });

  // With `all`, a balloon the model already signed is left unsigned, and its text is still escaped.
  test("a balloon attachSignature leaves as it is still goes through the body", () => {
    expect(
      attachSignature(
        ["Oi {{a}}\n\nAlex", "Tchau {{b}}"],
        "Alex",
        { position: "bottom", separator: "blank", frequency: "all" },
        undefined,
        literalForChatwoot,
      ),
    ).toEqual(["Oi {{ '{{' }}a}}\n\nAlex", "Tchau {{ '{{' }}b}}\n\nAlex"]);
  });

  // Measuring an escaped text (a typing delay) reads what the customer will see.
  test("asRendered gives back the text the escape was made from", () => {
    for (const t of [
      "Use `{{foo}}`.",
      "a{`b {{",
      "x {% if a %}y{% endif %}",
      "`{% endraw %}{{contact.email}}{% raw %}`",
    ]) {
      expect(asRendered(literalForChatwoot(t))).toBe(t);
    }
  });

  // An escaped text keeps no backtick of its own, which is what leaves Chatwoot's code-span pairing
  // nothing to pair.
  test("an escaped text carries no backtick", () => {
    expect(literalForChatwoot("`a` {{b}} `c`")).not.toContain("`");
  });
});

// Operator text with values fenced in it. Pinned the same way as above, rendered through the fork's
// transform against the operator's template with each value put back raw afterwards.
describe("composeForChatwoot", () => {
  test.each([
    // The operator's Liquid renders; the value's does not.
    [
      `Olá {{contact.phone_number}}, ${markValue("{{contact.email}}")}`,
      "Olá {{contact.phone_number}}, {{ '{{' }}contact.email}}",
    ],
    // A code span of the operator's around a value: left as backticks, Chatwoot's raw block would
    // show the value's tags. Printed by tags, and the value's `{{` by its own.
    [
      `Motivo: \`${markValue("a {{foo}}")}\``,
      "Motivo: {{ '%60' | url_decode }}a {{ '{{' }}foo}}{{ '%60' | url_decode }}",
    ],
    // What the operator wrote inside their own code span stays literal, as Chatwoot keeps it.
    [
      `\`{{contact.email}}\` e ${markValue("{%x")}`,
      "{{ '%60' | url_decode }}{{ '{{' }}contact.email}}{{ '%60' | url_decode }} e {{ '{%' }}x",
    ],
    // A value's trailing `{` does not take the operator's `{{` with it.
    [
      `${markValue("x{")}{{contact.phone_number}}`,
      "x{{ '{' }}{{contact.phone_number}}",
    ],
    // A `{` right before a backtick's tag would run into it: printed by a tag of its own.
    [
      `Nota: ${markValue("a{`b`")}`,
      "Nota: a{{ '{' }}{{ '%60' | url_decode }}b{{ '%60' | url_decode }}",
    ],
    // An operator's own raw block around a value would print its tags: replayed like a code span.
    [
      `Dica: {% raw %}${markValue("Use {{foo}}")}{% endraw %} e {{contact.email}}`,
      "Dica: Use {{ '{{' }}foo}} e {{contact.email}}",
    ],
    // Nothing in the value to escape: the operator's text goes out as written, code span included.
    [`\`{{contact.email}}\` ${markValue("Ana")}`, "`{{contact.email}}` Ana"],
  ])("%p", (fenced, wire) => {
    expect(composeForChatwoot(fenced)).toBe(wire);
  });
});

describe("replaceInOperatorText", () => {
  // A placeholder a customer wrote into their own name is theirs: it is not filled.
  test("fills the operator's text and leaves a fenced value alone", () => {
    const fenced = `Olá ${markValue("Ana {{mensagem}}")}: {{mensagem}}`;
    expect(
      replaceInOperatorText(fenced, /\{\{mensagem\}\}/g, () => markValue("Ok")),
    ).toBe(`Olá ${markValue("Ana {{mensagem}}")}: ${markValue("Ok")}`);
  });
});
