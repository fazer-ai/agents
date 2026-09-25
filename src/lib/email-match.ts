// A Prisma filter that finds ONE email, case-insensitively, and nothing that merely looks like it.
//
// Prisma's `mode: "insensitive"` is not case folding: it renders `ILIKE`, so `_` and `%` in the value
// are wildcards. Measured on issue #756: `equals: "a_b@x.test"` returns the account `axb@x.test`.
// Once the email names the one account a person has across the install, that is somebody else's
// account answering for them (an invitation joining it, a login checking its password). Escaping the
// three characters `ILIKE` gives meaning to (its default escape, the backslash, first) leaves only
// the case folding, which is what every caller meant.
export function emailEquals(email: string) {
  return {
    equals: email.trim().replace(/[\\%_]/g, (c) => `\\${c}`),
    mode: "insensitive" as const,
  };
}
