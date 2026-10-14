import { Prisma, type PrismaClient } from "@/../generated/prisma/client";

// The shape a constraint violation reached its caller in on CI: a known request error whose `code`
// is the Postgres SQLSTATE and whose message is the server's, with no adapter detail in `meta`.
// Built from a real violation, so the SQLSTATE and the message are the database's own.
export function asRawViolation(error: unknown): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return error;
  const meta = error.meta as
    | {
        modelName?: string;
        driverAdapterError?: {
          cause?: { originalCode?: string; originalMessage?: string };
        };
      }
    | undefined;
  const cause = meta?.driverAdapterError?.cause;
  const sqlstate = cause?.originalCode;
  if (sqlstate !== "23505" && sqlstate !== "23503") return error;
  return new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`prisma\` invocation:\n\n\n${cause?.originalMessage ?? ""}`,
    {
      code: sqlstate,
      clientVersion: error.clientVersion,
      meta: { modelName: meta?.modelName },
    },
  );
}

// `client`, with every operation's constraint violation rethrown in that shape.
export function withRawViolations(client: PrismaClient): PrismaClient {
  return client.$extends({
    query: {
      async $allOperations({ args, query }) {
        try {
          return await query(args);
        } catch (error) {
          throw asRawViolation(error);
        }
      },
    },
  }) as unknown as PrismaClient;
}

// The two shapes a race test runs in.
export const VIOLATION_SHAPES: [string, (c: PrismaClient) => PrismaClient][] = [
  ["converted (P2002/P2003)", (c) => c],
  ["unconverted (the Postgres SQLSTATE)", withRawViolations],
];
