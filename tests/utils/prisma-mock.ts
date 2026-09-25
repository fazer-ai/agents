import { mock } from "bun:test";
import type { UserRole } from "@/../generated/prisma/client";

export interface MockUserEntity {
  id: bigint;
  tenantId: bigint | null;
  email: string;
  passwordHash: string | null;
  googleId: string | null;
  name: string | null;
  role: UserRole;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const mockUser: MockUserEntity = {
  id: BigInt(1),
  tenantId: BigInt(1),
  email: "test@example.com",
  passwordHash: "$2b$10$hashedpassword",
  googleId: null,
  name: null,
  role: "AGENT",
  lastLoginAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

export interface MockTenantEntity {
  id: bigint;
}

export const mockTenant: MockTenantEntity = { id: BigInt(1) };

export type MockUser = MockUserEntity | null;
export type MockTenant = MockTenantEntity | null;

export const mockFindFirst = mock<() => Promise<MockUser>>();
export const mockFindUnique = mock<() => Promise<MockUser>>();
export const mockCreate = mock<() => Promise<MockUserEntity>>();
export const mockUpdate = mock<() => Promise<MockUserEntity>>();
export const mockUpdateMany = mock<() => Promise<{ count: number }>>();
export const mockCount = mock<() => Promise<number>>();
export const mockTenantFindFirst = mock<() => Promise<MockTenant>>();
export const mockTenantCreate = mock<() => Promise<MockTenantEntity>>();
export const mockQueryRaw =
  mock<() => Promise<Array<Record<string, number>>>>();
export const mockExecuteRaw = mock<() => Promise<number>>();

// NOTE: one place to keep the default async return values so declarations
// and `resetPrismaMocks` can't drift out of sync. `mockReset()` clears the
// impl, which would leave the mock returning `undefined` and silently break
// any test that relied on the default.
function applyDefaultPrismaMockImplementations() {
  mockFindFirst.mockImplementation(() => Promise.resolve(null as MockUser));
  mockFindUnique.mockImplementation(() => Promise.resolve(null as MockUser));
  mockCreate.mockImplementation(() => Promise.resolve(mockUser));
  mockUpdate.mockImplementation(() => Promise.resolve(mockUser));
  mockUpdateMany.mockImplementation(() => Promise.resolve({ count: 1 }));
  mockCount.mockImplementation(() => Promise.resolve(0));
  mockTenantFindFirst.mockImplementation(() => Promise.resolve(mockTenant));
  mockTenantCreate.mockImplementation(() => Promise.resolve(mockTenant));
  mockQueryRaw.mockImplementation(() => Promise.resolve([{ 1: 1 }]));
  mockExecuteRaw.mockImplementation(() => Promise.resolve(1));
}

applyDefaultPrismaMockImplementations();

// THE ENTITY KEEPS THE SESSION'S SHAPE, one tenant and one role, because that is what every test
// states ("an admin of tenant 1", "a fleet administrator"). The schema stores it as a PERSON with a
// membership per tenant (issue #756), so the reads the code makes are answered in that shape: the
// fleet role becomes `isSuperAdmin`, and a tenant role becomes the one membership. The mock functions
// themselves stay what the tests configure and assert on.
export interface MockPersonRow
  extends Omit<MockUserEntity, "role" | "tenantId"> {
  isSuperAdmin: boolean;
  memberships: { tenantId: bigint; role: UserRole; createdAt: Date }[];
}

export function asPersonRow(entity: MockUserEntity): MockPersonRow;
export function asPersonRow(
  entity: MockUserEntity | null | undefined,
): MockPersonRow | null | undefined;
export function asPersonRow(
  entity: MockUserEntity | null | undefined,
): MockPersonRow | null | undefined {
  if (!entity) return entity;
  const { tenantId, role, ...person } = entity;
  const isSuperAdmin = role === "SUPER_ADMIN";
  return {
    ...person,
    isSuperAdmin,
    memberships:
      isSuperAdmin || tenantId === null
        ? []
        : [{ tenantId, role, createdAt: entity.createdAt }],
  };
}

const personRead =
  <A extends unknown[]>(fn: (...args: A) => Promise<MockUser>) =>
  async (...args: A) =>
    asPersonRow(await fn(...args));

interface PrismaMockClient {
  user: {
    findFirst: (...args: unknown[]) => Promise<unknown>;
    findUnique: (...args: unknown[]) => Promise<unknown>;
    create: (...args: unknown[]) => Promise<unknown>;
    update: (...args: unknown[]) => Promise<unknown>;
    updateMany: typeof mockUpdateMany;
    count: typeof mockCount;
  };
  tenant: {
    findFirst: typeof mockTenantFindFirst;
    create: typeof mockTenantCreate;
  };
  $queryRaw: typeof mockQueryRaw;
  $executeRaw: typeof mockExecuteRaw;
  $transaction: <T>(fn: (tx: PrismaMockClient) => Promise<T>) => Promise<T>;
  $extends: () => PrismaMockClient;
}

export const prismaMock: PrismaMockClient = {
  user: {
    findFirst: personRead(
      mockFindFirst as (...a: unknown[]) => Promise<MockUser>,
    ),
    findUnique: personRead(
      mockFindUnique as (...a: unknown[]) => Promise<MockUser>,
    ),
    create: personRead(mockCreate as (...a: unknown[]) => Promise<MockUser>),
    update: personRead(mockUpdate as (...a: unknown[]) => Promise<MockUser>),
    updateMany: mockUpdateMany,
    count: mockCount,
  },
  tenant: {
    findFirst: mockTenantFindFirst,
    create: mockTenantCreate,
  },
  $queryRaw: mockQueryRaw,
  $executeRaw: mockExecuteRaw,
  // NOTE: Interactive-transaction form only: invoke the callback with the same
  // mock client so `tx.user.*` / `tx.tenant.*` / `tx.$executeRaw` route to the shared mocks.
  $transaction: (fn) => fn(prismaMock),
  // NOTE: closure-bound tenant extension is a no-op in the mock; the extended client is
  // the same mock so `.$transaction` still routes to the shared mocks.
  $extends: () => prismaMock,
};

export function setupPrismaMock() {
  mock.module("@/api/lib/prisma", () => ({
    default: prismaMock,
  }));
}

export function resetPrismaMocks() {
  mockFindFirst.mockReset();
  mockFindUnique.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockUpdateMany.mockReset();
  mockCount.mockReset();
  mockTenantFindFirst.mockReset();
  mockTenantCreate.mockReset();
  mockQueryRaw.mockReset();
  mockExecuteRaw.mockReset();
  applyDefaultPrismaMockImplementations();
}
