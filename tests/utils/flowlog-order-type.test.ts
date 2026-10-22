import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { flowLogRow, flowLogRows } from "@/tests/utils/flowlog";

// A flow-log read with no order passes or fails on the plan Postgres picks, so the readers refuse one
// at compile time. The function below is never run; each `@ts-expect-error` fails the typecheck the
// day the reader accepts a read with no order again.
function readsWithoutAnOrderDoNotCompile(db: PrismaClient) {
  // @ts-expect-error: several lines, no order.
  void flowLogRows(db, { where: { turnId: "t" } });
  // @ts-expect-error: the first of several lines, no order.
  void flowLogRow(db, { where: { turnId: "t" } });
  // NOTE: the control: the same reads with an order compile, so the errors above are about the order.
  void flowLogRows(db, { where: { turnId: "t" }, orderBy: { id: "asc" } });
  void flowLogRow(db, { where: { turnId: "t" }, orderBy: { id: "asc" } });
}
void readsWithoutAnOrderDoNotCompile;

describe("flow-log readers", () => {
  test("are exported for the type checks above", () => {
    expect(typeof flowLogRows).toBe("function");
    expect(typeof flowLogRow).toBe("function");
  });
});
