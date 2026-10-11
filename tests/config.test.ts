import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseIntSetting } from "@/config";

// Every numeric environment variable goes through one validated parser. An unchecked `Number(RAW)`
// turns "15s" into NaN and "1e309" into Infinity: a `setInterval` worker then ticks about every
// millisecond against the database, and `Date` arithmetic gets an Invalid Date (the retention sweep
// stops, the heartbeat never comes due). `@/config` is evaluated once per import specifier, so each
// environment below loads a fresh copy of the module under its own query string.
const CONFIG_MODULE = Bun.resolveSync("@/config", import.meta.dir);
const ENV_EXAMPLE = readFileSync(".env.example", "utf8");

// The numeric defaults .env.example documents, which is where the operator reads them.
const DOCUMENTED = new Map(
  [...ENV_EXAMPLE.matchAll(/^([A-Z][A-Z0-9_]*)=([0-9]+)\s*$/gm)].map(
    (match) => [match[1] as string, Number(match[2])],
  ),
);

let loads = 0;
async function loadConfig(
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const saved = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    loads += 1;
    return (await import(`${CONFIG_MODULE}?load=${loads}`)).default;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function refusalOf(
  env: Record<string, string | undefined>,
): Promise<string | null> {
  try {
    await loadConfig(env);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// Every primitive in the loaded config, by path, so a variable's effect is found by what it changes.
function leaves(value: unknown, at = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) {
      for (const [path, leaf] of leaves(inner, at ? `${at}.${key}` : key)) {
        out.set(path, leaf);
      }
    }
  } else {
    out.set(at, Array.isArray(value) ? JSON.stringify(value) : value);
  }
  return out;
}

// Every documented number, unset, so the baseline is the code's own defaults and not this machine's
// `.env`.
const UNSET = Object.fromEntries(
  [...DOCUMENTED.keys()].map((key) => [key, undefined]),
);

interface Setting {
  variable: string;
  documented: number;
  // The config paths this variable moves, and what each holds with the variable unset.
  defaults: Map<string, unknown>;
}

// A documented variable is a config setting when setting it moves a value in the loaded config; one
// that moves nothing (`POSTGRES_PORT`) is read by something else.
async function numericSettings(): Promise<Setting[]> {
  const baseline = leaves(await loadConfig(UNSET));
  const settings: Setting[] = [];
  for (const [variable, documented] of DOCUMENTED) {
    const probe = String(documented > 1 ? documented - 1 : documented + 1);
    const moved = leaves(await loadConfig({ ...UNSET, [variable]: probe }));
    const defaults = new Map<string, unknown>();
    for (const [path, value] of moved) {
      if (value !== baseline.get(path)) defaults.set(path, baseline.get(path));
    }
    if (defaults.size > 0) settings.push({ variable, documented, defaults });
  }
  return settings;
}

const SETTINGS = await numericSettings();

describe("numeric environment parsing", () => {
  // NOTE: the probe is looking at something: a discovery that finds no setting would pass every test
  // below.
  test("the documented numeric settings are found in the loaded config", () => {
    expect(SETTINGS.length).toBeGreaterThanOrEqual(25);
    expect(SETTINGS.map((s) => s.variable)).toContain(
      "OBSERVE_WORKER_INTERVAL_MS",
    );
  });

  // NOTE: a variable converted with the unchecked `Number(RAW)` shape loads "15s" as NaN instead of
  // refusing it, and one reported under another's name gives the operator an error naming a variable
  // they never set.
  test("garbage is refused at load, naming the variable that carried it", async () => {
    const wrong: string[] = [];
    for (const { variable } of SETTINGS) {
      const refusal = await refusalOf({ ...UNSET, [variable]: "15s" });
      if (!refusal?.startsWith(`${variable} must be`)) {
        wrong.push(`${variable}: ${refusal ?? "loaded"}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  // NOTE: a mistyped fallback runs the app on a number nobody chose. Checked against `.env.example`,
  // because that is where the operator reads the default, so this also fails when the documentation
  // drifts from the code.
  test("every default is the one .env.example documents", () => {
    const disagreements = SETTINGS.flatMap(
      ({ variable, documented, defaults }) =>
        [...defaults]
          .filter(([, value]) => value !== documented)
          .map(
            ([path, value]) =>
              `${variable}: config.${path} defaults to ${String(value)}, .env.example says ${documented}`,
          ),
    );
    expect(disagreements).toEqual([]);
  });

  // NOTE: zero is admitted only where the CONSUMER treats it as a value rather than an absence; elsewhere it
  // is a 1ms tick, a heartbeat due at `now`, or a port nothing can route to. Widening the exception
  // fails here until someone makes it deliberately.
  test("zero is a value at one setting, and this is which", async () => {
    const admitZero: string[] = [];
    for (const { variable } of SETTINGS) {
      if ((await refusalOf({ ...UNSET, [variable]: "0" })) === null) {
        admitZero.push(variable);
      }
    }
    // DB_LOCK_TIMEOUT_MS: Postgres reads lock_timeout 0 as no limit, which is the documented "off".
    expect(admitZero.sort()).toEqual([
      "ALERT_COALESCE_WINDOW_MS",
      "DB_LOCK_TIMEOUT_MS",
    ]);
  });
});

// Why a timer variable is refused above 2_147_483_647: past it the runtime SETS the delay to 1, so
// "tick every 25 days" is a worker spinning against the database.
describe("the timer bound is the runtime's, not a policy", () => {
  test("a delay above it is not honoured, it collapses to about a millisecond", async () => {
    const firedImmediately = await new Promise<boolean>((resolve) => {
      // If the runtime honoured this, the callback would be due in about 24.8 days.
      const interval = setInterval(() => {
        clearInterval(interval);
        clearTimeout(guard);
        resolve(true);
      }, 2_147_483_648);
      // Resolves false instead of hanging, so a runtime that starts honouring long delays fails
      // this test in two seconds rather than blocking the suite.
      const guard = setTimeout(() => {
        clearInterval(interval);
        resolve(false);
      }, 2_000);
    });
    expect(firedImmediately).toBe(true);
  });
});

// An agent's burst window may be shorter than the observe drain's interval, so the
// interval is a safety net with a floor of its own, and the operator reads both numbers where the
// variable is set.
describe("the observe drain's interval", () => {
  test("has a default and a minimum of its own", async () => {
    const intervalOf = async (raw: string | undefined) =>
      (
        (await loadConfig({ OBSERVE_WORKER_INTERVAL_MS: raw }))
          .observeWorker as {
          intervalMs: number;
        }
      ).intervalMs;
    expect(await intervalOf(undefined)).toBe(2_500);
    expect(await intervalOf("100")).toBe(100);
  });

  test(".env.example states the default and the minimum next to the variable", () => {
    const at = ENV_EXAMPLE.indexOf("OBSERVE_WORKER_INTERVAL_MS=");
    expect(at).toBeGreaterThan(-1);
    const note = ENV_EXAMPLE.slice(Math.max(0, at - 700), at);
    expect(note).toContain("default 2500, minimum 100");
  });

  test("a value below the minimum is refused by name at boot", async () => {
    expect(await refusalOf({ OBSERVE_WORKER_INTERVAL_MS: "99" })).toMatch(
      /^OBSERVE_WORKER_INTERVAL_MS must be a whole number between 100/,
    );
  });
});

// The parser's own handling of the minimum, driven directly. Everything else about it (blanks,
// `Infinity`, `1e309`, fractions, negatives, garbage, the upper bound) is covered in
// tests/api/middlewares/credentialRateLimit.test.ts.
describe("the minimum", () => {
  test("zero is refused by default and admitted when a setting asks for it", () => {
    expect(() =>
      parseIntSetting(
        "0",
        "COMPACTION_WORKER_INTERVAL_MS",
        15_000,
        "why.",
        2_147_483_647,
      ),
    ).toThrow(/between 1 and/);
    expect(
      parseIntSetting(
        "0",
        "ALERT_COALESCE_WINDOW_MS",
        30_000,
        "why.",
        2_147_483_647,
        0,
      ),
    ).toBe(0);
  });

  // The message has to name the minimum it applied, not a constant 1, or the operator who set zero
  // deliberately is told the opposite of what the setting accepts.
  test("the error names the minimum that was applied", () => {
    expect(() =>
      parseIntSetting(
        "-1",
        "ALERT_COALESCE_WINDOW_MS",
        30_000,
        "why.",
        2_147_483_647,
        0,
      ),
    ).toThrow(/between 0 and/);
  });
});

// The storage-directory fallback chain.
describe("documentsStorageDir fallback chain", () => {
  // NOTE: the ORDER matters: Coolify freezes a compose `environment:` value at install time, so an existing
  // install keeps QUOTES_STORAGE_DIR forever. Without that fallback it lands on the in-container
  // default and every PDF disappears on the next redeploy, silently.
  test("prefers the new name, then the frozen old one, then the default", async () => {
    const dirFor = async (documents?: string, quotes?: string) =>
      (
        await loadConfig({
          DOCUMENTS_STORAGE_DIR: documents,
          QUOTES_STORAGE_DIR: quotes,
        })
      ).documentsStorageDir;
    expect(await dirFor("/new", "/old")).toBe("/new");
    expect(await dirFor(undefined, "/old")).toBe("/old");
    expect(await dirFor(undefined, undefined)).toBe("./data/documents");
  });

  // NOTE: a variable the composes do not declare lands on that in-container default, which is the same
  // silent loss from the other direction, for a NEW installation.
  test("every deploy compose declares the storage directory", () => {
    for (const file of [
      "docker-compose.prod.yml",
      "docker-compose.coolify.yml",
      "docker-compose.portainer.yml",
    ]) {
      const compose = readFileSync(file, "utf8");
      expect(compose).toContain("DOCUMENTS_STORAGE_DIR=/app/storage/documents");
      // NOTE: the old name stays declared too, for installations created before the rename.
      expect(compose).toContain("QUOTES_STORAGE_DIR=");
    }
  });
});

// A setting the deploy composes do not forward cannot be tuned there: the stack's variable never
// reaches the container, which keeps the default in silence.
describe("Chatwoot receiver settings in the deploy composes", () => {
  test("every deploy compose forwards both, with the documented defaults", () => {
    for (const file of [
      "docker-compose.prod.yml",
      "docker-compose.coolify.yml",
      "docker-compose.portainer.yml",
    ]) {
      const compose = readFileSync(file, "utf8");
      expect(compose).toMatch(
        /CHATWOOT_DELIVERY_CONCURRENCY=\$\{CHATWOOT_DELIVERY_CONCURRENCY:-15\}/,
      );
      expect(compose).toMatch(
        /CHATWOOT_ACK_POOL_MAX=\$\{CHATWOOT_ACK_POOL_MAX:-4\}/,
      );
    }
  });
});

// Each pool has its own size and every budget its own knob; the checkpointer keeps following
// DB_POOL_MAX until it is set, which is what an upgrade without new variables must open.
describe("database pools and budgets", () => {
  test("the checkpointer pool follows DB_POOL_MAX until set, and is its own when set", async () => {
    const follows = await loadConfig({
      DB_POOL_MAX: "7",
      LANGGRAPH_POOL_MAX: undefined,
    });
    expect(follows.dbPoolMax).toBe(7);
    expect(follows.langgraphPoolMax).toBe(7);
    const own = await loadConfig({ DB_POOL_MAX: "7", LANGGRAPH_POOL_MAX: "2" });
    expect(own.dbPoolMax).toBe(7);
    expect(own.langgraphPoolMax).toBe(2);
  });

  test("a value that is not a whole number in range refuses by name, and a lock timeout of 0 is off", async () => {
    for (const [env, raw] of [
      ["METRICS_POOL_MAX", "0"],
      ["BACKGROUND_POOL_MAX", "2.5"],
      ["LANGGRAPH_POOL_MAX", "abc"],
      ["METRICS_TIMEOUT_MS", "15s"],
      ["DB_TX_TIMEOUT_MS", "-1"],
      ["DB_TX_MAX_WAIT_MS", "1e309"],
      ["DB_LOCK_TIMEOUT_MS", "1.5"],
    ] as const) {
      const refusal = await refusalOf({ [env]: raw });
      expect(refusal).toContain(`${env} must be`);
      expect(refusal).toContain(`"${raw}"`);
    }
    const off = await loadConfig({ DB_LOCK_TIMEOUT_MS: "0" });
    expect(off.dbLockTimeoutMs).toBe(0);
  });

  // NOTE: an operator sizing this pool reads the refusal to learn what runs on it. A turn's flow-log
  // lines are written on the pool of the work that emits them, so naming the flow log here sends the
  // operator to size the wrong pool for it.
  test("the BACKGROUND_POOL_MAX refusal names flow-log retention, not the flow log", async () => {
    const refusal = await refusalOf({ BACKGROUND_POOL_MAX: "0" });
    expect(refusal).toContain("flow-log retention");
    expect(refusal).not.toContain("the flow log");
  });

  test("every deploy compose forwards the pool sizes and budgets, empty for the app default", () => {
    for (const file of [
      "docker-compose.prod.yml",
      "docker-compose.coolify.yml",
      "docker-compose.portainer.yml",
    ]) {
      const compose = readFileSync(file, "utf8");
      for (const v of [
        "DB_POOL_MAX",
        "LANGGRAPH_POOL_MAX",
        "BACKGROUND_POOL_MAX",
        "METRICS_POOL_MAX",
        "METRICS_TIMEOUT_MS",
        "DB_TX_MAX_WAIT_MS",
        "DB_TX_TIMEOUT_MS",
        "DB_LOCK_TIMEOUT_MS",
      ]) {
        expect(compose).toContain(`${v}=\${${v}:-}`);
      }
    }
  });
});
