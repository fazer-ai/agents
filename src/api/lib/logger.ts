import path, { join } from "node:path";
import pino from "pino";
import type { PrettyOptions } from "pino-pretty";
import config from "@/config";
import { clipText } from "@/lib/text";

function omitKeys(
  obj: Record<string, unknown>,
  isSecret: (key: string, value: unknown) => boolean,
) {
  for (const key in obj) {
    if (isSecret(key, obj[key])) {
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
  isSecret?: (key: string, value: unknown) => boolean;
}

export function deepSanitizeObject(
  obj: Record<string, unknown>,
  options?: DeepSanitizeObjectOptions,
) {
  const output = structuredClone(obj);
  if (options?.isSecret) {
    omitKeys(output, options.isSecret);
  }

  for (const key in output) {
    output[key] = sanitizeItem(output[key], options);
  }

  return output;
}

// A config field is masked in the boot log by its NAME, not by joining a list: a list misses the
// next secret field someone adds, and the log prints it. Only strings are masked, so a flag like `setupTokenRequired` stays readable.
const SECRET_CONFIG_KEY = /secret|token|password|key|databaseurl/i;

export function configForBootLog(cfg: Record<string, unknown>) {
  return deepSanitizeObject(cfg, {
    isSecret: (key, value) =>
      typeof value === "string" && SECRET_CONFIG_KEY.test(key),
  });
}

// A pino transport (a thread-stream WORKER THREAD, the only Worker in this codebase) runs only in
// `development`, not in "not production": a compiled binary's virtual FS cannot resolve packages like
// real-require (and Docker/Coolify capture stdout as JSON anyway), and `bun test` sets NODE_ENV=test,
// where the worker makes `bun test --parallel` processes die with `the worker thread exited`.
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
