export function formatTimezoneLabel(tz: string): string {
  try {
    // Extract offset via longOffset — gives "GMT-03:00", "GMT+00:00", "GMT" (for UTC)
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(new Date());
    const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";

    // Normalize: "GMT" → "UTC±00:00", "GMT-03:00" → "UTC−03:00", "GMT+05:30" → "UTC+05:30"
    let offset: string;
    if (raw === "GMT") {
      offset = "UTC±00:00"; // ± sign for UTC
    } else {
      // raw is "GMT+HH:MM" or "GMT-HH:MM"; replace "GMT" with "UTC" and ASCII minus with proper minus sign
      offset = raw.replace("GMT", "UTC").replace("-", "−"); // − (minus sign U+2212)
    }

    // City label: last segment of IANA id, underscores replaced with spaces
    const segments = tz.split("/");
    const city =
      segments.length > 1
        ? (segments[segments.length - 1] ?? tz).replace(/_/g, " ")
        : tz;

    return `(${offset}) ${city}`;
  } catch {
    return tz;
  }
}

// Current UTC offset in minutes (respects DST at call time). Invalid tz → 0.
function timezoneOffsetMinutes(tz: string): number {
  try {
    const raw =
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "longOffset",
      })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = raw.match(/^GMT([+-])(\d{2}):(\d{2})$/);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3]));
  } catch {
    return 0;
  }
}

// Sorted by UTC offset (west → east), alphabetical within the same offset. Computing the
// offset of ~400 zones instantiates ~400 Intl formatters, so the sorted list is cached for the
// session (a DST flip mid-session only reorders edge cases; not worth recomputing).
let cachedTimezones: string[] | null = null;

export function listTimezones(): string[] {
  if (cachedTimezones) return cachedTimezones;
  try {
    cachedTimezones = [...Intl.supportedValuesOf("timeZone")].sort((a, b) => {
      const diff = timezoneOffsetMinutes(a) - timezoneOffsetMinutes(b);
      return diff !== 0 ? diff : a.localeCompare(b);
    });
  } catch {
    cachedTimezones = ["UTC"];
  }
  return cachedTimezones;
}
