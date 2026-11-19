// The suite's database URLs ask for the JIT off (tests/setup.ts). The app turns it off on the metrics
// pool only, whose reads are a few large aggregates that the JIT compiles on every request
// (src/api/lib/pool-options.ts). A test reads them on its own clients, so on a server with the JIT
// available (the pgvector image on amd64, which the CI runs) each read pays the compilation, over a
// second, for an execution of milliseconds. Turning it off here makes the suite read the way the
// metrics pool does, and changes no result: the JIT only compiles the plan it was given.
const JIT_OFF = "-c jit=off";

export function withJitOffInUrl(connectionString: string): string {
  const url = URL.parse(connectionString);
  // NOTE: a URL a WHATWG parse refuses (no host) keeps the server's setting.
  if (!url) return connectionString;
  const own = url.searchParams.get("options") ?? "";
  if (own.includes(JIT_OFF)) return connectionString;
  url.searchParams.set("options", own ? `${own} ${JIT_OFF}` : JIT_OFF);
  return url.toString();
}
