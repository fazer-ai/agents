// Parses offset-less texts around the HOST's own DST transitions, with the agent in Tokyo, and
// prints the instants. Spawned by tests/graph/code-sandbox.test.ts under TZ=America/New_York and
// TZ=Pacific/Auckland: `process.env.TZ` does nothing once a process is up, so a host with a gap in
// 2026 (this machine is in São Paulo, CI in UTC; neither has one) can only be a child process.
import { runSandboxedCode } from "@/graph/tools/code-sandbox";

const out = await runSandboxedCode(
  `["Mar 8, 2026 02:30", "Mar 8, 2026 06:30", "2026/03/08 02:30", "2026-03-08T02:30:00.1234",
    "+002026-03-08T02:30", "Nov 1, 2026 01:30", "Sep 27, 2026 01:30", "Sep 27, 2026 02:30",
    "Sep 5, 2026 12:00 EST", "2026-09-05T12:00:00,123", "2026-09T12:00",
    "09-05-2026"].map((s) => new Date(s).toISOString())`,
  { clock: { timezone: "Asia/Tokyo" } },
);
console.log(JSON.stringify(out));
