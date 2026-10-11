import { beforeEach, describe, expect, test } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { Elysia } from "elysia";
import config from "@/config";
import {
  mockQueryRaw,
  resetPrismaMocks,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

setupPrismaMock();

const { healthController } = await import(
  "@/api/features/health/health.controller"
);

const createTestClient = () => {
  const app = new Elysia().use(healthController);
  return treaty(app);
};

describe("healthController", () => {
  beforeEach(() => {
    resetPrismaMocks();
  });

  describe("GET /health", () => {
    test("returns ok status when database is healthy", async () => {
      mockQueryRaw.mockResolvedValueOnce([{ 1: 1 }]);

      const api = createTestClient();
      const response = await api.health.get();

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty("status", "ok");
      expect(response.data).toHaveProperty("db");
      expect(response.data?.db).toHaveProperty("ok", true);
    });

    test("returns degraded status when database is unhealthy", async () => {
      mockQueryRaw.mockRejectedValueOnce(new Error("Connection failed"));

      const api = createTestClient();
      const response = await api.health.get();

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty("status", "degraded");
      expect(response.data?.db).toHaveProperty("ok", false);
      expect(response.data?.db).toHaveProperty("error");
    });

    test("includes package info in response", async () => {
      mockQueryRaw.mockResolvedValueOnce([{ 1: 1 }]);

      const api = createTestClient();
      const response = await api.health.get();

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        name: config.packageInfo.name,
        version: config.packageInfo.version,
      });
    });
  });
});
