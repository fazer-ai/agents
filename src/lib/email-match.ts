// A Prisma filter that finds ONE email, case-insensitively, and nothing that merely looks like it.
//
// Prisma's `mode: "insensitive"` renders `ILIKE`, so `_` and `%` in the value are wildcards
// (`a_b@x.test` would match `axb@x.test`, another person's account). Escaping the three characters
// `ILIKE` gives meaning to (the backslash, its default escape, first) leaves only the case folding.
export function emailEquals(email: string) {
  return {
    equals: email.trim().replace(/[\\%_]/g, (c) => `\\${c}`),
    mode: "insensitive" as const,
  };
}
