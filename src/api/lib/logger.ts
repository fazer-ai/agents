import path, { join } from "node:path";
import pino from "pino";
import type { PrettyOptions } from "pino-pretty";
import config from "@/config";
import { clipText } from "@/lib/text";

function omitKeys(obj: Record<string, unknown>, keys: string[]) {
  for (const key in obj) {
    if (keys.includes(key)) {
      obj[key] = "********";
    }
  }
}

function sanitizeItem(
  item: unknown,
  options?: DeepSanitizeObjectOptions,
): unknown {
  if (typeof item === "string") {
    return `${clipText(item, 50)}${item.length > 50 ? "…" : ""}`;
  }
  if (Array.isArray(item)) {
    return item.map((i) => sanitizeItem(i, options));
  }
  if (typeof item === "object") {
    return deepSanitizeObject(item as Record<string, unknown>, options);
  }
  return item;
}

interface DeepSanitizeObjectOptions {
  omitKeys?: string[];
}

export function deepSanitizeObject(
  obj: Record<string, unknown>,
  options?: DeepSanitizeObjectOptions,
) {
  const output = structuredClone(obj);
  if (options?.omitKeys) {
    omitKeys(output, options.omitKeys);
  }

  for (const key in output) {
    output[key] = sanitizeItem(output[key], options);
  }

  return output;
}

// A PINO TRANSPORT IS FOR A HUMAN WATCHING A TERMINAL, AND ONLY DEVELOPMENT HAS ONE.
//
// The condition is on `development` rather than on `not production`, and that is the whole of what
// this note is about. A transport runs in a thread-stream WORKER THREAD, and the two contexts that
// are not development each break on that worker for their own reason:
//
//   - production: the compiled binary's virtual FS cannot resolve packages like real-require, which is
//     why this branch existed already. Docker/Coolify capture stdout natively, so plain JSON is
//     what a deployment wants anyway.
//   - test: `bun test` sets NODE_ENV=test (it overrides `.env`; see the note on `config.env`), so
//     `!== "production"` used to be TRUE here and every test process built the worker. Serially that
//     only costs a `logs/log` nobody reads. Under `bun test --parallel` it is fatal: measured on this
//     suite at 18 workers, 229 × `error: the worker thread exited` and 225 failures, with 3207 tests
//     never reaching a runner. Giving each process its OWN roll file changes nothing (measured: still
//     229), so it is the worker, not the file. With this branch taken: 8192 pass, and the run drops
//     from 193.6s to 50.8s at `--parallel=12`.
//
// The same worker has taken this suite down once before by another path: see the MessagePort note
// in tests/dom-setup.ts, where Bun 1.4.0's `new Worker()` cut the suite from 4133 passing to 2096.
// Nothing else in this codebase constructs a Worker; pino's transport was always the only one.
let logger = pino(
  config.env !== "development"
    ? {
        level: config.logLevel,
      }
    : {
        level: "debug",
        transport: {
          targets: [
            {
              level: config.logLevel,
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "SYS:standard",
                mkdir: true,
              } as PrettyOptions,
            },
            {
              level: config.logLevel,
              target: "pino-roll",
              options: {
                file: path.join("logs", "log"),
                size: "50m",
                limit: { count: 10 },
                mkdir: true,
              },
            },
          ],
        },
      },
);

if (config.env === "development") {
  logger = require("pino-caller")(logger, {
    relativeTo: join(__dirname, ".."),
  });
}

export default logger;
