import {
  createContext,
  forwardRef,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { inRange, type NumberRange } from "@/lib/number-range";
import { Input } from "./Input";

// THE way to draw a number in the console (biome-plugins/no-bare-number-input.grit
// refuses `<Input type="number">` anywhere else). The `min`/`max` attributes an input carries only
// bound the browser's spinner arrows, and nothing read them before Save: -10 went out, the server
// stored it, the agent ran on the reader's clamp and the editor kept showing -10. This field checks
// the value against the same range the server refuses outside of, says so under the box, and reports
// itself to the nearest <RangeHolds>, whose Save holds while any field under it is out of range.

interface RangeHoldsValue {
  report: (id: string, held: boolean) => void;
  held: boolean;
}

const RangeHoldsContext = createContext<RangeHoldsValue | null>(null);

// Wraps a form whose Save should hold while a number in it is out of range. Only mounted fields
// report, so a section switched off (its fields not drawn) holds nothing.
export function RangeHolds({
  children,
  onHeldChange,
}: {
  children: ReactNode;
  // For a save started outside the tree (the editor's "Save and export"), which cannot read the hook.
  onHeldChange?: (held: boolean) => void;
}) {
  const heldIds = useRef(new Set<string>());
  const [held, setHeld] = useState(false);
  const onHeldChangeRef = useRef(onHeldChange);
  onHeldChangeRef.current = onHeldChange;
  // Told as the field reports, not on the next render: a save resumed by the effects of the render
  // that drew a tab runs after its fields reported and before the state below lands.
  const report = useCallback((id: string, isHeld: boolean) => {
    if (isHeld) heldIds.current.add(id);
    else heldIds.current.delete(id);
    setHeld(heldIds.current.size > 0);
    onHeldChangeRef.current?.(heldIds.current.size > 0);
  }, []);
  const value = useMemo(() => ({ report, held }), [report, held]);
  return (
    <RangeHoldsContext.Provider value={value}>
      {children}
    </RangeHoldsContext.Provider>
  );
}

// For a part of the form drawn but not shown (a Behavior section hidden by the agent's mode): its
// fields keep their state and hold nothing while it is off screen.
export function RangeHoldsSuspended({
  suspended,
  children,
}: {
  suspended: boolean;
  children: ReactNode;
}) {
  const holds = useContext(RangeHoldsContext);
  return (
    <RangeHoldsContext.Provider value={suspended ? null : holds}>
      {children}
    </RangeHoldsContext.Provider>
  );
}

// Whether a number under the nearest <RangeHolds> is out of range; false with none.
export function useRangeHeld(): boolean {
  return useContext(RangeHoldsContext)?.held ?? false;
}

// The field's verdict on what it holds. Empty is a value only for an `optional` field, where it means
// "not set" (the default, or off); anything else that is not a number in range is refused.
export function numberProblem(
  value: string | number | null | undefined,
  range: NumberRange,
  optional: boolean,
): "empty" | "range" | "whole" | null {
  const text = value === null || value === undefined ? "" : String(value);
  if (text.trim() === "") return optional ? null : "empty";
  const n = Number(text);
  if (!Number.isFinite(n)) return "range";
  if (range.int && !Number.isInteger(n)) return "whole";
  return inRange(n, range) ? null : "range";
}

type NumberInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "type" | "min" | "max" | "step" | "value" | "showPasswordToggle"
> & {
  range: NumberRange;
  value: string | number | null | undefined;
  // Empty means "not set" here rather than a mistake.
  optional?: boolean;
  step?: number | "any";
};

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  ({ range, value, optional = false, step, errorMessage, ...props }, ref) => {
    const { t } = useTranslation();
    const id = useId();
    const holds = useContext(RangeHoldsContext);
    const problem = numberProblem(value, range, optional);
    // `disabled` is a field the operator cannot change right now, so it holds nothing.
    const held = problem !== null && !props.disabled;
    useEffect(() => {
      holds?.report(id, held);
    }, [holds, id, held]);
    useEffect(() => () => holds?.report(id, false), [holds, id]);
    const message =
      problem === null
        ? undefined
        : problem === "whole"
          ? t("numberInput.whole", "Use a whole number.")
          : t("numberInput.range", "Between {{min}} and {{max}}.", {
              min: range.min.toLocaleString(),
              max: range.max.toLocaleString(),
            });
    return (
      <Input
        ref={ref}
        type="number"
        min={range.min}
        max={range.max}
        step={step ?? (range.int ? 1 : "any")}
        inputMode={range.int ? "numeric" : "decimal"}
        value={value ?? ""}
        errorMessage={held ? message : errorMessage}
        {...props}
      />
    );
  },
);
NumberInput.displayName = "NumberInput";
