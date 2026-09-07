/// <reference lib="dom" />

import { beforeEach, describe, expect, it } from "bun:test";
import {
  forgetToolSample,
  noteOperator,
  recallToolSample,
  rememberToolSample,
  sampleTicket,
} from "@/client/lib/toolSample";
import {
  formFromTool,
  payloadOf,
  revisionForSave,
  sendsNothing,
  templatePreviewFor,
} from "@/client/pages/resources/ToolEditModal";
import { codeOnly } from "@/tests/utils/source-text";

// THE SAMPLE COMES BACK FROM THIS TAB, AND FROM NOWHERE ELSE (issue #566). What is asserted here is
// the seam: that the editor opens with what this tab remembers, that the save is what makes it
// remember, and, the one that matters most, that none of it is written down, in the request or in
// any store. That is the invariant the whole design exists to hold without qualification.

type AnyTool = Parameters<typeof formFromTool>[0];

function toolRow(over: Partial<Record<string, unknown>> = {}): AnyTool {
  return {
    id: "42",
    name: "consulta",
    label: "Consulta",
    description: null,
    method: "POST",
    urlTemplate: "https://api.example.com/x",
    allowedHosts: ["api.example.com"],
    headers: {},
    inputSchema: {},
    outputSchema: {},
    query: {},
    body: {},
    credentialRef: null,
    enabled: true,
    expectedStatuses: [],
    ackEnabled: false,
    ackMessage: null,
    updatedAt: REV,
    appointment: null,
    ...over,
  } as unknown as AnyTool;
}

const RESPONSE = '{"cliente":{"nome":"Ana","cpf":"12345678901"}}';
// The revision a sample describes: the row's `updatedAt`, stringified at the boundary because the
// treaty types it as `Date` while the wire carries a string.
const REV = "2026-09-07T12:00:00.000Z";
const NEWER = "2026-09-07T13:00:00.000Z";

// A NEW OPERATOR IS HOW THIS MAP IS EMPTIED, so that is what a fresh test starts with, and using
// the real entry point rather than a reset written for the tests keeps the two from drifting.
let who = 0;
beforeEach(() => {
  noteOperator(`op-${who++}`);
  localStorage.clear();
});

describe("what the editor opens with", () => {
  it("offers nothing when this tab remembers nothing, which is what a reload gets", () => {
    const form = formFromTool(toolRow());
    expect(form.sample).toBe("");
    expect(form.sampleStatus).toBeNull();
  });

  it("takes the response this tab kept, with the status it came back under", () => {
    rememberToolSample(
      "42",
      { revision: REV, text: RESPONSE, status: 404 },
      sampleTicket(),
    );
    const form = formFromTool(toolRow());
    expect(form.sample).toBe(RESPONSE);
    expect(form.sampleStatus).toBe(404);
  });

  // ROUND 9: A SAMPLE DESCRIBES ONE VERSION OF A TOOL. Someone else changing the URL or the response
  // contract, from another tab or over REST or MCP, leaves the id intact and the paths meaningless,
  // and the id is exactly what an id-keyed cache matches on. So the editor asks about the revision
  // it just loaded, and a mismatch gets what a tool this tab never opened gets.
  it("offers nothing when the definition changed since the sample was captured", () => {
    rememberToolSample(
      "42",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    rememberToolSample(
      "43",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    const form = formFromTool(toolRow({ updatedAt: NEWER }));
    expect(form.sample).toBe("");
    expect(form.sampleStatus).toBeNull();
    // A DIFFERENT tool, and one that did not change, still gets its sample: this refuses the
    // revision, not everything. Asking about the same id would prove nothing here, because the
    // mismatch above deletes that entry outright.
    expect(formFromTool(toolRow({ id: "43" })).sample).toBe(RESPONSE);
  });

  // AND THE STALE ENTRY GOES, rather than sitting there holding a response nobody can be served:
  // eight of those would evict the one sample the operator is working with, and it is the customer's
  // data either way.
  it("drops the stale entry instead of only refusing it", () => {
    rememberToolSample(
      "42",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    expect(recallToolSample("42", NEWER)).toBeNull();
    // Asking with the revision it WAS stored under now finds nothing either, which is what proves
    // the entry is gone rather than merely unmatched.
    expect(recallToolSample("42", REV)).toBeNull();
  });

  it("does not let stale entries crowd out a live one", () => {
    rememberToolSample(
      "1",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    // Seven more, all of which the editor then finds stale…
    for (let i = 2; i <= 8; i++)
      rememberToolSample(
        String(i),
        { revision: REV, text: `{"i":${i}}`, status: null },
        sampleTicket(),
      );
    for (let i = 2; i <= 8; i++)
      expect(recallToolSample(String(i), NEWER)).toBeNull();
    // …so the ninth save has room, and tool 1 is still there.
    rememberToolSample(
      "9",
      { revision: REV, text: '{"i":9}', status: null },
      sampleTicket(),
    );
    expect(recallToolSample("1", REV)?.text).toBe(RESPONSE);
  });

  // ROUND 11: pasting a sample is an unsaved change, so Save is how it is kept, and `payloadOf`
  // sends nothing about it. A PATCH for that would rewrite the whole definition from a form loaded
  // before someone else's edit, and advance `updatedAt` for a change the row does not contain.
  it("sends nothing when only the sample changed, and sends when the definition did", () => {
    const opened = formFromTool(toolRow());
    const baseline = JSON.stringify(opened);
    const pasted = { ...opened, sample: RESPONSE, sampleStatus: 200 };
    expect(
      sendsNothing({
        editing: true,
        opened: baseline,
        openedRevision: REV,
        payload: payloadOf(pasted),
      }),
    ).toBe(true);
    // A real edit is sent, or this would silently drop the operator's work.
    expect(
      sendsNothing({
        editing: true,
        opened: baseline,
        openedRevision: REV,
        payload: payloadOf({ ...pasted, label: "Outra" }),
      }),
    ).toBe(false);
    // A create has nothing to compare against and is always sent.
    expect(
      sendsNothing({
        editing: false,
        opened: baseline,
        openedRevision: REV,
        payload: payloadOf(pasted),
      }),
    ).toBe(false);
    // And so is an edit whose baseline or revision never arrived.
    expect(
      sendsNothing({
        editing: true,
        opened: null,
        openedRevision: REV,
        payload: payloadOf(pasted),
      }),
    ).toBe(false);
    expect(
      sendsNothing({
        editing: true,
        opened: baseline,
        openedRevision: null,
        payload: payloadOf(pasted),
      }),
    ).toBe(false);
  });

  it("writes the revision the save returned, and the opened one when it sent nothing", () => {
    // The save moved the revision, so the row that came back is the only one the entry can describe.
    expect(revisionForSave({ updatedAt: NEWER }, REV)).toBe(NEWER);
    // A sample-only save sends nothing, so the row did not move and what the dialog opened with is
    // still the answer.
    expect(revisionForSave(null, REV)).toBe(REV);
    // Neither known is not a revision, and nothing is kept under one.
    expect(revisionForSave(null, null)).toBeNull();
    // The wire types this as `Date` and carries a string, so both arrive as the same key.
    expect(revisionForSave({ updatedAt: new Date(NEWER) }, REV)).toBe(
      String(new Date(NEWER)),
    );
  });

  it("takes the revision from the row the SAVE returned, not the one the form opened with", () => {
    // The save is what moves the revision, so keeping the old one would make the entry describe a
    // definition that stopped existing the moment it was written.
    rememberToolSample(
      "42",
      { revision: NEWER, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    expect(formFromTool(toolRow({ updatedAt: NEWER })).sample).toBe(RESPONSE);
  });

  it("is per tool, so one tool's response is never offered for another", () => {
    rememberToolSample(
      "42",
      { revision: REV, text: RESPONSE, status: null },
      sampleTicket(),
    );
    expect(formFromTool(toolRow({ id: "43" })).sample).toBe("");
  });
});

// THE INVARIANT, IN BOTH DIRECTIONS. Nothing about the sample is sent, and nothing about it is
// written down: a value kept only for the life of the tab is what lets "we never store the
// customer's response" stand with no qualification.
describe("nothing about the sample is sent or stored", () => {
  it("is absent from the body a save sends, response and all", () => {
    const form = {
      ...formFromTool(toolRow()),
      sample: RESPONSE,
      sampleStatus: 200,
    };
    const payload = payloadOf(form);
    const sent = JSON.stringify(payload);
    expect(sent).not.toInclude("Ana");
    expect(sent).not.toInclude("12345678901");
    expect(sent).not.toInclude("sample");
    // …and the fields the save DOES carry are still there, so this is not passing on an empty body.
    expect(payload?.label).toBe("Consulta");
  });

  // THE SECOND REFUSAL, and the reason this module is a Map and not a `localStorage` key: the
  // standing rule in `docs/ui.md` says localStorage is not admissible for product data, and it names
  // this case, "History, save, remember, resume". Asserted over BOTH stores rather than over the one
  // the module happens to use, because a value written to either outlives the session and every
  // deletion that does not go through this browser.
  it("writes nothing into browser storage", () => {
    // A SNAPSHOT ON BOTH SIDES, not "the store is empty": the suite shares one global environment
    // and other files leave entries behind, so asserting emptiness measures them and not this. What
    // this owns is the DIFFERENCE, which is nothing.
    const dump = (store: Storage) =>
      JSON.stringify(
        Array.from({ length: store.length }, (_, i) => {
          const k = store.key(i) ?? "";
          return [k, store.getItem(k) ?? ""];
        }).sort(),
      );
    const before = [dump(localStorage), dump(sessionStorage)];
    rememberToolSample(
      "42",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    forgetToolSample("42", sampleTicket());
    noteOperator("someone-else");
    rememberToolSample(
      "42",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    const after = [dump(localStorage), dump(sessionStorage)];
    expect(after).toEqual(before);
    // And in case a future entry arrives carrying it, said plainly: no store holds the response.
    expect(after.join("")).not.toInclude("Ana");
    expect(after.join("")).not.toInclude("12345678901");
    // The value is there to be recalled, so this is not passing because nothing was remembered.
    expect(recallToolSample("42", REV)?.text).toBe(RESPONSE);
  });

  it("is part of the form, and still changes nothing about what would be written", () => {
    const opened = formFromTool(toolRow());
    const pasted = { ...opened, sample: RESPONSE };
    // Pasting is an unsaved change the discard dialog can see…
    expect(JSON.stringify(pasted)).not.toBe(JSON.stringify(opened));
    // …and the body is identical either way.
    expect(JSON.stringify(payloadOf(pasted))).toBe(
      JSON.stringify(payloadOf(opened)),
    );
  });
});

describe("what the tab remembers", () => {
  it("round-trips a response and its status", () => {
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    expect(recallToolSample("7", REV)).toEqual({
      revision: REV,
      text: RESPONSE,
      status: 200,
    });
  });

  it("drops rather than keeping a previous response when the new one is too large", () => {
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: null },
      sampleTicket(),
    );
    rememberToolSample(
      "7",
      { revision: REV, text: "x".repeat(600_000), status: null },
      sampleTicket(),
    );
    expect(recallToolSample("7", REV)).toBeNull();
  });

  it("drops on nothing at all: no text and no status", () => {
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: null },
      sampleTicket(),
    );
    rememberToolSample("7", null, sampleTicket());
    expect(recallToolSample("7", REV)).toBeNull();
    // Whitespace with no status is the same thing to the operator as nothing, and the module owns
    // that judgement rather than trusting its one caller to keep making it.
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: null },
      sampleTicket(),
    );
    rememberToolSample(
      "7",
      { revision: REV, text: "  \n ", status: null },
      sampleTicket(),
    );
    expect(recallToolSample("7", REV)).toBeNull();
  });

  // ROUND 8: A STATUS WITHOUT A BODY IS THE SAMPLE THAT MATTERS MOST. A test that came back 404
  // with nothing in it is what makes the runtime bypass the template, and a template reading no
  // field previews perfectly well over an empty body. Dropped for having no text, the status went
  // with it, and the reopened tool previewed that same template as APPLIED, under a box that
  // promises exactly what the agent would receive.
  it("keeps a status that came back with an empty body", () => {
    rememberToolSample(
      "7",
      { revision: REV, text: "", status: 404 },
      sampleTicket(),
    );
    expect(recallToolSample("7", REV)).toEqual({
      revision: REV,
      text: "",
      status: 404,
    });
    rememberToolSample(
      "8",
      { revision: REV, text: "   ", status: 204 },
      sampleTicket(),
    );
    expect(recallToolSample("8", REV)?.status).toBe(204);
  });

  it("hands that status back to the editor, so the preview reads the same as before the save", () => {
    rememberToolSample(
      "42",
      { revision: REV, text: "", status: 404 },
      sampleTicket(),
    );
    const form = formFromTool(toolRow());
    expect(form.sample).toBe("");
    expect(form.sampleStatus).toBe(404);
    // The preview branches on it: 404 makes the runtime bypass the template, and `null` reads as
    // 200, which would show the same template as applied.
    const bypassed = templatePreviewFor({
      template: "Nada a relatar.",
      sample: form.sample,
      status: form.sampleStatus,
    });
    const applied = templatePreviewFor({
      template: "Nada a relatar.",
      sample: "",
      status: null,
    });
    expect(bypassed?.skipped).not.toBeNull();
    expect(applied?.skipped).toBeNull();
  });

  // BOUNDED, because this holds response bodies for the life of the tab. The entry that goes is the
  // least recently SAVED, not the first one ever saved: re-saving a tool has to keep it alive, or
  // the tool being worked on is the one evicted while seven abandoned ones stay.
  it("keeps the working set and evicts the least recently saved", () => {
    for (let i = 1; i <= 8; i++)
      rememberToolSample(
        String(i),
        { revision: REV, text: `{"i":${i}}`, status: null },
        sampleTicket(),
      );
    // Tool 1 is the oldest; saving it again makes tool 2 the oldest instead.
    rememberToolSample(
      "1",
      { revision: REV, text: '{"i":1}', status: null },
      sampleTicket(),
    );
    rememberToolSample(
      "9",
      { revision: REV, text: '{"i":9}', status: null },
      sampleTicket(),
    );
    expect(recallToolSample("2", REV)).toBeNull();
    expect(recallToolSample("1", REV)).toEqual({
      revision: REV,
      text: '{"i":1}',
      status: null,
    });
    expect(recallToolSample("9", REV)).toEqual({
      revision: REV,
      text: '{"i":9}',
      status: null,
    });
  });

  // A SUPER_ADMIN switches tenants without reloading, and the tool ids of two tenants are two
  // sequences that overlap. Keyed by the id alone, tool 7 of the tenant just left would be offered
  // as tool 7 of the one just entered.
  // DEPTH, and it says so: `ToolDefinition.id` is a plain autoincrement on one table, so two tenants
  // never share a tool id and this is not what stops one tenant's response reaching another. What it
  // does buy is that a SUPER_ADMIN who switches tenants is not offered entries from the other one.
  it("keeps a tenant's entries under that tenant", () => {
    localStorage.setItem("@app:active-tenant", "3");
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    localStorage.setItem("@app:active-tenant", "4");
    expect(recallToolSample("7", REV)).toBeNull();
    localStorage.setItem("@app:active-tenant", "3");
    expect(recallToolSample("7", REV)).toEqual({
      revision: REV,
      text: RESPONSE,
      status: 200,
    });
  });

  // ROUND 7: the selector is shared across tabs and can move while a request is in flight. The write
  // belongs to the tenant the request went out under, not to whatever is selected when it lands.
  it("writes under the tenant the request went out under, not the one selected on return", () => {
    localStorage.setItem("@app:active-tenant", "3");
    const ticket = sampleTicket();
    localStorage.setItem("@app:active-tenant", "4");
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      ticket,
    );
    // Nothing landed in the tenant that happened to be selected when the response came back…
    expect(recallToolSample("7", REV)).toBeNull();
    // …and the tenant that asked has its answer.
    localStorage.setItem("@app:active-tenant", "3");
    expect(recallToolSample("7", REV)?.text).toBe(RESPONSE);
  });

  it("clears under the tenant the deletion went out under", () => {
    localStorage.setItem("@app:active-tenant", "3");
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    const ticket = sampleTicket();
    localStorage.setItem("@app:active-tenant", "4");
    forgetToolSample("7", ticket);
    localStorage.setItem("@app:active-tenant", "3");
    expect(recallToolSample("7", REV)).toBeNull();
  });

  it("still works in a browser that refuses storage entirely", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(() =>
        rememberToolSample(
          "7",
          { revision: REV, text: RESPONSE, status: null },
          sampleTicket(),
        ),
      ).not.toThrow();
      expect(recallToolSample("7", REV)).toEqual({
        revision: REV,
        text: RESPONSE,
        status: null,
      });
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
    }
  });

  it("is emptied when the session ends, so a signed-out tab holds no customer data", () => {
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    noteOperator(null);
    expect(recallToolSample("7", REV)).toBeNull();
  });

  // A SHARED COOKIE MOVES FROM ONE OPERATOR TO ANOTHER WITH NO NULL IN BETWEEN: another tab signs
  // out and back in as B, and this tab's next `/me` answers B directly. The entries are keyed by
  // tenant and tool, so B opening the same tool would be handed A's captured response.
  it("is emptied when one operator becomes another, with no signed-out state between them", () => {
    noteOperator("A");
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    noteOperator("B");
    expect(recallToolSample("7", REV)).toBeNull();
  });

  it("is left alone when the same operator is reported again", () => {
    noteOperator("A");
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    noteOperator("A");
    expect(recallToolSample("7", REV)?.text).toBe(RESPONSE);
  });

  it("drops one tool's entry when that tool is gone", () => {
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    rememberToolSample(
      "8",
      { revision: REV, text: RESPONSE, status: 200 },
      sampleTicket(),
    );
    forgetToolSample("7", sampleTicket());
    expect(recallToolSample("7", REV)).toBeNull();
    expect(recallToolSample("8", REV)).not.toBeNull();
  });
});

// A SAVE IS IN FLIGHT FOR AS LONG AS THE OPERATOR'S API TAKES, and both things that end a sample's
// life can happen inside that window. The response then arrives and writes it back in, which is a
// deletion and a logout being undone by a request that was already on the wire.
describe("a save that lands after the sample's life ended", () => {
  it("does not put it back after the tool was deleted", () => {
    const ticket = sampleTicket();
    forgetToolSample("7", sampleTicket());
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      ticket,
    );
    expect(recallToolSample("7", REV)).toBeNull();
  });

  it("does not put it back after the session ended", () => {
    const ticket = sampleTicket();
    noteOperator(null);
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      ticket,
    );
    expect(recallToolSample("7", REV)).toBeNull();
  });

  it("does not put it back after one operator became another", () => {
    noteOperator("A");
    const ticket = sampleTicket();
    noteOperator("B");
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      ticket,
    );
    expect(recallToolSample("7", REV)).toBeNull();
  });

  // ROUND 6: a global invalidation over-rejects. Deleting tool B while tool A's save is out would
  // drop A's too, and the operator sees a tool they never touched come back with an older response.
  it("is not invalidated by the deletion of a DIFFERENT tool", () => {
    const ticket = sampleTicket();
    forgetToolSample("8", sampleTicket());
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      ticket,
    );
    expect(recallToolSample("7", REV)?.text).toBe(RESPONSE);
  });

  it("stays rejected for the deleted tool after another one is deleted too", () => {
    const ticket = sampleTicket();
    forgetToolSample("7", sampleTicket());
    forgetToolSample("8", sampleTicket());
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      ticket,
    );
    expect(recallToolSample("7", REV)).toBeNull();
  });

  it("still writes when nothing cleared while it was out", () => {
    const ticket = sampleTicket();
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200 },
      ticket,
    );
    expect(recallToolSample("7", REV)?.text).toBe(RESPONSE);
  });
});

// TWO SOURCE FENCES, and they say so: what they can answer for is a grammar, not intent.
describe("the two seams that have to clear it", () => {
  const DELETE_CALL = /\.v1\.tools\(\s*\{[^}]*\}\s*\)\s*\.delete\(/;
  // THE STATE SETTER, not any particular argument to it. Two review rounds walked past two earlier
  // spellings of this fence: it asked for the logout REQUEST first (a 401 and the socket's auth-loss
  // close end a session without one), then for `setUser(null)`, which `setUser(data.user ?? null)`
  // is not, and that is the branch a `/me` takes when the server has already ended the session. Both
  // times the fence was measuring a SPELLING and the tree had another one. So it counts calls to the
  // raw setter and requires exactly one: the chokepoint that owns what a transition costs.
  const SETS_USER = /setUser\(/g;

  // `codeOnly` rather than a stripper written here: comments AND string contents out, which is the
  // spelling this repo's own fence over sweeps requires (`tests/lib/source-text.test.ts`), and it
  // caught this file for rolling its own. What is being matched is a code SHAPE, so a literal
  // spelling it is prose by another name.
  //
  // The IMPORT goes too, and that is not belt-and-braces: the mutation battery caught this fence
  // green after the call was deleted, because the file still imported the name. A fence that asks
  // "is it mentioned?" answers yes for the import that survives the deletion it exists to catch.
  const strip = (src: string) =>
    codeOnly(src).replace(/^\s*import\s[\s\S]*?from\s+"[^"]*";$/gm, "");
  const CLEARS = /forgetToolSample\s*\(/;
  const NOTES = /noteOperator\s*\(/;

  async function clientFiles(): Promise<string[]> {
    const out: string[] = [];
    for await (const f of new Bun.Glob("src/client/**/*.{ts,tsx}").scan("."))
      out.push(f);
    return out;
  }

  // Deleting the tool takes the tab's copy with it. A response left behind describes a row that is
  // gone, and it is the customer's data sitting in a tab nobody is using it in.
  it("every place that deletes an HTTP tool clears what the tab remembers", async () => {
    const files = await clientFiles();
    // A scan that reaches nothing is a broken matcher, not a clean tree.
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      const src = strip(await Bun.file(f).text());
      if (!DELETE_CALL.test(src)) continue;
      sites++;
      if (!CLEARS.test(src)) offenders.push(f);
    }
    // The site this round wired, so a matcher that stopped matching fails here instead of passing.
    expect(sites).toBe(1);
    expect(offenders).toEqual([]);
  });

  // And losing the session empties the whole map, because a tab left on the login screen would
  // otherwise still hold the responses of the operator who just signed out of it, and the next
  // sign-in on that tab would be offered them.
  it("has exactly one place that can set the user, and it tells this module who that is", async () => {
    const files = await clientFiles();
    const sites: string[] = [];
    let calls = 0;
    for (const f of files) {
      const src = strip(await Bun.file(f).text());
      const found = src.match(SETS_USER)?.length ?? 0;
      if (found === 0) continue;
      calls += found;
      sites.push(f);
      expect(NOTES.test(src)).toBe(true);
    }
    // ONE call, and that is the assertion rather than a count that happens to be right: every second
    // caller of the setter is a transition that has to remember to do this on its own, and both
    // findings this fence exists for were exactly that.
    expect(calls).toBe(1);
    expect(sites).toEqual(["src/client/contexts/AuthContext.tsx"]);
  });

  // The positive control for the fence above, in the shape that got past its two earlier spellings.
  it("counts a setter call whatever is passed to it", () => {
    const spellings = [
      "setUser(null);",
      "setUser(data.user ?? null);",
      "setUser(loggedInUser);",
      "setUser(next);",
    ];
    for (const line of spellings)
      expect(strip(line).match(/setUser\(/g)?.length ?? 0).toBe(1);
    // And the declaration is not a call, or the chokepoint would count as its own second caller.
    expect(
      strip("const [user, setUser] = useState<User | null>(null);").match(
        /setUser\(/g,
      ),
    ).toBeNull();
  });

  // THE TICKET IS ONLY WORTH ANYTHING IF IT IS READ EARLY. Required by the signature, so `tsc`
  // catches a call that omits it; what `tsc` cannot see is a call that reads it AT THE WRITE, which
  // type-checks and always compares equal to itself. That is a question about ORDER, so it is asked
  // of the source, and asked of the SAVE rather than of the file: `.v1.tools` appears in that module
  // long before `save()` (the load, and the test-request dialog), so a whole-file index compares two
  // unrelated positions and answers about neither.
  //
  // This fence was written once, then deleted by a later edit that replaced the block around it, and
  // it was the mutation battery that noticed: two mutations of the call site went from dead to alive
  // between rounds. A missing test looks exactly like a passing one.
  it("reads the ticket before the request rather than at the write", async () => {
    const src = codeOnly(
      await Bun.file("src/client/pages/resources/ToolEditModal.tsx").text(),
    );
    const from = src.indexOf("async function save()");
    expect(from).toBeGreaterThan(-1);
    const save = src.slice(from);

    const read = save.indexOf("sampleTicket()");
    const request = save.indexOf(".v1.tools");
    const write = save.indexOf("rememberToolSample(");
    // All three are found after that anchor, so a rename or a move fails here instead of passing.
    expect(read).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(read).toBeLessThan(request);
    // AND THE FIRST SUSPENSION AFTER THE READ IS THE REQUEST ITSELF, which is what makes the ticket
    // and the request see the same tenant selector. Measured: Eden evaluates its `headers` callback
    // INSIDE the call expression, in the same synchronous block, so another tab's `localStorage`
    // write (visible only at a task boundary) cannot land between the two reads. An `await` added
    // in between would open exactly that window, and would look like an innocent refactor.
    const firstAwait = save.indexOf("await", read);
    expect(firstAwait).toBeGreaterThan(-1);
    // The api call has to be INSIDE that await's operand, which is what makes the suspension happen
    // after the request is dispatched rather than before it. Asked as "no statement boundary in
    // between" rather than "the operand starts with `api.`", because the operand is legitimately a
    // parenthesised ternary here and a grammar that only knew the simpler spelling would fail on a
    // refactor that changed nothing about the ordering.
    const firstApi = save.indexOf("api.", firstAwait);
    expect(firstApi).toBeGreaterThan(firstAwait);
    expect(save.slice(firstAwait, firstApi)).not.toInclude(";");
    // And the write is handed a NAME: `sampleTicket()` inline would read it after everything the
    // request took, which is the same as not having it at all.
    const call = save.slice(
      write,
      save.indexOf(")", save.indexOf("ticket", write)),
    );
    expect(call).not.toInclude("sampleTicket");
    expect(call).toInclude("ticket");
    // AND THE SAMPLE GOES OVER WHOLE. What counts as nothing is the module's rule, and round 8 was
    // this call site holding a second copy of it that said something else: it dropped a 404 with an
    // empty body, status and all. A conditional in this argument is that copy coming back, and the
    // module cannot see it.
    expect(call).not.toInclude("?");
    // What revision gets written is NOT asked here: it is a value now (`revisionForSave`), tested
    // as one below. Two rounds found this call site holding a judgement the module could not see,
    // and the second fence over a spelling is what the next refactor walks past.
  });

  // The same question at the OTHER site that mutates the cache after a request. It was written
  // without one, and round 7 is what found that: a delete whose continuation reads the tenant
  // selector clears the wrong scope when another tab moved it in the meantime.
  it("reads the ticket before the delete request too", async () => {
    const src = codeOnly(
      await Bun.file("src/client/pages/resources/ToolsPanel.tsx").text(),
    );
    const from = src.indexOf("async function confirmDelete()");
    expect(from).toBeGreaterThan(-1);
    const body = src.slice(from);
    const read = body.indexOf("sampleTicket()");
    const request = body.indexOf(".delete(");
    const write = body.indexOf("forgetToolSample(");
    expect(read).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(read).toBeLessThan(request);
    // AND THE FIRST SUSPENSION AFTER THE READ IS THE REQUEST ITSELF, which is what makes the ticket
    // and the request see the same tenant selector. Measured: Eden evaluates its `headers` callback
    // INSIDE the call expression, in the same synchronous block, so another tab's `localStorage`
    // write (visible only at a task boundary) cannot land between the two reads. An `await` added
    // in between would open exactly that window, and would look like an innocent refactor.
    const firstAwait = body.indexOf("await", read);
    expect(firstAwait).toBeGreaterThan(-1);
    // The api call has to be INSIDE that await's operand, which is what makes the suspension happen
    // after the request is dispatched rather than before it. Asked as "no statement boundary in
    // between" rather than "the operand starts with `api.`", because the operand is legitimately a
    // parenthesised ternary here and a grammar that only knew the simpler spelling would fail on a
    // refactor that changed nothing about the ordering.
    const firstApi = body.indexOf("api.", firstAwait);
    expect(firstApi).toBeGreaterThan(firstAwait);
    expect(body.slice(firstAwait, firstApi)).not.toInclude(";");
    const call = body.slice(
      write,
      body.indexOf(")", body.indexOf("ticket", write)),
    );
    expect(call).not.toInclude("sampleTicket");
    expect(call).toInclude("ticket");
  });

  it("catches a delete that forgets, over the three ways it could look like it did not", () => {
    const forgets = `await api.api.v1.tools({ id: t.id }).delete();`;
    expect(DELETE_CALL.test(strip(forgets))).toBe(true);
    expect(CLEARS.test(strip(forgets))).toBe(false);
    // A comment that remembers is not a call.
    expect(
      CLEARS.test(strip(`${forgets}\n// forgetToolSample(t.id) here`)),
    ).toBe(false);
    // Neither is the import that survives deleting the call, the case the battery caught.
    const importOnly = `import { forgetToolSample } from "@/client/lib/toolSample";\n${forgets}`;
    expect(CLEARS.test(strip(importOnly))).toBe(false);
    // And a real call counts.
    expect(CLEARS.test(strip(`${forgets}\nforgetToolSample(t.id);`))).toBe(
      true,
    );
  });
});
