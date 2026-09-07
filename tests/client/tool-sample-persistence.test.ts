/// <reference lib="dom" />

import { beforeEach, describe, expect, it } from "bun:test";
import {
  forgetToolSample,
  noteOperator,
  noteVaultChanged,
  recallToolSample,
  rememberToolSample,
  sampleIsNothing,
  sampleTicket,
} from "@/client/lib/toolSample";
import { VAULT_CHANGED_EVENT } from "@/client/lib/vaultCache";
import {
  captureShapeOf,
  formFromTool,
  payloadOf,
  requestShapeOf,
  revisionForSave,
  sampleDescribes,
  sampleToRemember,
  sendsNothing,
  shapeOfArrival,
  shapeOfOpening,
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
      { revision: REV, text: RESPONSE, status: 404, credentialRef: null },
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    rememberToolSample(
      "43",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    // Seven more, all of which the editor then finds stale…
    for (let i = 2; i <= 8; i++)
      rememberToolSample(
        String(i),
        {
          revision: REV,
          text: `{"i":${i}}`,
          status: null,
          credentialRef: null,
        },
        sampleTicket(),
      );
    for (let i = 2; i <= 8; i++)
      expect(recallToolSample(String(i), NEWER)).toBeNull();
    // …so the ninth save has room, and tool 1 is still there.
    rememberToolSample(
      "9",
      { revision: REV, text: '{"i":9}', status: null, credentialRef: null },
      sampleTicket(),
    );
    expect(recallToolSample("1", REV)?.text).toBe(RESPONSE);
  });

  // ROUND 11: pasting a sample is an unsaved change, so Save is how it is kept, and `payloadOf`
  // sends nothing about it. A PATCH for that would rewrite the whole definition from a form loaded
  // before someone else's edit, and advance `updatedAt` for a change the row does not contain.
  // ROUND 12: a sample captured by a test request, then an edit to the URL before the save. Saved,
  // it would pass the revision check, because this very save is what set that revision.
  it("tells a definition that changes the response from one that does not", () => {
    const base = payloadOf(formFromTool(toolRow()));
    const same = (over: Record<string, unknown>) =>
      requestShapeOf({ ...(base as object), ...over }) === requestShapeOf(base);
    // These cannot change the bytes the API sends back.
    expect(same({ label: "Outro nome" })).toBe(true);
    expect(same({ name: "outro_nome" })).toBe(true);
    expect(same({ outputSchema: { mode: "template", template: "Oi" } })).toBe(
      true,
    );
    expect(same({ ackEnabled: true })).toBe(true);
    expect(same({ expectedStatuses: [404] })).toBe(true);
    // And these do.
    expect(same({ urlTemplate: "https://api.example.com/outro" })).toBe(false);
    expect(same({ method: "GET" })).toBe(false);
    expect(same({ headers: { "X-A": "1" } })).toBe(false);
    expect(same({ query: { a: "1" } })).toBe(false);
    expect(same({ body: { mode: "raw", raw: "{}" } })).toBe(false);
    expect(same({ credentialRef: "vault:1" })).toBe(false);
    // A field nobody has classified counts as response-affecting: the sample is dropped too
    // eagerly rather than kept when it is stale.
    expect(same({ somethingNew: 1 })).toBe(false);
    // Key order is not a change.
    expect(requestShapeOf({ b: 1, a: 2 })).toBe(requestShapeOf({ a: 2, b: 1 }));
  });

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
    expect(revisionForSave({ updatedAt: NEWER }, REV, true)).toBe(NEWER);
    // A sample-only save sends nothing, so the row did not move and what the dialog opened with is
    // still the answer.
    expect(revisionForSave(null, REV, true)).toBe(REV);
    // Neither known is not a revision, and nothing is kept under one.
    expect(revisionForSave(null, null, true)).toBeNull();
    // And a sample that describes another definition is not kept under any revision.
    expect(revisionForSave({ updatedAt: NEWER }, REV, false)).toBeNull();
    expect(revisionForSave(null, REV, false)).toBeNull();
    // The wire types this as `Date` and carries a string, so both arrive as the same key.
    expect(revisionForSave({ updatedAt: new Date(NEWER) }, REV, true)).toBe(
      String(new Date(NEWER)),
    );
  });

  it("takes the revision from the row the SAVE returned, not the one the form opened with", () => {
    // The save is what moves the revision, so keeping the old one would make the entry describe a
    // definition that stopped existing the moment it was written.
    rememberToolSample(
      "42",
      { revision: NEWER, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    expect(formFromTool(toolRow({ updatedAt: NEWER })).sample).toBe(RESPONSE);
  });

  it("is per tool, so one tool's response is never offered for another", () => {
    rememberToolSample(
      "42",
      { revision: REV, text: RESPONSE, status: null, credentialRef: null },
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    forgetToolSample("42", sampleTicket());
    noteOperator("someone-else");
    rememberToolSample(
      "42",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    expect(recallToolSample("7", REV)).toEqual({
      revision: REV,
      text: RESPONSE,
      status: 200,
      credentialRef: null,
    });
  });

  it("drops rather than keeping a previous response when the new one is too large", () => {
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: null, credentialRef: null },
      sampleTicket(),
    );
    rememberToolSample(
      "7",
      {
        revision: REV,
        text: "x".repeat(600_000),
        status: null,
        credentialRef: null,
      },
      sampleTicket(),
    );
    expect(recallToolSample("7", REV)).toBeNull();
  });

  it("drops on nothing at all: no text and no status", () => {
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: null, credentialRef: null },
      sampleTicket(),
    );
    rememberToolSample("7", null, sampleTicket());
    expect(recallToolSample("7", REV)).toBeNull();
    // Whitespace with no status is the same thing to the operator as nothing, and the module owns
    // that judgement rather than trusting its one caller to keep making it.
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: null, credentialRef: null },
      sampleTicket(),
    );
    rememberToolSample(
      "7",
      { revision: REV, text: "  \n ", status: null, credentialRef: null },
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
      { revision: REV, text: "", status: 404, credentialRef: null },
      sampleTicket(),
    );
    expect(recallToolSample("7", REV)).toEqual({
      revision: REV,
      text: "",
      status: 404,
      credentialRef: null,
    });
    rememberToolSample(
      "8",
      { revision: REV, text: "   ", status: 204, credentialRef: null },
      sampleTicket(),
    );
    expect(recallToolSample("8", REV)?.status).toBe(204);
  });

  it("hands that status back to the editor, so the preview reads the same as before the save", () => {
    rememberToolSample(
      "42",
      { revision: REV, text: "", status: 404, credentialRef: null },
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
        {
          revision: REV,
          text: `{"i":${i}}`,
          status: null,
          credentialRef: null,
        },
        sampleTicket(),
      );
    // Tool 1 is the oldest; saving it again makes tool 2 the oldest instead.
    rememberToolSample(
      "1",
      { revision: REV, text: '{"i":1}', status: null, credentialRef: null },
      sampleTicket(),
    );
    rememberToolSample(
      "9",
      { revision: REV, text: '{"i":9}', status: null, credentialRef: null },
      sampleTicket(),
    );
    expect(recallToolSample("2", REV)).toBeNull();
    expect(recallToolSample("1", REV)).toEqual({
      revision: REV,
      text: '{"i":1}',
      status: null,
      credentialRef: null,
    });
    expect(recallToolSample("9", REV)).toEqual({
      revision: REV,
      text: '{"i":9}',
      status: null,
      credentialRef: null,
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    localStorage.setItem("@app:active-tenant", "4");
    expect(recallToolSample("7", REV)).toBeNull();
    localStorage.setItem("@app:active-tenant", "3");
    expect(recallToolSample("7", REV)).toEqual({
      revision: REV,
      text: RESPONSE,
      status: 200,
      credentialRef: null,
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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
          { revision: REV, text: RESPONSE, status: null, credentialRef: null },
          sampleTicket(),
        ),
      ).not.toThrow();
      expect(recallToolSample("7", REV)).toEqual({
        revision: REV,
        text: RESPONSE,
        status: null,
        credentialRef: null,
      });
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
    }
  });

  it("is emptied when the session ends, so a signed-out tab holds no customer data", () => {
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    noteOperator("B");
    expect(recallToolSample("7", REV)).toBeNull();
  });

  it("is left alone when the same operator is reported again", () => {
    noteOperator("A");
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    noteOperator("A");
    expect(recallToolSample("7", REV)?.text).toBe(RESPONSE);
  });

  it("drops one tool's entry when that tool is gone", () => {
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    rememberToolSample(
      "8",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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
// ROUND 13, AND THE THREE FINDINGS WERE ONE SHAPE: the marker that says which definition the sample
// describes was maintained by hand at four sites, and two of them recorded the wrong thing. So it is
// one function with one rule, and this is its table — the arrivals a sample can make, and what each
// one does to the marker.
describe("which definition the sample describes", () => {
  const FORM = formFromTool(toolRow());
  const SHAPE = captureShapeOf(payloadOf(FORM));

  const arrivals: {
    what: string;
    text: string;
    status: number | null;
    against: typeof FORM | null;
    previous: string | null;
    shape: string | null;
  }[] = [
    // Typed, pasted, or answered by "Send a test request": a new response, captured against the
    // form it is going into.
    {
      what: "a sample captured against the form on screen",
      text: RESPONSE,
      status: 200,
      against: FORM,
      previous: null,
      shape: SHAPE,
    },
    // An empty body with a status IS a sample (round 8), so it describes a definition like any
    // other. Recorded as nothing, a 404 captured against one URL survived an edit to that URL and
    // came back previewing the template as applied against the new one.
    {
      what: "a status with no body, which is still a sample",
      text: "",
      status: 404,
      against: FORM,
      previous: null,
      shape: SHAPE,
    },
    // Format re-indents; it never changes a value. Recomputing here stamped a response captured
    // against request A with the shape of request B, so pressing a pretty-printer erased the
    // mismatch the save exists to refuse.
    {
      what: "the same sample re-indented, which captures nothing",
      text: `${RESPONSE}\n`,
      status: 200,
      against: null,
      previous: "SHAPE-A",
      shape: "SHAPE-A",
    },
    {
      what: "the field emptied, which is no sample at all",
      text: "   \n ",
      status: null,
      against: FORM,
      previous: "SHAPE-A",
      shape: null,
    },
    // Emptying the field forgets the definition too, even on an arrival that captures nothing:
    // there is no sample left to describe one.
    {
      what: "the field emptied by a reformat",
      text: "",
      status: null,
      against: null,
      previous: "SHAPE-A",
      shape: null,
    },
  ];

  for (const row of arrivals)
    it(`records ${row.what}`, () => {
      expect(
        shapeOfArrival({
          text: row.text,
          status: row.status,
          against: row.against,
          previous: row.previous,
        }),
      ).toBe(row.shape as string);
    });

  // WHAT AN OPEN RECORDS, which is the finding that mattered most of the three: a sample this tab
  // kept came back with NO definition recorded, so the refusal round 12 built lasted exactly as long
  // as the modal stayed open. Reopen the tool, change the URL, save, and the old response was
  // stamped with the new revision — the original defect, surviving a reopen.
  it("an opening that restored a sample knows which definition it describes", () => {
    rememberToolSample(
      "42",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    const opened = formFromTool(toolRow());
    expect(opened.sample).toBe(RESPONSE);
    const shape = shapeOfOpening(opened);

    // Saved as it opened, the sample still describes the tool.
    expect(sampleDescribes(shape, payloadOf(opened))).toBe(true);
    // The URL edited after the reopen, and it does not. This is the assertion the whole round is
    // about: with the opening recording nothing, it answered `true`.
    expect(
      sampleDescribes(
        shape,
        payloadOf({
          ...opened,
          urlTemplate: "https://elsewhere.example.com/y",
        }),
      ),
    ).toBe(false);
  });

  // CLEARING THE FIELD AND SAVING IS HOW AN OPERATOR THROWS A SAMPLE AWAY, and it has to reach the
  // module, which is the only thing that can forget it. Without the "nothing was captured" branch
  // the save decides there is no revision to write under, never calls the module at all, and the
  // response the operator just deleted comes back on the next open.
  it("a save that cleared the field forgets what the tab kept", () => {
    rememberToolSample(
      "42",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    const opened = formFromTool(toolRow());
    const cleared = { ...opened, sample: "", sampleStatus: null };
    const shape = shapeOfArrival({
      text: cleared.sample,
      status: cleared.sampleStatus,
      against: cleared,
      previous: shapeOfOpening(opened),
    });
    expect(shape).toBeNull();

    const revision = revisionForSave(
      { updatedAt: NEWER },
      REV,
      sampleDescribes(shape, payloadOf(cleared)),
    );
    expect(revision).not.toBeNull();
    const keep = sampleToRemember({
      revision,
      text: cleared.sample,
      status: cleared.sampleStatus,
      // `payloadOf` answers null for headers that do not parse, which is a client-side check with
      // no bearing here: what this needs from it is the reference the request carried.
      payload: { credentialRef: payloadOf(cleared)?.credentialRef ?? null },
    });
    expect(keep).not.toBeNull();
    rememberToolSample("42", keep, sampleTicket());
    // Gone under the new revision AND under the old one, which is what proves it was forgotten
    // rather than merely unmatched.
    expect(recallToolSample("42", NEWER)).toBeNull();
    expect(recallToolSample("42", REV)).toBeNull();
  });

  // WHAT THE SAVE HANDS OVER, as a value: the credential comes from the payload the request carried
  // and not from the form, which spells "none" as an empty string, and a revision of null is the
  // save saying there is nothing to keep.
  it("assembles what the save remembers from the payload it sent", () => {
    const withCred = sampleToRemember({
      revision: REV,
      text: RESPONSE,
      status: 200,
      payload: { credentialRef: "acme" },
    });
    expect(withCred).toEqual({
      revision: REV,
      text: RESPONSE,
      status: 200,
      credentialRef: "acme",
    });
    expect(
      sampleToRemember({
        revision: REV,
        text: RESPONSE,
        status: 200,
        payload: { credentialRef: null },
      })?.credentialRef,
    ).toBeNull();
    expect(
      sampleToRemember({
        revision: null,
        text: RESPONSE,
        status: 200,
        payload: { credentialRef: "acme" },
      }),
    ).toBeNull();
  });

  it("an opening with nothing to restore records nothing", () => {
    expect(shapeOfOpening(formFromTool(toolRow()))).toBeNull();
  });

  // The round-trip is the part that could quietly stop working: the shape is computed from the form
  // the SERVER answered with, and compared at the save against the payload the form produces. If
  // reading a row and writing it back did not agree, every save would drop its own sample.
  it("a definition read back from the server produces the shape a save of it does", () => {
    const opened = formFromTool(toolRow());
    expect(
      shapeOfArrival({
        text: RESPONSE,
        status: 200,
        against: opened,
        previous: null,
      }),
    ).toBe(captureShapeOf(payloadOf(opened)));
  });

  // And the emptiness rule is the module's, asked rather than spelled again: round 8 was this
  // judgement written in two places, with the copies disagreeing about a 404 with no body.
  it("asks the module what counts as no sample", () => {
    for (const [text, status] of [
      ["", null],
      ["  \n ", null],
    ] as [string, number | null][]) {
      expect(sampleIsNothing(text, status)).toBe(true);
      expect(
        shapeOfArrival({ text, status, against: FORM, previous: null }),
      ).toBeNull();
    }
    for (const [text, status] of [
      ["", 404],
      [RESPONSE, null],
    ] as [string, number | null][]) {
      expect(sampleIsNothing(text, status)).toBe(false);
      expect(
        shapeOfArrival({ text, status, against: FORM, previous: null }),
      ).toBe(SHAPE);
    }
  });
});

// A CREDENTIAL IS A ROW OF ITS OWN, and that is the hole the revision cannot see: the picker inlined
// in this very modal can edit the selected credential's base URL or its secret, keeping the same
// name. The tool's `updatedAt` never moves, the payload is identical, and yet a relative
// `urlTemplate` now resolves against another host and the request carries another authorization
// (round 13 of review).
describe("a credential changing under the same name", () => {
  const WITH = {
    revision: REV,
    text: RESPONSE,
    status: 200,
    credentialRef: "acme",
  };
  const WITHOUT = { ...WITH, credentialRef: null };

  it("drops the samples that used a credential", () => {
    rememberToolSample("42", WITH, sampleTicket());
    noteVaultChanged();
    expect(recallToolSample("42", REV)).toBeNull();
  });

  // NOT A GLOBAL CLEAR, which round 6 already paid for: a tool that carries no credential cannot be
  // affected by a vault edit, and the operator would see one they never touched come back empty.
  it("keeps the samples that used none", () => {
    rememberToolSample("43", WITHOUT, sampleTicket());
    noteVaultChanged();
    expect(recallToolSample("43", REV)?.text).toBe(RESPONSE);
  });

  // The entry is dropped at the moment of the change; a save still on the wire has no entry to drop,
  // and its sample was captured against the resolution that just stopped being current.
  it("refuses a save that was in flight and carried a credential", () => {
    const ticket = sampleTicket();
    noteVaultChanged();
    rememberToolSample("44", WITH, ticket);
    expect(recallToolSample("44", REV)).toBeNull();
  });

  it("still takes a save that was in flight and carried none", () => {
    const ticket = sampleTicket();
    noteVaultChanged();
    rememberToolSample("45", WITHOUT, ticket);
    expect(recallToolSample("45", REV)?.text).toBe(RESPONSE);
  });

  // And a save that STARTED after the change is about the vault as it is now.
  it("takes a save that started after the change", () => {
    noteVaultChanged();
    rememberToolSample("46", WITH, sampleTicket());
    expect(recallToolSample("46", REV)?.text).toBe(RESPONSE);
  });

  // THE SAMPLE ON SCREEN IS THE COPY THE DROP ABOVE CANNOT REACH. Editing the credential through
  // the picker inlined in this very modal drops the stored entry, and leaves the response in the
  // form with the definition it was captured against recorded beside it: the save that follows
  // takes its ticket AFTER the change, so nothing refuses it and the sample goes straight back in,
  // describing a request against the host the credential used to name (round 14 of review).
  it("a sample captured before the change stops describing the request", () => {
    const opened = formFromTool(toolRow());
    const captured = shapeOfArrival({
      text: RESPONSE,
      status: 200,
      against: opened,
      previous: null,
    });
    expect(sampleDescribes(captured, payloadOf(opened))).toBe(true);
    noteVaultChanged();
    // The payload has not moved. What moved is what its credential resolves to.
    expect(sampleDescribes(captured, payloadOf(opened))).toBe(false);
  });

  // And a sample captured AFTER the change describes the vault as it is now, so an operator who
  // edits a credential and tests again keeps what comes back.
  it("a sample captured after the change describes the request", () => {
    noteVaultChanged();
    const opened = formFromTool(toolRow());
    const captured = shapeOfArrival({
      text: RESPONSE,
      status: 200,
      against: opened,
      previous: null,
    });
    expect(sampleDescribes(captured, payloadOf(opened))).toBe(true);
  });

  // TWO SPELLINGS OF "NO CREDENTIAL" REACH THIS MODULE: the form holds an empty string and the
  // payload holds null. A rule that knew only one of them would read the other as a credential and
  // drop a sample that no vault edit can touch, which is round 6's global invalidation arriving by
  // the back door. So the empty string is the null here, on the way in and on the way out.
  it("reads an empty reference as no credential, whichever way it is spelled", () => {
    rememberToolSample("48", { ...WITH, credentialRef: "" }, sampleTicket());
    expect(recallToolSample("48", REV)?.credentialRef).toBeNull();
    noteVaultChanged();
    expect(recallToolSample("48", REV)?.text).toBe(RESPONSE);

    const ticket = sampleTicket();
    noteVaultChanged();
    rememberToolSample("49", { ...WITH, credentialRef: "" }, ticket);
    expect(recallToolSample("49", REV)?.text).toBe(RESPONSE);
  });

  // THE MODULE LISTENS FOR ITSELF, because a credential is edited from the Vault panel, the agent
  // editor and the picker inlined here, and the tool editor is mounted for at most one of those. A
  // listener living in a component is absent exactly when the edit happens somewhere else.
  it("hears the change without anyone wiring it up", () => {
    rememberToolSample("47", WITH, sampleTicket());
    window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
    expect(recallToolSample("47", REV)).toBeNull();
  });
});

describe("a save that lands after the sample's life ended", () => {
  it("does not put it back after the tool was deleted", () => {
    const ticket = sampleTicket();
    forgetToolSample("7", sampleTicket());
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      ticket,
    );
    expect(recallToolSample("7", REV)).toBeNull();
  });

  it("does not put it back after the session ended", () => {
    const ticket = sampleTicket();
    noteOperator(null);
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      ticket,
    );
    expect(recallToolSample("7", REV)).toBeNull();
  });

  // ROUND 12: two openings of the same tool, the slow one answering last. `docs/modals.md` covers
  // the dialog side of this; the cache has the same problem and the revision cannot see it, because
  // the second opening loaded exactly the revision the first save committed.
  it("does not let an older opening's response land on a newer one's", () => {
    const first = sampleTicket();
    rememberToolSample(
      "7",
      {
        revision: REV,
        text: '{"novo":true}',
        status: 200,
        credentialRef: null,
      },
      sampleTicket(),
    );
    // The first save's response, finally arriving with the ticket it left with.
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      first,
    );
    expect(recallToolSample("7", REV)?.text).toBe('{"novo":true}');
  });

  it("is per tool, so a save for one does not block a slower save for another", () => {
    const slow = sampleTicket();
    rememberToolSample(
      "8",
      {
        revision: REV,
        text: '{"outra":true}',
        status: 200,
        credentialRef: null,
      },
      sampleTicket(),
    );
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      slow,
    );
    expect(recallToolSample("7", REV)?.text).toBe(RESPONSE);
  });

  // A DELETION ENDS THE KEY, so it beats a save that started after the delete request went out and
  // not only one that started before it. The row is gone and nothing will ever ask for that entry
  // again, so accepting the save leaves the customer's response in a map with no use for it. This
  // is where the deletion's mark parts company with the write's, which is ordered by request start.
  it("refuses a save that started after the delete went out", () => {
    rememberToolSample(
      "10",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      sampleTicket(),
    );
    const removing = sampleTicket();
    const saving = sampleTicket();
    forgetToolSample("10", removing);
    rememberToolSample(
      "10",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
      saving,
    );
    expect(recallToolSample("10", REV)).toBeNull();
  });

  // TWO SAVES OF ONE TOOL THAT START BEFORE EITHER FINISHES. Dismiss a slow save, reopen the tool
  // and save again: the tickets used to carry the same number, because the clock only moved when
  // something LANDED, and equal numbers cannot be ordered. Whichever response arrived first marked
  // the key and the other was refused as stale, so the save the operator made LAST could lose to
  // the one they made first. Issuing is what orders them now.
  it("keeps the later save when the earlier one lands first", () => {
    const first = sampleTicket();
    const second = sampleTicket();
    rememberToolSample(
      "8",
      { revision: REV, text: "primeiro", status: 200, credentialRef: null },
      first,
    );
    rememberToolSample(
      "8",
      { revision: REV, text: "segundo", status: 200, credentialRef: null },
      second,
    );
    expect(recallToolSample("8", REV)?.text).toBe("segundo");
  });

  // The same pair in the other order, which is round 12's finding and must still hold: the older
  // opening's answer arriving last does not put its sample back.
  it("refuses the earlier save when the later one lands first", () => {
    const first = sampleTicket();
    const second = sampleTicket();
    rememberToolSample(
      "9",
      { revision: REV, text: "segundo", status: 200, credentialRef: null },
      second,
    );
    rememberToolSample(
      "9",
      { revision: REV, text: "primeiro", status: 200, credentialRef: null },
      first,
    );
    expect(recallToolSample("9", REV)?.text).toBe("segundo");
  });

  // And two tickets are never the same number, which is the property both cases rest on.
  it("gives every ticket its own place in the order", () => {
    const issued = [
      sampleTicket().at,
      sampleTicket().at,
      sampleTicket().at,
      sampleTicket().at,
    ];
    expect(new Set(issued).size).toBe(issued.length);
    expect([...issued].sort((a, b) => a - b)).toEqual(issued);
  });

  it("still writes when nothing cleared while it was out", () => {
    const ticket = sampleTicket();
    rememberToolSample(
      "7",
      { revision: REV, text: RESPONSE, status: 200, credentialRef: null },
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

  // ONE PLACE DECIDES WHICH DEFINITION THE SAMPLE DESCRIBES. Round 13 found the marker maintained
  // by hand at four sites with two of them wrong, so every assignment to it goes through the rule
  // that was extracted for it. A fifth site computing its own is the finding coming back, and the
  // module cannot see it: this is the only thing here that can.
  it("records the sample's definition only through the rule that decides it", async () => {
    const src = codeOnly(
      await Bun.file("src/client/pages/resources/ToolEditModal.tsx").text(),
    );
    const assignments = src.match(/sampleShapeRef\.current\s*=/g) ?? [];
    const throughTheRule = [
      ...src.matchAll(/sampleShapeRef\.current\s*=\s*([A-Za-z]+)\(/g),
    ].map((m) => m[1]);
    expect(assignments.length).toBeGreaterThan(0);
    expect(throughTheRule.length).toBe(assignments.length);
    expect([...new Set(throughTheRule)].sort()).toEqual([
      "shapeOfArrival",
      "shapeOfOpening",
    ]);
  });

  // AND FORMAT DOES NOT RE-CAPTURE. Asked of the handler and not of the file, because both setters
  // are legitimately called elsewhere in it: what makes this one different is that it changes the
  // whitespace of a response that came back from a definition it must keep pointing at.
  it("formats the sample without capturing it again", async () => {
    const src = codeOnly(
      await Bun.file("src/client/pages/resources/ToolEditModal.tsx").text(),
    );
    const from = src.indexOf("const tidy = sampleFormat.text;");
    expect(from).toBeGreaterThan(-1);
    const handler = src.slice(from, src.indexOf("}}", from));
    expect(handler).toInclude("reformatSample(");
    expect(handler).not.toInclude("setSample(");
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
    // empty body, status and all. A conditional is that copy coming back, and the module cannot see
    // it. Asked of what the save ASSEMBLES, which is a tested value since round 13
    // (`sampleToRemember`), so what is left here is the handover: the sample and the status as they
    // stand, and the payload the request carried.
    expect(call).not.toInclude("?");
    const assembled = save.slice(
      save.indexOf("sampleToRemember({"),
      save.indexOf("});", save.indexOf("sampleToRemember({")),
    );
    expect(assembled).not.toInclude("?");
    for (const name of [
      "revision",
      "text: sample",
      "status: sampleStatus",
      "payload",
    ])
      expect(assembled).toInclude(name);
    // What revision gets written is NOT asked here: it is a value now (`revisionForSave`), tested
    // as one below. Two rounds found this call site holding a judgement the module could not see,
    // and the second fence over a spelling is what the next refactor walks past.
    //
    // What IS asked is that the save consults the shape the sample was captured against at all,
    // because the decision being a tested value does not stop a caller from handing it a constant
    // (measured: replacing that argument with `true` survives the battery otherwise). This is still
    // a grammar, but a stable one: it says the question is asked, not how.
    expect(save).toInclude("sampleShapeRef");
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
