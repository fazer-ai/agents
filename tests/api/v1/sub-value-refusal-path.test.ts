import { describe, expect, test } from "bun:test";
import type { TenantContext } from "@/lib/tenancy";

// A service that parses one member of the request names the refused field from the request's root:
// zod's path is relative to what was handed to the parse, so without the prefix a bad variant reports
// `1.weight` and a lone token no field at all, which no input on the caller's side answers to.

describe("a refusal about a value inside the request names the whole path", () => {
  // Each service is called with a bad member; the parse runs before the service opens a
  // transaction, so no database is reached.
  test("the services that parse a sub-value name it from the request's root", async () => {
    const { createExperiment, updateExperiment } = await import(
      "@/modules/experiments/service"
    );
    const { rotateChatwootDeploymentToken } = await import(
      "@/modules/chatwoot/management"
    );
    const ctx = { tenantId: 1n } as unknown as TenantContext;
    const bad = [
      { key: "a", weight: 1 },
      { key: "b", weight: -1 },
    ];
    const refusalOf = async (call: () => Promise<unknown>) => {
      try {
        await call();
      } catch (e) {
        const err = e as { field?: string; statusCode?: number };
        return [err.statusCode, err.field];
      }
      return "not refused";
    };
    expect({
      create: await refusalOf(() =>
        createExperiment({ ctx, name: "e", variants: bad }),
      ),
      update: await refusalOf(() =>
        updateExperiment({ ctx, id: 1n, variants: bad }),
      ),
      token: await refusalOf(() => rotateChatwootDeploymentToken(ctx, "")),
    }).toEqual({
      create: [422, "variants.1.weight"],
      update: [422, "variants.1.weight"],
      token: [422, "adminToken"],
    });
  });
});
