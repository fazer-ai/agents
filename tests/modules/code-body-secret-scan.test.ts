import { describe, expect, test } from "bun:test";
import { assertNoSecretsInCode } from "@/modules/n8n-export/n8n";

// Round 30. The export scans everything it emits for concrete secrets, and the structured matcher
// it uses reads `password: <anything>` as a leak. That is right for a JSON value and wrong for a
// PROGRAM: `const password = input.password` is how a body forwards a credential it was handed, and
// refusing it makes the agent that owns such a tool unexportable -- the scanner blocking the backup
// it exists to protect. Measured before the fix: four ordinary bodies refused.
//
// In code the pair still has to be CONCRETE, and concrete means a string literal: an expression
// names a value living elsewhere, a quoted run of characters is the value.
function refuses(code: string): boolean {
  try {
    assertNoSecretsInCode(code, "$.test");
    return false;
  } catch {
    return true;
  }
}

describe("a code tool's body is scanned as source, not as a value", () => {
  const allowed = [
    "const password = input.password;\nreturn { ok: true };",
    "return { authorization: input.authorization };",
    "const h = { api_key: input.chave };\nreturn h;",
    "const secret = context.contact_id;\nreturn secret;",
    "return { valid: input.cpf.length === 11 };",
    // A key named in a comment, which is prose inside a program.
    "// pass the api_key through unchanged\nreturn input.k;",
    // A template literal that INTERPOLATES is an expression again, and these two are the shape a
    // body that forwards a credential actually takes (round 31, when the backtick was added as a
    // delimiter: without the `${` guard, both of these started reading as leaks).
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: these strings ARE source, and the
    // interpolation is the point: it is what makes the literal an expression again.
    "const api_key = `${input.chave}`;\nreturn api_key;",
    "return { authorization: `Bearer ${input.token}` };",
    // A static half too short to be a secret, and a static half that is only a separator: the
    // question asked of what is left is the quoted arm's own, so a run that BREAKS is not a value.
    "const secret = `${input.a}-${input.b}`;",
    "return { api_key: `${input.k ?? {a: 1}.a}` };",
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: back to ordinary strings.
  ];
  for (const code of allowed) {
    test(`allows ${JSON.stringify(code.slice(0, 40))}`, () => {
      expect(refuses(code)).toBe(false);
    });
  }

  const refused = [
    // The literal is the value itself, in every quoting style.
    'const password = "hunter2-real-secret";',
    "const password = 'hunter2-real-secret';",
    'const h = { api_key: "abc123def456" };',
    'return { authorization: "Bearer 0123456789abcdef" };',
    // A backtick literal with nothing interpolated is as concrete as a quoted one, and JavaScript
    // writes it as readily. It walked out untouched until round 31.
    "const apiKey = `abcdef123456`;",
    "const password = `hunter2hunter2`;",
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: source again, and the whole point
    // is that an interpolation does not launder the static half around it (round 34).
    "const password = `hunter2secret-${input.id}`;",
    "const api_key = `abcdef123456${x}`;",
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: back to ordinary strings.
    // Shaped secrets are recognisable wherever they appear, quoted or not.
    "return fetchish(sk-0123456789abcdefghij);",
  ];
  for (const code of refused) {
    test(`refuses ${JSON.stringify(code.slice(0, 40))}`, () => {
      expect(refuses(code)).toBe(true);
    });
  }
});
