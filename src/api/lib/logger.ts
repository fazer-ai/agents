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

// NOTE: In production, avoid pino transports (which use thread-stream worker threads)
// because the compiled binary's virtual FS prevents resolving packages like real-require.
// Write JSON to stdout instead — Docker/Coolify captures stdout natively.
let logger = pino(
  config.env === "production"
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
