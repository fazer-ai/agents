import { describe, expect, test } from "bun:test";
import { Prisma } from "@/../generated/prisma/client";
import {
  isForeignKeyViolation,
  isUniqueViolation,
  violatedConstraintOf,
} from "@/lib/pg-error";

// The two shapes a violation arrives in through `@prisma/adapter-pg`: converted, with Prisma's code
// and the adapter's detail, and unconverted, with the SQLSTATE as the code and the server's message.
function converted(code: "P2002" | "P2003", sqlstate: string, index: string) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code,
    clientVersion: "7.10.0",
    meta: {
      modelName: "Tenant",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: sqlstate,
          originalMessage: `violates constraint "${index}"`,
          kind:
            code === "P2002"
              ? "UniqueConstraintViolation"
              : "ForeignKeyConstraintViolation",
          constraint: { index },
        },
      },
    },
  });
}

function unconverted(sqlstate: string, message: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`prisma.tenant.create()\` invocation:\n\n\n${message}`,
    { code: sqlstate, clientVersion: "7.10.0", meta: { modelName: "Tenant" } },
  );
}

const UNIQUE_CONVERTED = converted("P2002", "23505", "tenants_slug_key");
const UNIQUE_RAW = unconverted(
  "23505",
  'duplicate key value violates unique constraint "tenants_slug_key"',
);
const FK_CONVERTED = converted(
  "P2003",
  "23503",
  "inbox_observers_agent_id_fkey",
);
const FK_RAW = unconverted(
  "23503",
  'insert or update on table "inbox_observers" violates foreign key constraint "inbox_observers_agent_id_fkey"',
);

describe("a constraint violation, in either shape", () => {
  test.each([
    ["converted", UNIQUE_CONVERTED],
    ["unconverted", UNIQUE_RAW],
  ])("a unique violation is one, and not a foreign key (%s)", (_, error) => {
    expect(isUniqueViolation(error)).toBe(true);
    expect(isForeignKeyViolation(error)).toBe(false);
    expect(violatedConstraintOf(error)).toBe("tenants_slug_key");
  });

  test.each([
    ["converted", FK_CONVERTED],
    ["unconverted", FK_RAW],
  ])(
    "a foreign-key violation is one, and not a unique one (%s)",
    (_, error) => {
      expect(isForeignKeyViolation(error)).toBe(true);
      expect(isUniqueViolation(error)).toBe(false);
      expect(violatedConstraintOf(error)).toBe("inbox_observers_agent_id_fkey");
    },
  );

  test("the adapter's own error, before Prisma wraps it, reads the same", () => {
    const adapter = Object.assign(new Error("DriverAdapterError"), {
      name: "DriverAdapterError",
      cause: {
        originalCode: "23505",
        kind: "UniqueConstraintViolation",
        constraint: { fields: ["tenant_id", "name"] },
      },
    });
    expect(isUniqueViolation(adapter)).toBe(true);
    expect(violatedConstraintOf(adapter)).toBe("tenant_id,name");
  });

  test.each([
    ["record not found (P2025)", unconverted("P2025", "No record was found")],
    [
      "a not-null violation (23502)",
      unconverted(
        "23502",
        'null value in column "name" violates not-null constraint',
      ),
    ],
    ["a plain error", new Error("boom")],
    ["null", null],
    ["a string", "P2002"],
  ])(
    "anything else is neither, and reading it does not throw (%s)",
    (_, error) => {
      expect(isUniqueViolation(error)).toBe(false);
      expect(isForeignKeyViolation(error)).toBe(false);
    },
  );
});
