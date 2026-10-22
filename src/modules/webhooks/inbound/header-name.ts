// A header NAME, by RFC 7230's `token`: the alphabet `Headers.get` accepts. The name is operator
// text, and `request.headers.get` THROWS outside this alphabet: a 500 there would be an oracle that
// the route token is live, where every other refusal answers 401. The write refuses it too
// (integrations/service.ts), but rows already written carry whatever they carry.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isUsableHeaderName(name: string): boolean {
  return HEADER_NAME.test(name);
}
