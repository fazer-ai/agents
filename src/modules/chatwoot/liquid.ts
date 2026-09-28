// Text the model wrote, made to reach the customer as written. Chatwoot renders every outgoing
// message, private notes included, as a Liquid template: an unknown `{{variable}}` comes out empty and
// a known one (`{{contact.email}}`) comes out filled with the contact's data. Operator-written text
// (the signature, the templates in settings) keeps that rendering; this is only for the model's.
// Why this shape, and how it was checked against the fork's own renderer: docs/chatwoot.md.

// Each `{{` and `{%` becomes an output tag that prints it back (`{{ '{{' }}`). Chatwoot wraps every
// backtick pair in `{% raw %}`, which a code span can close from inside, so on a text that needs
// escaping every backtick is printed by a tag too (`url_decode` of `%60`), and so is a `{` right
// before one, which would otherwise run into that tag. Text without `{{` or `{%` goes out untouched.
export function literalForChatwoot(text: string): string {
  if (!text.includes("{{") && !text.includes("{%")) return text;
  return text.replace(/\{\{|\{%|\{(?=`)|`/g, (m) =>
    m === "`" ? "{{ '%60' | url_decode }}" : `{{ '${m}' }}`,
  );
}
