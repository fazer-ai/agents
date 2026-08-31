import { describe, expect, test } from "bun:test";
import {
  type Commit,
  checkCommits,
  parseIdent,
  parseLines,
} from "../../scripts/check-commit-identity";

function c(name: string, email: string, login?: string): Commit {
  return { sha: "deadbeef", name, email, login };
}

describe("the two identities this project commits under", () => {
  test("passes its own pairs", () => {
    expect(
      checkCommits([
        c("Gabriel Jablonski", "gabriel@fazer.ai", "gabrieljablonski"),
        c("fazer-ai-bot", "ops@fazer.ai", "fazer-ai-bot"),
      ]),
    ).toEqual([]);
  });

  // Case is what a config was written in; it is not the defect.
  test("does not care about case", () => {
    expect(
      checkCommits([
        c("gabriel jablonski", "GABRIEL@FAZER.AI", "GabrielJablonski"),
      ]),
    ).toEqual([]);
  });
});

// The two measurements, each with one true half beside one invented one. A check that allowed a
// LIST of our addresses rather than pairs would have admitted both.
describe("one true half beside one invented one", () => {
  test("#440: our name, an address belonging to a stranger", () => {
    const problems = checkCommits([
      c("fazer-ai-bot", "bot@users.noreply.github.com"),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("commits as <ops@fazer.ai>");
  });

  test("#285: our name, an address nobody owns", () => {
    expect(
      checkCommits([c("Gabriel Jablonski", "admin@fazer.ai")]),
    ).toHaveLength(1);
  });

  test("our address under a name that is not ours", () => {
    const problems = checkCommits([c("Some Bot", "ops@fazer.ai")]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('commits as "fazer-ai-bot"');
  });

  // A contributor is not one of us and owes this clause nothing.
  test("leaves an outside contributor alone", () => {
    expect(
      checkCommits(
        [c("Rafael Moreira", "rrmlima@gmail.com", "rrmlima")],
        ["rrmlima"],
      ),
    ).toEqual([]);
  });
});

// What remains when someone invents BOTH halves and so satisfies agreement. Only CI can ask it.
describe("who GitHub says wrote it", () => {
  test("refuses a login that is neither ours nor the PR author's", () => {
    const problems = checkCommits([
      c("Some One", "someone@example.com", "bot"),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("@bot");
  });

  test("refuses an unattributed commit by NAME, not by silent extra approval", () => {
    const problems = checkCommits([c("Some One", "nobody@example.com", "")]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("UNATTRIBUTED");
  });

  // A hook has no API, so three fields mean the clause cannot be asked — which is not the same as
  // asking it and getting nothing back.
  test("a hook's three fields do not fail the attribution clause", () => {
    expect(checkCommits([c("Rafael Moreira", "rrmlima@gmail.com")])).toEqual(
      [],
    );
  });

  test("the PR author's own login is allowed", () => {
    expect(
      checkCommits(
        [c("Rafael Moreira", "rrmlima@gmail.com", "rrmlima")],
        ["rrmlima"],
      ),
    ).toEqual([]);
  });
});

describe("what a hook has to work with", () => {
  // `git var GIT_AUTHOR_IDENT`, verbatim: the identity the commit WILL carry, resolved from config,
  // `-c` and the GIT_AUTHOR_* env vars alike.
  test("reads git's own author line", () => {
    expect(
      parseIdent(
        "fazer-ai-bot <bot@users.noreply.github.com> 1788135681 -0300",
      ),
    ).toEqual({
      sha: "-",
      name: "fazer-ai-bot",
      email: "bot@users.noreply.github.com",
    });
  });

  test("a name carrying angle-bracket-shaped text does not steal the address", () => {
    expect(parseIdent("A <b> C <real@fazer.ai> 1 +0000").email).toBe("b");
  });

  test("an identity with no address at all is a name with an empty address", () => {
    expect(parseIdent("nobody 1 +0000")).toEqual({
      sha: "-",
      name: "",
      email: "",
    });
  });
});

describe("the listing has to be complete to mean anything", () => {
  // `pulls/{n}/commits` returns at most 250 even paginated, so at the cap the job would be vouching
  // for commits it never saw.
  test("refuses a PR at the API's listing cap", () => {
    const many = Array.from({ length: 250 }, () =>
      c("Gabriel Jablonski", "gabriel@fazer.ai", "gabrieljablonski"),
    );
    const problems = checkCommits(many, [], 250);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("at most 250");
  });

  test("says nothing about a PR below it", () => {
    expect(
      checkCommits(
        [c("Gabriel Jablonski", "gabriel@fazer.ai", "gabrieljablonski")],
        [],
        250,
      ),
    ).toEqual([]);
  });
});

describe("the wire format", () => {
  test("three fields leave the login absent, four supply it", () => {
    const parsed = parseLines(
      "abc\tGabriel Jablonski\tgabriel@fazer.ai\n" +
        "def\tfazer-ai-bot\tops@fazer.ai\tfazer-ai-bot\n",
    );
    expect(parsed[0]?.login).toBeUndefined();
    expect(parsed[1]?.login).toBe("fazer-ai-bot");
  });

  test("blank lines are not commits", () => {
    expect(parseLines("\n\n")).toEqual([]);
  });

  // `@tsv` writes an unattributed commit as a trailing TAB, and trimming it turns the line into the
  // three-field hook shape — skipping the attribution clause on the very commit it exists for.
  test("an empty fourth field survives, and is not an absent one", () => {
    const parsed = parseLines("abc\tSome One\tnobody@example.com\t\n");
    expect(parsed[0]?.login).toBe("");
    expect(checkCommits(parsed)[0]).toContain("UNATTRIBUTED");
  });

  test("a carriage return is not part of the login", () => {
    expect(parseLines("abc\tA\ta@b.c\trrmlima\r\n")[0]?.login).toBe("rrmlima");
  });
});
