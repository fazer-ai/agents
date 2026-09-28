import { describe, expect, test } from "bun:test";
import { literalForChatwoot } from "@/modules/chatwoot/liquid";
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

  // An escaped text keeps no backtick of its own, which is what leaves Chatwoot's code-span pairing
  // nothing to pair.
  test("an escaped text carries no backtick", () => {
    expect(literalForChatwoot("`a` {{b}} `c`")).not.toContain("`");
  });
});
