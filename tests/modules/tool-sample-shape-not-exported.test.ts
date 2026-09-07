import { describe, expect, it } from "bun:test";
import { withoutComments } from "@/tests/utils/source-text";

// THE OMISSION IS THE DECISION, so it is fenced rather than left to a comment (issue #566). The
// export beside it carries `appointment` with a comment explaining that a bundle dropping a field
// silently reintroduced #352 — a reflex that reads as "carry the new field too". For the sample
// shape the answer is the opposite: it describes the CUSTOMER'S API, not the tool's contract, and a
// bundle is how a tool travels to another deployment.
//
// This reads source, so it answers for a GRAPHY. Two things follow, and both were mistakes made
// before in this repo: comments are stripped first (a comment naming the field is what a fence
// counts as a use, which is how an exemption gets granted to the file that documents NOT using it),
// and each direction has a positive control below rather than being assumed.

const TRANSFER = "src/modules/agents/transfer.ts";
const FIELD = "sampleShape";

// The repo's own scanner, not a stripper written here: `withoutComments` keeps string contents,
// because naming the field inside a string is something that deserves to be looked at, and it knows
// that a `//` inside a literal is not a comment.
const stripComments = withoutComments;

async function transferSource(): Promise<string> {
  return await Bun.file(TRANSFER).text();
}

describe("the tool sample shape never travels in an agent bundle", () => {
  it("the export does not read the field", async () => {
    expect(stripComments(await transferSource())).not.toInclude(FIELD);
  });

  it("and the file DOES talk about it, so the fence above is not passing by silence", async () => {
    expect(await transferSource()).toInclude(FIELD);
  });

  it("catches an export that started carrying it", () => {
    const offender = `httpTools: rows.map((r) => ({ name: r.name, ${FIELD}: r.${FIELD} }))`;
    expect(stripComments(offender)).toInclude(FIELD);
  });

  it("does not count a mention that is only a comment", () => {
    const mention = `// ${FIELD} is deliberately not carried\nconst x = 1;`;
    expect(stripComments(mention)).not.toInclude(FIELD);
  });
});
