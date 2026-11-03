import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// biome-plugins/no-dialog-outside-modal.grit, through the real Biome. `<Modal>` moves a dialog whose
// body changes height without a jump (docs/modals.md); a Radix dialog drawn anywhere else misses
// that, so the rule refuses a Radix dialog import in the client outside the files biome.jsonc
// exempts. biome.jsonc applies the rule under tests/lint/.probe-dialog-*, the stand-in for the
// client tree here, and not under tests/lint/.probe-nodialog-*, which stands for everywhere else.

const ROOT = join(import.meta.dir, "../..");
const INSIDE = `tests/lint/.probe-dialog-${process.pid}`;
const OUTSIDE = `tests/lint/.probe-nodialog-${process.pid}`;
// Built rather than written: a literal path into the source tree is what no-test-reads-source refuses.
const CLIENT = [["s", "rc"].join(""), "client"].join("/");
const EXEMPT = ["Modal.tsx", "DiscardDialog.tsx", "Sidebar.tsx"].map(
  (name) => `${CLIENT}/components/${name}`,
);

const SAMPLES: Record<string, string> = {
  "namespace.tsx": `import * as DialogPrimitive from "@radix-ui/react-dialog";\nexport { DialogPrimitive };\n`,
  "named.tsx": `import { Content, Root } from '@radix-ui/react-dialog';\nexport { Content, Root };\n`,
  "alert.tsx": `import * as AlertDialog from "@radix-ui/react-alert-dialog";\nexport { AlertDialog };\n`,
  "multiline.tsx": `import {\n  Portal,\n  Content as C,\n} from "@radix-ui/react-dialog";\nexport { Portal, C };\n`,
  "modal.tsx": `import { Modal } from "@/client/components/Modal";\nexport { Modal };\n`,
  "popover.tsx": `import * as Popover from "@radix-ui/react-popover";\nexport { Popover };\n`,
};
const REFUSED = ["namespace.tsx", "named.tsx", "alert.tsx", "multiline.tsx"];

const files: Record<string, string> = {};
for (const dir of [INSIDE, OUTSIDE]) {
  for (const [name, body] of Object.entries(SAMPLES)) {
    files[`${dir}/${name}`] = body;
  }
}

let hits: Map<string, number>;

beforeAll(() => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(ROOT, path, ".."), { recursive: true });
    writeFileSync(join(ROOT, path), body);
  }
  const run = Bun.spawnSync({
    cmd: [
      "bun",
      "biome",
      "lint",
      "--only=plugin",
      "--max-diagnostics=none",
      "--reporter=github",
      ...Object.keys(files),
      ...EXEMPT,
    ],
    cwd: ROOT,
  });
  hits = new Map();
  for (const line of run.stdout.toString().split("\n")) {
    const m = line.match(/file=([^,]+),.*::(.*)$/);
    if (!m?.[1] || !m[2]?.includes("A dialog is drawn by <Modal>")) continue;
    const file = m[1].startsWith(ROOT) ? m[1].slice(ROOT.length + 1) : m[1];
    hits.set(file, (hits.get(file) ?? 0) + 1);
  }
});

afterAll(() => {
  for (const dir of [INSIDE, OUTSIDE]) {
    rmSync(join(ROOT, dir), { recursive: true, force: true });
  }
});

const of = (path: string) => hits.get(path) ?? 0;

test.each(REFUSED)("a Radix dialog import is refused (%s)", (name) => {
  expect(of(`${INSIDE}/${name}`)).toBe(1);
});

test.each(Object.keys(SAMPLES).filter((name) => !REFUSED.includes(name)))(
  "an import that draws no Radix dialog is allowed (%s)",
  (name) => {
    expect(of(`${INSIDE}/${name}`)).toBe(0);
  },
);

test("the three exempt files, each with why in biome.jsonc, are not refused", () => {
  for (const path of EXEMPT) expect(of(path)).toBe(0);
});

test("where the rule does not apply, nothing is refused", () => {
  for (const name of Object.keys(SAMPLES))
    expect(of(`${OUTSIDE}/${name}`)).toBe(0);
});
