// THE TWO RULES OF LOGGING OUT, in a module of their own rather than in `AuthContext`, because
// another test file mocks that whole module for the test PROCESS (`mock.module`): a component
// importing a rule from there is handed `undefined` in every suite that mock reaches, and a test of
// the rule itself gets the stub instead of the rule. The provider is where these are USED; here is
// where they are decided (round 15 of review).

// ENDING A SESSION IS THE SERVER'S ANSWER, not the request being made.
//
// The cookie is HttpOnly, so only the response's `Set-Cookie` can end a session: a logout that did
// not get one leaves the operator signed in on the server while the console shows the login screen.
// On a shared device that is the failure that matters, and a reload brings the session back for
// whoever is sitting there (round 12 of review, issue #566).
//
// The error arrives as a VALUE, which is why the previous shape (`await`, then clear, with a
// `catch`) cleared anyway: measured against the treaty with a fetcher that rejects, it answers
// `{ data: null, error }` rather than raising, so the `catch` only ever saw the rarer case where the
// client itself throws. Both are handled here.
//
// AND IT ANSWERS WHETHER THE SESSION ENDED, because retaining it silently is worse than clearing it:
// both callers navigated to `/login` on any resolution, and `LoginPage` sends a signed-in visitor
// straight back to `redirectTo`, so a failed logout cost the operator the route they were on and
// "Switch account" did nothing at all, with nothing on screen either way (round 15 of review).
export async function performLogout(
  post: () => Promise<{ error?: unknown }>,
  endSession: () => void,
): Promise<boolean> {
  try {
    const { error } = await post();
    if (error) {
      console.error("Logout failed", error);
      return false;
    }
    endSession();
    return true;
  } catch (e) {
    console.error("Logout failed", e);
    return false;
  }
}

// WHAT THE TWO BUTTONS DO WITH THAT ANSWER, as a decision and not as an `if` written twice. Both of
// them navigate to `/login`, and that navigation only means anything once the session actually
// ended: the account menu would otherwise cost the operator the route they were on, and "Switch
// account" would come back to the consent screen as the same operator.
export function afterLogout(
  ended: boolean,
  go: () => void,
  warn: () => void,
): void {
  if (!ended) {
    warn();
    return;
  }
  go();
}
