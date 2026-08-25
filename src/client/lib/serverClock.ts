// THE SERVER'S CLOCK, AS THE BROWSER LAST SAW IT.
//
// The console both ARMS and DISPLAYS a deadline that only the server enforces: the debug mode of
// issue #58 is stored as the instant it ends, and every reader of it judges that instant against
// the server's own `new Date()`. Taking the browser's clock for that makes the two disagree by
// however wrong the operator's machine is, in both directions and neither of them visible:
//
// - a browser five minutes ahead arms five minutes of extra window and stops SAYING the mode is on
//   five minutes before the runtime stops recording, so the console's warning is wrong exactly
//   while the recording it warns about is still happening;
// - a browser half a day behind arms a deadline the server reads as already spent, so the switch
//   turns on, saves, and comes back off with nothing anywhere saying why.
//
// The offset costs no endpoint, no field and no round-trip of its own, because every HTTP response
// already carries `Date` (measured: `Bun.serve` sets it) and the console already makes requests.
//
// It is deliberately approximate. The header has one-second resolution and is written before the
// response travels, so the offset reads late by the transfer time — hundredths of a second against
// a window measured in hours. What it removes is the order-of-minutes error, which is the one that
// changes an answer.
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

// `Date.now()` with the offset applied. Before the first response, and whenever no response ever
// carried a readable date, this IS `Date.now()` — the browser's clock is the fallback, which is the
// behaviour that existed before this file.
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
