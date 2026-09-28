// THE TWO RULES OF LOGGING OUT, in a module of their own rather than in `AuthContext`, because
// another test file mocks that whole module for the test PROCESS (`mock.module`): a component
// importing a rule from there is handed `undefined` in every suite that mock reaches, and a test of
// the rule itself gets the stub instead of the rule. The provider is where these are USED; here is
// where they are decided.

// ENDING A SESSION IS THE SERVER'S ANSWER, not the request being made. The cookie is HttpOnly, so
// only the response's `Set-Cookie` ends a session; a logout without one leaves the operator signed
// in on the server behind a login screen, and on a shared device a reload brings the session back.
// The treaty answers a failure as a VALUE (`{ data: null, error }`), not a throw, so a `catch` alone
// misses it; both are handled here. It returns whether the session ended: `LoginPage` sends a
// signed-in visitor straight back to `redirectTo`, so navigating on a failed logout would lose the
// route and make "Switch account" do nothing, with nothing on screen.
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
