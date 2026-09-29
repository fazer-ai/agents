import { describe, expect, test } from "bun:test";

// Runs NODE_ENV=production in a subprocess (like tests/scripts/db-bootstrap.test.ts): tests/setup.ts
// pins NODE_ENV=test, and Elysia reads `isProduction` once, at module load of elysia/dist/error.js.
// Two claims live only here. Production trims `property`, `message` and `expected` from Elysia's JSON
// but keeps `found`, so the submitted value still reaches our handler. And `valueError` is populated
// in production too: the same constructor gates `expected` behind `isProduction`, and gating
// `valueError` the same way would drop `field` from every production refusal with every other test
// in this directory still green.
const SECRET = "sk-live-PRODUCTION-PROBE-9f3a";
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

const PROGRAM = `
import { t, ValidationError } from "elysia";
const { schemaRefusal } = await import("./src/api/lib/schema-refusal.ts");
const schema = t.Object({
  name: t.String({ minLength: 1 }),
  value: t.Object({ api_key: t.String() }),
});
const submitted = { name: "", value: { api_key: ${JSON.stringify(SECRET)} } };
const error = new ValidationError("body", schema, submitted);
const refusal = schemaRefusal(error, null);
console.log(JSON.stringify({
  nodeEnv: process.env.NODE_ENV,
  elysiaMessageCarriesSubmittedValue: error.message.includes(${JSON.stringify(SECRET)}),
  valueErrorPresent: error.valueError !== undefined,
  status: refusal.status,
  body: refusal.body,
  severity: refusal.severity,
  log: refusal.log,
}));
`;

async function probeProduction() {
  const proc = Bun.spawn(["bun", "-e", PROGRAM], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout.trim().split("\n").at(-1) as string);
}

const probe = await probeProduction();

describe("a schema refusal, measured under NODE_ENV=production", () => {
  test("the subprocess really is in production", () => {
    expect(probe.nodeEnv).toBe("production");
  });

  test("Elysia's own error still carries the submitted value there", () => {
    expect(probe.elysiaMessageCarriesSubmittedValue).toBe(true);
  });

  test("the field that names the refusal survives production", () => {
    expect(probe.valueErrorPresent).toBe(true);
    expect(probe.body.field).toBe("name");
  });

  test("the answer is the same one the rest of this directory pins", () => {
    expect(probe.status).toBe(422);
    expect(probe.severity).toBe("warn");
    expect(Object.keys(probe.body).sort()).toEqual(["error", "field"]);
    expect(probe.body.error).toBe("The value sent in name is not valid.");
  });

  test("neither the body nor the log line carries the submitted value", () => {
    expect(JSON.stringify(probe.body)).not.toInclude(SECRET);
    expect(probe.log).not.toInclude(SECRET);
    expect(probe.log).toBe(
      "refused body.name: Expected string length greater or equal to 1",
    );
  });
});
