// WHO A COMMIT SAYS IT IS, checked before the commit exists and again before anyone can merge it.
//
// Measured twice, one issue apart, and the second time is why this file exists rather than a
// paragraph in a skill.
//
//   #285 — committed as `admin@fazer.ai`, the address the harness hands an agent to IDENTIFY the
//   user, which is not a commit address. No GitHub account owns it, so the commits came back
//   `author = NOT ATTRIBUTED` and `require_extra_approval_for_unattributed_changes` held the merge.
//   Loud, and self-limiting.
//
//   #440 — committed as `bot@users.noreply.github.com`, invented because it LOOKS canonical. That
//   address belongs to a real account, `github.com/bot`, a stranger to this project. Six commits on
//   a public PR by an external contributor were credited to them, with a face and a profile link on
//   the timeline. Nothing objected: the ruleset gate closes over UNattributed commits, and a commit
//   attributed to the wrong person sails through it applauding.
//
// The two failures share a cause and only one of them announces itself, which is the whole argument
// for a check. The rule is stronger than "do not use the harness's address": **never TYPE a commit
// email.** It is read — `git config user.email`, or the last commit on the branch — never authored.
//
// AND THE HOOK IS NOT THE NET, measured while writing this. `core.hooksPath` points at `.husky/_`,
// which husky's `prepare` writes and nobody commits, so it exists only where an install ran — not in
// a worktree whose `node_modules` is a symlink, which is every worktree this project's own procedure
// creates. A probe commit carrying the exact #440 identity was accepted there with the hook in
// place and the check never invoked. So `commit-identity.yml` is the layer that decides; the hooks
// are the fast half, and they are best-effort by construction.
//
// Two clauses, because either alone leaves the other's hole open:
//
//   AGREEMENT — a name of ours obliges its email, and an email of ours obliges its name. This is the
//   clause that catches both measurements: `fazer-ai-bot <bot@users.noreply.github.com>` and
//   `Gabriel Jablonski <admin@fazer.ai>` each pair one true half with one invented one.
//
//   ATTRIBUTION — every commit must resolve to a GitHub login we expect. Only CI can ask this (it
//   needs the API), and it is what remains if someone invents BOTH halves and so passes AGREEMENT.
//   An unattributed commit fails here too, which makes this check the reason rather than the
//   ruleset's silent extra approval.

export interface Identity {
  readonly name: string;
  readonly email: string;
  readonly login: string;
}

// The identities this project commits under. A pair, never a loose list: the whole defect is one
// true half beside one invented one, and a list of allowed emails would have admitted every commit
// in both measurements above.
export const OURS: readonly Identity[] = [
  {
    name: "Gabriel Jablonski",
    email: "gabriel@fazer.ai",
    login: "gabrieljablonski",
  },
  { name: "fazer-ai-bot", email: "ops@fazer.ai", login: "fazer-ai-bot" },
];

export interface Commit {
  readonly sha: string;
  readonly name: string;
  readonly email: string;
  // Absent where nothing can resolve it (a hook has no API). An empty string is different: it is
  // CI reporting that GitHub matched the address to no account at all.
  readonly login?: string;
}

// Case-insensitively, because git preserves the case a config was written in and GitHub does not
// care; a mismatch of case is not the defect this file is about.
function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function describeCommit(c: Commit): string {
  const at = c.sha && c.sha !== "-" ? `${c.sha.slice(0, 8)} ` : "";
  return `${at}${c.name} <${c.email}>`;
}

// `allowedLogins` carries the ONE login this check cannot know on its own: the author of the pull
// request, whose own commits are theirs to sign. It is the caller's job to pass it, and passing
// none is the right default everywhere except a PR.
// `cap` is the size at which the LISTING itself stops being trustworthy: `pulls/{n}/commits` returns
// at most 250 even paginated, so a longer PR would have commits nobody looked at while this job went
// green. There is no partial answer to give — refuse, and say which commits were never seen.
export function checkCommits(
  commits: readonly Commit[],
  allowedLogins: readonly string[] = [],
  cap?: number,
): string[] {
  const problems: string[] = [];
  const allowed = [...OURS.map((o) => o.login), ...allowedLogins];

  if (cap !== undefined && commits.length >= cap) {
    problems.push(
      `this pull request has ${commits.length} commits, and the API lists at most ${cap}.\n` +
        "    Some commits were never checked, so this job cannot vouch for the branch. Split it.",
    );
  }

  for (const c of commits) {
    const byName = OURS.find((o) => same(o.name, c.name));
    const byEmail = OURS.find((o) => same(o.email, c.email));

    if (byName && !same(byName.email, c.email)) {
      problems.push(
        `${describeCommit(c)}\n` +
          `    the name "${byName.name}" commits as <${byName.email}>, and this is not that address.\n` +
          `    Read the address, never type one: git config user.email`,
      );
    } else if (byEmail && !same(byEmail.name, c.name)) {
      problems.push(
        `${describeCommit(c)}\n` +
          `    <${byEmail.email}> commits as "${byEmail.name}", and this is not that name.`,
      );
    }

    if (c.login === undefined) continue;
    if (c.login === "") {
      problems.push(
        `${describeCommit(c)}\n` +
          `    GitHub matched this address to no account, so the commit is UNATTRIBUTED.`,
      );
    } else if (!allowed.some((l) => same(l, c.login as string))) {
      problems.push(
        `${describeCommit(c)}\n` +
          `    GitHub credits this commit to @${c.login}, who is not one of us and did not open this PR.`,
      );
    }
  }
  return problems;
}

// `git var GIT_AUTHOR_IDENT` answers `Name <email> <unix ts> <tz>`, which is what a pre-commit hook
// has: the identity the commit WILL carry, resolved from config, `-c` and the GIT_AUTHOR_* env vars
// alike. Parsed here rather than in the hook, because a `sed` in a shell script is the one part of
// this that no test would ever cover.
export function parseIdent(ident: string): Commit {
  const m = /^(.*?)\s*<([^>]*)>/.exec(ident.trim());
  return { sha: "-", name: m?.[1] ?? "", email: m?.[2] ?? "" };
}

// stdin, one commit per line, tab-separated: `sha \t name \t email [\t login]`. A fourth field turns
// the ATTRIBUTION clause on; three fields is a hook, which cannot ask.
export function parseLines(input: string): Commit[] {
  return (
    input
      .split("\n")
      // Only the carriage return, never `trimEnd`. An UNATTRIBUTED commit is `sha\tname\temail\t` with
      // an empty fourth field, and trimming that trailing tab turns it into the three-field hook shape
      // — silently skipping the attribution clause on exactly the commit it exists for.
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const [sha = "-", name = "", email = "", ...rest] = l.split("\t");
        const login = rest.length > 0 ? (rest[0] as string) : undefined;
        return { sha, name, email, login };
      })
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const allowedLogins = args
    .flatMap((a) =>
      a.startsWith("--also=") ? [a.slice("--also=".length)] : [],
    )
    .filter(Boolean);
  const ident = args.find((a) => a.startsWith("--ident="));
  const capArg = args.find((a) => a.startsWith("--cap="));
  const commits = ident
    ? [parseIdent(ident.slice("--ident=".length))]
    : parseLines(await Bun.stdin.text());
  const problems = checkCommits(
    commits,
    allowedLogins,
    capArg ? Number(capArg.slice("--cap=".length)) : undefined,
  );
  if (problems.length > 0) {
    console.error(
      "commit identity: refusing an identity this project does not commit under\n",
    );
    for (const p of problems) console.error(`  ${p}\n`);
    process.exit(1);
  }
}
