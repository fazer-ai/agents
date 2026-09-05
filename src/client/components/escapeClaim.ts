// Who owns the Escape key inside an open modal.
//
// Radix's dismissable layer listens for Escape on `document` with `capture: true`
// (@radix-ui/react-dismissable-layer), so it runs BEFORE the event reaches whatever is focused: a
// control inside the dialog cannot stop it by calling `stopPropagation`, and cannot be reached by
// registering later either, since same-phase listeners fire in registration order and the dialog
// mounts first. What Radix does honour is `event.defaultPrevented`, which it reads right after
// calling `onEscapeKeyDown`.
//
// So a control that owns Escape declares it here instead. Measured case (issue #538): the code
// editor's completion popup. Escape is the standard key for dismissing a suggestion, and without
// this the same press reached the dialog and asked the operator whether to discard the body they
// were in the middle of writing.

export type EscapeClaim = (target: EventTarget | null) => boolean;

const claims = new Set<EscapeClaim>();

// Registers a claim and returns its release. Call the release on unmount: a claim outliving its
// control would answer for a DOM node that is gone, and the dialog would stop closing on Escape.
export function claimEscape(claim: EscapeClaim): () => void {
  claims.add(claim);
  return () => {
    claims.delete(claim);
  };
}

// Hands this Escape press to whoever owns it, and answers whether someone took it. NOT a question:
// the claim that takes the press also ACTS on it (the code editor closes its completion popup),
// because the press it answered is the press meant to close that popup. Named for the handing over
// rather than for the answer, since a predicate that quietly acts is a trap, and it caught the
// first test written against it.
//
// The target decides: two editors can be mounted at once, and only the one the press happened in
// may cancel the dismissal.
export function handOverEscape(target: EventTarget | null): boolean {
  for (const claim of claims) {
    if (claim(target)) return true;
  }
  return false;
}
