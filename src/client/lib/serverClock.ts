// THE SERVER'S CLOCK, AS THE BROWSER LAST SAW IT. The console ARMS and DISPLAYS a debug-mode deadline
// only the server enforces, stored as the instant it ends and judged against the server's `new
// Date()`. The browser's clock would be off by however wrong the machine is: ahead, the console stops
// saying the mode is on while the runtime still records; behind, the switch saves a deadline already
// spent and comes back off with no reason shown. Every HTTP response carries `Date` (`Bun.serve` sets
// it), so the offset costs no endpoint. Approximate by design: one-second resolution, late by the
// transfer time, against a window of hours; it removes the order-of-minutes error that changes answers.
let offsetMs = 0;

// Reads the offset off a response the page was making anyway. Anything unreadable is ignored rather
// than treated as zero: a missing header says nothing about the clock, and the offset already in
// hand is a better answer than throwing it away.
export function noteServerDate(response: Response): void {
  const raw = response.headers.get("date");
  // The null check is what makes the `Date.parse` below type-safe; it changes no ANSWER, because
  // `Date.parse(null)` is NaN and the next line already refuses that.
  if (!raw) return;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return;
  offsetMs = t - Date.now();
}

// `Date.now()` with the offset applied. Before the first response, and whenever no response carried
// a readable date, this IS `Date.now()`: the browser's clock is the fallback.
export function serverNow(): number {
  return Date.now() + offsetMs;
}

export function serverNowDate(): Date {
  return new Date(serverNow());
}

// Forgets what the offset learned. Exists for tests, which share one module instance across a file.
export function resetServerClock(): void {
  offsetMs = 0;
}
