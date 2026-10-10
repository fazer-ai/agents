// Where a Save that cannot write yet takes the operator (agents#1224). The button stays pressable on
// both tabs of the decision setup, and the press lights what is missing and comes here: the first
// problem on the tab, which is a field when the fix is on this tab and the summary's way to the other
// tab when it is not. A field is wrong when it is marked invalid, has an error line under it, or is
// a control that draws its own warning and is marked `data-problem`. A summary
// (`data-problems-summary`) is skipped while a field below it is wrong, since it only repeats them.

const CONTROL = "input, select, textarea, button";

export function revealFirstProblem(root: ParentNode | null): boolean {
  if (!root) return false;
  const marks = [
    ...root.querySelectorAll<HTMLElement>(
      '[aria-invalid="true"], [role="alert"], [data-problem]',
    ),
  ];
  const field = marks.find((m) => !m.closest("[data-problems-summary]"));
  const summary = field
    ? null
    : root.querySelector<HTMLElement>("[data-problems-summary]");
  const target = field ?? summary;
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  const control = target.matches(CONTROL)
    ? target
    : !field
      ? target.querySelector<HTMLElement>("button")
      : target.hasAttribute("data-problem")
        ? target.querySelector<HTMLElement>(CONTROL)
        : target.parentElement?.querySelector<HTMLElement>(CONTROL);
  control?.focus({ preventScroll: true });
  return true;
}
