// Runs one snippet past the thread's native stack (512 KiB, measured past macOS's room) and prints
// the outcome. Spawned by tests/graph/code-sandbox.test.ts so the engine's stderr can be read: an
// unwound runtime that is freed anyway prints an abort there, and nothing else shows it.
import { runSandboxedCode } from "@/graph/tools/code-sandbox";

const out = await runSandboxedCode(
  "for (let i = 0; i < 12000; i++) {}\nfunction f(n) { return f(n + 1) }; f(0)",
  { stackBytes: 512 * 1024 },
);
console.log(JSON.stringify(out));
