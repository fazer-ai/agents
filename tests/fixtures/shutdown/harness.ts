import { beginWork, installShutdownHandlers } from "@/lib/shutdown";

// A process with the real signal handlers and units of work that end on their own after the given
// milliseconds ("hang" never does, unless cut). Driven by tests/lib/shutdown-signal.test.ts.
// argv: <boundMs> <work...>
const [boundArg, ...works] = process.argv.slice(2);
installShutdownHandlers({
  stop: () => console.log("HARNESS stop"),
  boundMs: Number(boundArg),
});
for (const spec of works) {
  const end = beginWork("DEBOUNCE", () => {
    console.log("HARNESS cut");
    end();
  });
  if (spec !== "hang")
    setTimeout(() => {
      console.log(`HARNESS done ${spec}`);
      end();
    }, Number(spec));
}
setInterval(() => {}, 1_000);
console.log("HARNESS ready");
