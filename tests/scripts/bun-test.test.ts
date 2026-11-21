import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { until } from "@/tests/utils/poll";
import { TEST_TIMEOUT_MS } from "@/tests/utils/timeouts";

const ROOT = join(import.meta.dir, "../..");

// bun gives a preload's `jest.setTimeout` to the first file of a process only, so a later file ran with
// bun's 5 s default. The launcher puts the suite's deadline on the command line, where it reaches every
// file. The `bun`s it can start are stubs first on PATH that answer `--version` and record the rest.
let root = "";

function stub(dir: string, body: string, version = Bun.version) {
  mkdirSync(join(root, dir), { recursive: true });
  const bun = join(root, dir, "bun");
  writeFileSync(
    bun,
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo ${version}; exit 0; }\n${body}\n`,
  );
  chmodSync(bun, 0o755);
  return join(root, dir);
}

// Every launch ends in `--help` and runs from an empty directory, so a launcher that falls back to the
// real `bun` (a stub that cannot run, under a `noexec` temporary directory) prints the usage and runs no
// test, this file included.
function launch(args: string[], dirs: string[], path = process.env.PATH ?? "") {
  const cwd = join(root, "cwd");
  mkdirSync(cwd, { recursive: true });
  return Bun.spawn(
    [process.execPath, join(ROOT, "scripts/bun-test.ts"), ...args, "--help"],
    {
      cwd,
      env: { ...process.env, PATH: [...dirs, path].join(delimiter) },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
}

// `bun test --help` from the binary running the launcher: it prints the usage and runs no test.
async function launchedHelp(dirs: string[], path?: string) {
  const proc = launch([], dirs, path);
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { code, usage: Bun.stripANSI(out).includes("Usage: bun test") };
}

// Under the checkout's ignored tmp/, not the system's temporary directory: the stubs must run, and a
// system may mount that one `noexec`.
beforeEach(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  root = mkdtempSync(join(ROOT, "tmp", "bun-test-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// The stubs are POSIX shell scripts: on Windows the launcher would find the real `bun` instead.
describe.skipIf(process.platform === "win32")("scripts/bun-test.ts", () => {
  test("runs `bun test` with the suite's deadline before the arguments it was given, and exits with its code", async () => {
    const dir = stub("machine", `printf '%s\\n' "$@" > "${root}/args"\nexit 7`);

    expect(
      await launch(["a.test.ts", "--timeout", "90000"], [dir]).exited,
    ).toBe(7);
    expect(readFileSync(join(root, "args"), "utf8").split("\n")).toEqual([
      "test",
      "--timeout",
      String(TEST_TIMEOUT_MS),
      "a.test.ts",
      "--timeout",
      "90000",
      "--help",
      "",
    ]);
  });

  // A package script puts node_modules/.bin first, and its `bun` would skip the machine's own (a queue
  // that caps concurrent runs); a machine `bun` of another version, or none, leaves the run on the
  // binary running the launcher.
  test("starts the machine's `bun` past node_modules/.bin when it is this one's version", async () => {
    const local = stub("node_modules/.bin", `touch "${root}/ran-local"`);
    const machine = stub(
      "machine",
      `touch "${root}/ran-machine"\nprintf '%s' "$PATH" > "${root}/path"`,
    );

    await launch([], [local, machine]).exited;
    // The run keeps node_modules/.bin, where the tests find the project's tools (`bunx prisma`).
    expect(readFileSync(join(root, "path"), "utf8").split(delimiter)[0]).toBe(
      local,
    );
    expect([
      existsSync(join(root, "ran-machine")),
      existsSync(join(root, "ran-local")),
    ]).toEqual([true, false]);
  });

  test("starts the binary running it when the machine's `bun` is another version", async () => {
    const local = stub("node_modules/.bin", `touch "${root}/ran-local"`);
    const machine = stub("machine", `touch "${root}/ran-machine"`, "0.0.1");

    expect(await launchedHelp([local, machine])).toEqual({
      code: 0,
      usage: true,
    });
    expect([
      existsSync(join(root, "ran-machine")),
      existsSync(join(root, "ran-local")),
    ]).toEqual([false, false]);
  });

  test("starts the binary running it when the machine's `bun` cannot start", async () => {
    const local = stub("node_modules/.bin", `touch "${root}/ran-local"`);
    mkdirSync(join(root, "machine"));
    writeFileSync(join(root, "machine/bun"), "#!/nonexistent/interpreter\n");
    chmodSync(join(root, "machine/bun"), 0o755);

    expect(await launchedHelp([local, join(root, "machine")])).toEqual({
      code: 0,
      usage: true,
    });
    expect(existsSync(join(root, "ran-local"))).toBe(false);
  });

  test("starts the binary running it when PATH has no `bun` at all", async () => {
    mkdirSync(join(root, "empty"));
    expect(await launchedHelp([], join(root, "empty"))).toEqual({
      code: 0,
      usage: true,
    });
  });

  test("a signal sent to the launcher alone reaches the run", async () => {
    // The stub ends on its own after 10 s, so a launcher that does not pass the signal on leaves
    // nothing running behind the failed test.
    const dir = stub(
      "machine",
      `trap 'echo TERM > "${root}/got"; exit 143' TERM\ntouch "${root}/up"\ni=0\nwhile [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done`,
    );
    const proc = launch(["--watch"], [dir]);
    try {
      await until("the run to start", () => existsSync(join(root, "up")));
      proc.kill("SIGTERM");
      await until("the run to get the signal", () =>
        existsSync(join(root, "got")),
      );
      expect(readFileSync(join(root, "got"), "utf8")).toBe("TERM\n");
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });
});
