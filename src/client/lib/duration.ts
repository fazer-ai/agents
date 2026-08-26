// Which unit a duration in seconds should be READ in, and at what precision. The choice is here,
// away from the render, because it is the only part with a rule: the formatting itself is
// `Intl.NumberFormat`'s job and needs no help.
//
// The thresholds are not powers of sixty. They are where the number stops being useful in the
// smaller unit: a first-response median lives between half a minute and a few minutes, so seconds
// are kept until two of them (95 s reads as 95 s, not as "2 min"), and minutes until two hours.
// Rounding to the unit is deliberate above that: "5.3 h" answers "how long did the team take"
// and "5 h 17 min 42 s" only looks like it does.

export type DurationUnit = "second" | "minute" | "hour" | "day";

export interface ReadableDuration {
  value: number;
  unit: DurationUnit;
  // Fraction digits the unit is worth reading at, passed straight to Intl.
  fractionDigits: number;
}

// `null` for anything that is not a duration: NaN, Infinity, negative. A caller with no number to
// show must render its own "no data", never a zero: reading absence as zero is the whole defect
// this KPI exists to stop repeating.
export function readableDuration(
  seconds: number | null,
): ReadableDuration | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 120)
    return { value: Math.round(seconds), unit: "second", fractionDigits: 0 };
  if (seconds < 7200)
    return {
      value: Math.round(seconds / 60),
      unit: "minute",
      fractionDigits: 0,
    };
  if (seconds < 172800)
    return { value: seconds / 3600, unit: "hour", fractionDigits: 1 };
  return { value: seconds / 86400, unit: "day", fractionDigits: 1 };
}

// The duration as text, in the caller's locale. `Intl.NumberFormat` with `style: "unit"` is what
// puts "min" next to the number in the reader's language; a hand-written suffix would ship English
// to every locale.
export function formatDuration(
  seconds: number | null,
  locale: string,
): string | null {
  const d = readableDuration(seconds);
  if (!d) return null;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: d.unit,
    unitDisplay: "short",
    minimumFractionDigits: 0,
    maximumFractionDigits: d.fractionDigits,
  }).format(d.value);
}
