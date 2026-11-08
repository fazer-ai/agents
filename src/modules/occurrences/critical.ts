import { createHash } from "node:crypto";
import { z } from "zod";
import type { CriticalInputs } from "./model";

// CRITICAL THEMES (docs/occurrences.md, "Critical themes"). The model says whether a theme is a serious
// subject for the business in the same call that creates or renames it, from the account's critical
// subjects and its business context; a theme not judged yet by the monitor's list and context now (one
// from before the mark, a split's part, or every open theme after the list or the context changed) is
// judged by a call of its own at the end of the round's theme steps. The list guides the judgment and does not limit it: with none, a
// clearly urgent theme is still critical.

// What makes a theme critical, said the same way to every call that judges one. Generic on purpose:
// what is urgent for this account comes from its business context and its own list.
export const CRITICAL_IS =
  "A theme is critical when it is on the account's critical list, or when it is clearly urgent for this business: customers cannot buy, cannot pay, do not receive what they paid for, or something the business runs on is down for them. A routine question, a common request, or a difficulty the customer can easily get around is not critical, however many conversations it has. The account's list guides this judgment and does not limit it.";

// The fixed instructions of a call that judges themes, with the account's subjects after them.
export function withCriticalSubjects(
  system: string,
  subjects: readonly string[],
): string {
  const list = subjects.map((s) => s.trim()).filter((s) => s !== "");
  return `${system}

${CRITICAL_IS}
${
  list.length > 0
    ? `The account's critical list, in its own words:
<critical>
${list.map((s) => `- ${s}`).join("\n")}
</critical>`
    : "The account has no critical list: judge by clear urgency alone."
}`;
}

// What a judgment was made by: the list and the business context, as one digest. Every mark is
// stored with the basis it was judged by, and a mark whose basis is not the monitor's now reads as not
// judged: the reads show it as not critical, and the round judges it again. So a change to the list or
// the context needs no write of its own, and a round that judged by the old one while the save landed
// leaves a mark that is simply judged again.
export function criticalBasis(inputs: CriticalInputs | undefined): string {
  const subjects = (inputs?.criticalSubjects ?? [])
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const context = (inputs?.businessContext ?? "").trim();
  return createHash("sha256")
    .update(JSON.stringify([subjects, context]))
    .digest("hex");
}

// Whether a stored mark stands as critical under the monitor's basis now.
export function criticalNow(
  row: { critical: boolean | null; criticalBasis: string | null },
  basis: string,
): boolean {
  return row.critical === true && row.criticalBasis === basis;
}

// The model's word on one theme, read leniently: anything but a boolean is no judgment, which leaves
// the theme to be judged again rather than refusing the decision it rides on.
export const criticalSchema = z.boolean().nullish().catch(null);
