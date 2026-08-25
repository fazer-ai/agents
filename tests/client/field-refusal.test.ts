import { describe, expect, test } from "bun:test";
import {
  type FormAtAnswer,
  placeRefusal,
  type Refusal,
  type RefusalPlacement,
  readRefusal,
} from "@/client/lib/fieldRefusal";

// THE DECISION, ON ITS OWN.
//
// `useFieldRefusal` is state around these two functions and nothing else, so the rule is provable
// without mounting anything: what the wire said, what the form declared it renders, and which of the
// two channels the operator ends up reading it in.
//
// The invariant the table is really checking is that the channels are EXCLUSIVE and one always
// fires. Every row below answers exactly one of `at` and `toast`, and no row answers neither.

// The Eden rejection shape: the parsed body on `value`.
const eden = (value: unknown) => ({ value });

describe("readRefusal", () => {
  const cases: Array<{ name: string; input: unknown; want: Refusal | null }> = [
    {
      name: "a refusal that names an input carries both halves",
      input: eden({ error: "too long", field: "systemPrompt" }),
      want: { message: "too long", field: "systemPrompt" },
    },
    {
      name: "a refusal about no input carries only the sentence",
      input: eden({ error: "forbidden" }),
      want: { message: "forbidden" },
    },
    {
      // The wire never sends this (`refusalBody` drops a blank name before answering), and a client
      // that matched on it would mark whichever control declared the empty string.
      name: "a blank field is not a name",
      input: eden({ error: "nope", field: "   " }),
      want: { message: "nope" },
    },
    {
      // Trimmed on the way in for the same reason the server trims on the way out: `" name "` and
      // `"name"` must not be two different inputs.
      name: "a padded field is the same name",
      input: eden({ error: "nope", field: " name " }),
      want: { message: "nope", field: "name" },
    },
    {
      name: "a field that is not a string is not a name",
      input: eden({ error: "nope", field: 7 }),
      want: { message: "nope" },
    },
    {
      // A transport failure: Eden rejects with no parsed body at all.
      name: "no body at all is not a refusal",
      input: new Error("offline"),
      want: null,
    },
    {
      name: "a body with no sentence is not a refusal",
      input: eden({ field: "name" }),
      want: null,
    },
    {
      // Whitespace is not a sentence. Showing it would be a toast the operator sees as empty.
      name: "a blank sentence is not a refusal",
      input: eden({ error: "   ", field: "name" }),
      want: null,
    },
    { name: "null is not a refusal", input: null, want: null },
    { name: "a string is not a refusal", input: "boom", want: null },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(readRefusal(c.input)).toEqual(c.want as Refusal);
    });
  }
});

describe("placeRefusal", () => {
  const RENDERED = ["name", "document", "guardrails.output.templateMessage"];
  const FALLBACK = "Could not save.";

  // A form that is on screen and whose inputs still hold exactly what the request carried: the
  // ordinary case, so the rows that are about WHERE a refusal goes are not also about staleness.
  const STEADY: FormAtAnswer = {
    mounted: true,
    sent: { document: "12.345", name: "ACME" },
    current: { document: "12.345", name: "ACME" },
  };

  const cases: Array<{
    name: string;
    refusal: Refusal | null;
    rendered?: readonly string[];
    form?: FormAtAnswer;
    want: RefusalPlacement;
  }> = [
    {
      name: "an input this form renders takes the message",
      refusal: { message: "bad character", field: "document" },
      want: { at: "document", message: "bad character", value: "12.345" },
    },
    {
      // A dotted path is a name like any other. Nothing here parses it.
      name: "a dotted path this form renders takes it too",
      refusal: {
        message: "too long",
        field: "guardrails.output.templateMessage",
      },
      // The request did not carry this field, so there is nothing to compare it against and nothing
      // stale: the refusal is about what is STORED, not about a value this write changed.
      want: {
        at: "guardrails.output.templateMessage",
        message: "too long",
        value: undefined,
      },
    },
    {
      // The silence case, and the one the mechanism breaks first: an input this form has no control
      // for must not swallow the refusal.
      name: "an input this form does not render falls back to the toast",
      refusal: { message: "logo unreadable", field: "logoKey" },
      want: { toast: "logo unreadable" },
    },
    {
      // Exact match only. A form that renders the parent path has not said it renders the leaf, and
      // marking the parent control would point at an input the refusal is not about.
      name: "a child of a rendered path is not a rendered path",
      refusal: {
        message: "too long",
        field: "guardrails.output.templateMessage.extra",
      },
      want: { toast: "too long" },
    },
    {
      name: "a parent of a rendered path is not a rendered path either",
      refusal: { message: "too long", field: "guardrails.output" },
      want: { toast: "too long" },
    },
    {
      name: "a refusal about no input is a toast, in the server's words",
      refusal: { message: "forbidden" },
      want: { toast: "forbidden" },
    },
    {
      // The only row where the caller's own sentence is the answer: there was no server to word it.
      name: "no refusal at all is the caller's fallback",
      refusal: null,
      want: { toast: FALLBACK },
    },
    {
      name: "a form that renders nothing toasts everything",
      refusal: { message: "bad character", field: "document" },
      rendered: [],
      want: { toast: "bad character" },
    },
    {
      // A modal body can unmount while its own save is out. The mark would be written to state
      // nobody renders, and `capture` would have reported "it is on the control" — silence.
      name: "a form that is gone renders nothing, so the message is a toast",
      refusal: { message: "bad character", field: "document" },
      form: { ...STEADY, mounted: false },
      want: { toast: "bad character" },
    },
    {
      // The operator corrected the value while the request was out. The refusal is about what was
      // SENT, and marking the box would blame a value the server never saw.
      name: "a value the operator has already replaced is a toast",
      refusal: { message: "bad character", field: "document" },
      form: {
        ...STEADY,
        current: { document: "12.345", name: "ACME" },
        sent: { document: "12.345 x" },
      },
      want: { toast: "bad character" },
    },
    {
      // The guard on the comparison, and it needs a row of its own: a refusal about a field this
      // write never carried is about what is STORED, so there is no submitted value to be stale
      // against. Comparing anyway reads `undefined` out of `sent`, finds it different from what the
      // input holds, and toasts every one of them.
      name: "a field the request never carried is not stale, it is just not sent",
      refusal: { message: "too long", field: "name" },
      form: {
        mounted: true,
        sent: { document: "12.345" },
        current: { document: "12.345", name: "ACME" },
      },
      want: { at: "name", message: "too long", value: "ACME" },
    },
    {
      // The same comparison the other way: unchanged since the request went out, so the mark is
      // about the value in the box.
      name: "a value still in the box takes the mark",
      refusal: { message: "bad character", field: "document" },
      form: {
        mounted: true,
        sent: { document: "12.345 x" },
        current: { document: "12.345 x" },
      },
      want: { at: "document", message: "bad character", value: "12.345 x" },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        placeRefusal(
          c.refusal,
          c.rendered ?? RENDERED,
          FALLBACK,
          c.form ?? STEADY,
        ),
      ).toEqual(c.want);
    });
  }

  // The property the rows are individually asserting, stated once over all of them: never both, and
  // never neither. A future row that answered `{ at, toast }` would read as correct in its own line.
  test("exactly one channel fires, on every row", () => {
    for (const c of cases) {
      const placed = placeRefusal(
        c.refusal,
        c.rendered ?? RENDERED,
        FALLBACK,
        c.form ?? STEADY,
      );
      const at = "at" in placed && placed.at !== undefined;
      const toast = "toast" in placed;
      expect([c.name, at !== toast]).toEqual([c.name, true]);
    }
  });
});
