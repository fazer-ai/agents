import { describe, expect, test } from "bun:test";
import { redactSecretsDeep, sanitizeErrorMessage } from "@/lib/redact";
import { unstorableProblem } from "@/lib/text";

// REPAIRING A VALUE CAN RECONSTRUCT WHAT THE REDACTOR JUST FAILED TO MATCH. A NUL inside a token
// breaks the pattern, and the repair then DELETES it, so scrubbing first would store `sk-<NUL>abc…`
// whole and `pass<NUL>word` as the key `password`. The repair makes the value storable, so it cannot
// be dropped: it runs BEFORE any decision that reads the string. An orphan surrogate half becomes
// U+FFFD, which leaves the key visibly broken rather than passing as `password`.

const NUL = String.fromCharCode(0);

describe("redactSecretsDeep repairs before it decides", () => {
  test("a NUL inside a token does not smuggle the token past the scrubber", () => {
    const out = redactSecretsDeep({
      note: `token sk-${NUL}abcdefghijklmnop`,
    }) as Record<string, string>;
    expect(out.note).not.toContain("sk-abcdefghijklmnop");
    expect(out.note).toContain("‹redacted›");
  });

  test("a NUL inside a credential key does not smuggle the value past the key rule", () => {
    const out = redactSecretsDeep(
      JSON.parse(`{"pass\\u0000word":"hunter2"}`),
    ) as Record<string, unknown>;
    expect(Object.values(out)).not.toContain("hunter2");
    expect(out.password).toBe("‹redacted›");
  });

  test("still scrubs what it always scrubbed", () => {
    const out = redactSecretsDeep({
      token: "sk-abcdefghijklmnop",
      api_key: "whatever",
      note: "Authorization: Bearer abcdefghijklmnop",
      keep: "ordinary text",
    }) as Record<string, string>;
    expect(out.token).not.toContain("sk-abcdefghijklmnop");
    expect(out.api_key).toBe("‹redacted›");
    expect(out.note).toContain("‹redacted›");
    expect(out.keep).toBe("ordinary text");
  });

  test("whatever it returns, the column can hold it", () => {
    const out = redactSecretsDeep({
      [`k${NUL}1`]: `a${NUL}b`,
      nested: [`c\ud800d`, { deep: `e${NUL}\udc00f` }],
    });
    const json = JSON.stringify(out) ?? "";
    expect(unstorableProblem(json, "serialized")).toBeNull();
  });
});

// The same ordering, in the other function that repairs and then decides. This one guards every
// column that holds an error message, and an exception message is exactly where a
// provider's own answer, key included, ends up quoted verbatim.
describe("sanitizeErrorMessage repairs before it decides", () => {
  test("a NUL inside a token does not smuggle the token past the scrubber", () => {
    const out = sanitizeErrorMessage(
      new Error(`upstream rejected token sk-${NUL}abcdefghijklmnop`),
    );
    expect(out).not.toContain("sk-abcdefghijklmnop");
    expect(out).toContain("\u2039redacted\u203a");
  });

  test("whatever it returns, the column can hold it", () => {
    for (const raw of [
      `boom${NUL}tail`,
      "boom\ud800tail",
      "boom\ud800",
      `\ud800${NUL}\udc00`,
    ]) {
      expect(unstorableProblem(sanitizeErrorMessage(raw), "out")).toBeNull();
    }
  });

  test("still bounds what it always bounded", () => {
    const out = sanitizeErrorMessage("x".repeat(600));
    expect(out.length).toBeLessThanOrEqual(500 + "\u2026[truncated]".length);
    expect(out).toContain("[truncated]");
  });
});

// A CUT LANDING INSIDE A CREDENTIAL WOULD PUBLISH IT. Every value pattern has a MINIMUM length and
// no maximum, so cutting first turns a credential into an unrecognised prefix of itself, stored raw
// in a row an operator reads and an export carries. The debug-mode budget and the ordinary
// 2,000-character cap share that boundary, so this is a property of the ORDER, not of the budget.
// Each token below is at its pattern's MINIMUM length, the only place the leak lives: a longer token
// cut short still matches.
describe("the scrub reads past the cut", () => {
  const SECRETS: Array<[string, string]> = [
    ["OpenAI", `sk-${"A".repeat(16)}`],
    ["GitHub", `github_pat_${"B".repeat(16)}`],
    ["Slack", `xoxb-${"1234567890"}`],
    ["AWS", `AKIA${"C".repeat(16)}`],
    ["JWT", `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(6)}`],
    ["Bearer", `Bearer ${"D".repeat(8)}`],
  ];

  // The cut lands one character short of the token's END, which is where a minimum-length pattern
  // stops matching: everything the reader would have wanted hidden is on the near side of the cut.
  test.each(SECRETS)(
    "a %s token cut one character short is redacted, not published",
    (_label, secret) => {
      // The space is load-bearing: every pattern but the JWT anchors on `\b`, and a token
      // glued to a word character never matches, so without it the test would pass either way.
      const head = `${"h".repeat(40)} `;
      const allowed = head.length + secret.length - 1;
      const out = redactSecretsDeep({ v: `${head}${secret}` }, 0, allowed, {
        left: allowed,
      }) as { v: string };
      expect(out.v).not.toContain(secret.slice(0, -1));
      expect(out.v).toContain("‹redacted›");
      expect(out.v.startsWith(head)).toBe(true);
    },
  );

  // The single point above proves the order; this proves the MARGIN, which is the number that says
  // how far past the cut the scan reads. A prefix escapes whenever what is stored plus the margin
  // falls below the pattern's minimum, so the requirement is `margin >= minimum - 1` and the sweep
  // is over every cut point a token has. At a margin of sixteen the JWT shape still leaks a
  // fourteen-character prefix; at zero, every one of these leaks.
  test.each(SECRETS)(
    "no prefix of a %s token survives at ANY cut point",
    (_label, secret) => {
      const head = `${"h".repeat(40)} `;
      for (let k = 8; k < secret.length; k++) {
        const allowed = head.length + k;
        const out = redactSecretsDeep({ v: `${head}${secret}` }, 0, allowed, {
          left: allowed,
        }) as { v: string };
        expect(out.v).not.toContain(secret.slice(0, 8));
      }
    },
  );

  test("the same holds with no budget at all, at the ordinary cap", () => {
    // `MAX_STRING` cuts at 2,000 whether or not a budget is in play, so the order matters on
    // every line that stores a long enough string, not only in debug mode.
    const secret = `sk-${"E".repeat(16)}`;
    const head = `${"h".repeat(2_000 - secret.length)} `;
    const out = redactSecretsDeep({ v: `${head}${secret}` }) as { v: string };
    expect(out.v).not.toContain(secret.slice(0, -1));
    expect(out.v).toContain("‹redacted›");
  });

  test("a token entirely past the margin never reaches the output at all", () => {
    const secret = `sk-${"F".repeat(30)}`;
    const out = redactSecretsDeep({ v: `${"h".repeat(500)}${secret}` }, 0, 20, {
      left: 20,
    }) as { v: string };
    expect(out.v).toBe(`${"h".repeat(20)}…[truncated]`);
  });

  test("a redaction that shrinks the string below the cap still marks it cut", () => {
    // A 203-character credential comes out as the ten-character placeholder, so the RESULT is
    // under the cap while the input was not and everything past the scan window was dropped.
    // Deciding the marker on the result would call that complete.
    const out = redactSecretsDeep({ v: `sk-${"K".repeat(200)}` }, 0, 40, {
      left: 40,
    }) as { v: string };
    expect(out.v).toBe("‹redacted›…[truncated]");
  });

  test("the marker is decided by the INPUT's length, not the scrubbed one", () => {
    // Scrubbing frees room, so the stored string can come out shorter than the cap while content
    // past the margin was still dropped. Deciding the marker on the result would call that complete.
    const out = redactSecretsDeep(
      { v: `sk-${"G".repeat(16)} ${"h".repeat(500)}` },
      0,
      40,
      { left: 40 },
    ) as { v: string };
    expect(out.v.startsWith("‹redacted›")).toBe(true);
    expect(out.v).toContain("…[truncated]");
  });

  test("`sanitizeErrorMessage` gets the same order, and always did", () => {
    // It routes through the shared repair, scrub, cut function, which keeps the two surfaces
    // from drifting apart.
    const secret = `sk-${"H".repeat(16)}`;
    const out = sanitizeErrorMessage(
      new Error(`boom ${secret}`),
      "boom ".length + secret.length - 1,
    );
    expect(out).not.toContain(secret.slice(0, -1));
    expect(out).toContain("‹redacted›");
  });
});

// The order is a property of the CALL SITE: a surface that composes the scrub around a cut by hand
// leaks the same credential, and no type would say so.
describe("no surface composes the order by hand", () => {
  test("nothing pairs the scrub with a cut it did not do first", async () => {
    const dir = new URL("../../src/", import.meta.url).pathname;
    const offenders: string[] = [];
    for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: dir })) {
      const text = await Bun.file(`${dir}${rel}`).text();
      // The exact shape that leaks: the scrub wrapped around a cut.
      if (/redactSecretsInText\(\s*(?:makeStorable\()?\s*truncate\(/.test(text))
        offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // The positive control: the sweep can see the shape it is looking for.
    expect(
      /redactSecretsInText\(\s*(?:makeStorable\()?\s*truncate\(/.test(
        "x = redactSecretsInText(truncate(v, 10))",
      ),
    ).toBe(true);
  });
});

// A REAL JWT IS NOT A PREFIX PLUS A RUN, AND THE MARGIN CANNOT SAVE IT. Every other shape matches
// `<prefix><run of at least N>`, so a long enough piece still matches. A JWT's match REQUIRES two
// separators and a final segment, which a real payload puts hundreds of characters in, so a cut
// takes away structure, not length, and no margin recovers it.
describe("a JWT cut anywhere is still recognised", () => {
  const jwt = `eyJ${"h".repeat(30)}.${"p".repeat(600)}.${"s".repeat(43)}`;

  test("the debug walker redacts one whose structure completes past the scan window", () => {
    const out = redactSecretsDeep({ v: `head ${jwt}` }, 0, 200, {
      left: 200,
    }) as { v: string };
    expect(out.v).toBe("head ‹redacted›…[truncated]");
    expect(out.v).not.toContain("pppppppppp");
  });

  test("the head is only taken when it runs to the END of what was scanned", () => {
    // The anchor is what keeps this from redacting every base64 blob that starts with `eyJ` in the
    // middle of a sentence. Complete, in the middle, and nothing is cut: the ordinary JWT pattern
    // handles it and the words around it survive.
    const out = redactSecretsDeep({ v: `before ${jwt} after` }) as {
      v: string;
    };
    expect(out.v).toBe("before ‹redacted› after");
  });

  test("an error message keeps the diagnosis that follows the token", () => {
    // What the full scan buys, and the reason this surface does not use the window: the `(401)` is
    // past the token, so a scan that stopped at the cut plus a margin would never reach it, and the
    // stored line would be the provider's name and nothing else.
    const out = sanitizeErrorMessage(new Error(`Google refused: ${jwt} (401)`));
    expect(out).toContain("(401)");
    expect(out).not.toContain("pppppppppp");
  });
});

describe("the scan window is bounded, and the bound is visible", () => {
  test("a base64 blob mid-sentence is NOT a cut token, and survives", () => {
    // A JOSE header on its own is public metadata, not a credential, and an unanchored `eyJ…`
    // rule would take every base64 blob in a tool result with it: a log that redacts the diagnosis
    // is a log nobody can read.
    const v = "config eyJhbGciOiJIUzI1NiJ9 loaded";
    expect((redactSecretsDeep({ v }) as { v: string }).v).toBe(v);
  });

  test("redaction cannot pull in text from past the window", () => {
    // The price of the bounded scan, stated rather than discovered: what the scrub never read
    // cannot be stored, even when redacting the token freed the room for it. The walker pays it
    // because its input is a tool result that nothing bounds; `sanitizeErrorMessage` does not,
    // because it already reads its input end to end.
    const head = "A".repeat(50);
    const secret = `sk-${"S".repeat(200)}`;
    const tail = "TAIL-MARKER";
    const out = redactSecretsDeep({ v: `${head} ${secret} ${tail}` }, 0, 100, {
      left: 100,
    }) as { v: string };
    expect(out.v).toBe(`${head} ‹redacted›…[truncated]`);
    expect(out.v).not.toContain(tail);
    // And the same input scanned whole keeps it, which is what `sanitizeErrorMessage` gets.
    expect(
      sanitizeErrorMessage(new Error(`${head} ${secret} ${tail}`), 100),
    ).toContain(tail);
  });
});

// THE REPAIR HAPPENS INSIDE THE WINDOW, AND ONE HALF OF IT DELETES. A window of `max + margin` raw
// characters would come back short by however many NULs it held, spending the margin past the cut
// on characters that no longer exist; 64 NULs, which any webhook can send, would spend all of it
// (the window's count is in src/lib/redact.ts).
describe("a deleted character does not come out of the margin", () => {
  const NUL = String.fromCharCode(0);
  const token = `sk-${"A".repeat(16)}`;

  test("NULs filling the whole margin do not push a credential past the scan", () => {
    const v = `${NUL.repeat(64)}${"h".repeat(1_981)} ${token}`;
    const out = redactSecretsDeep({ v }) as { v: string };
    expect(out.v).not.toContain("sk-A");
    expect(out.v).toContain("‹redacted›");
  });

  test("more NULs than the margin, under a budget, is the same answer", () => {
    const v = `${NUL.repeat(500)}${"h".repeat(81)} ${token}`;
    const out = redactSecretsDeep({ v }, 0, 100, { left: 100 }) as {
      v: string;
    };
    expect(out.v).not.toContain("sk-A");
    expect(out.v).toContain("‹redacted›");
  });

  test("a NUL is not content, so deleting one does not mark the row cut", () => {
    // The marker answers "was something lost". A NUL never stood for anything a reader sees, and
    // measuring the cut on the raw length would put `…[truncated]` on a row that is whole.
    const v = `${"h".repeat(2_000)}${NUL.repeat(5)}`;
    const out = redactSecretsDeep({ v }) as { v: string };
    expect(out.v).toBe("h".repeat(2_000));
  });

  test("one character past the cap still marks it, NULs or not", () => {
    const v = `${NUL.repeat(5)}${"h".repeat(2_001)}`;
    const out = redactSecretsDeep({ v }) as { v: string };
    expect(out.v).toBe(`${"h".repeat(2_000)}…[truncated]`);
  });

  test("a lone surrogate is replaced, not deleted, so it costs the margin nothing", () => {
    // The window counts only NULs as deleted, so this pins that one orphan half becomes one
    // U+FFFD; if it ever deleted, the margin would be short and nothing else would say so. Same
    // geometry as the NUL case: the token is only redacted if the window reached past the cut.
    const v = `${"\ud800".repeat(64)}${"h".repeat(1_917)} ${token}`;
    const out = redactSecretsDeep({ v }) as { v: string };
    expect(out.v).not.toContain("sk-A");
    expect(out.v).toContain("‹redacted›");
  });
});
