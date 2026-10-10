import { beforeEach, describe, expect, test } from "bun:test";
import {
  adoptSessionTenant,
  dropRejectedSelection,
  getActiveTenantId,
  pinTabTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";

// With a person able to belong to several tenants, choosing one in one tab must not move the
// others. The selection lives in the TAB (sessionStorage); the last choice is only the starting
// point of a new tab (localStorage), and a tab keeps what it started with.

const KEY = "@app:active-tenant";

describe("the selected tenant is the tab's", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  test("a choice is kept by this tab and becomes the next tab's default", () => {
    setActiveTenantId("7");
    expect(sessionStorage.getItem(KEY)).toBe("7");
    expect(localStorage.getItem(KEY)).toBe("7");
    expect(getActiveTenantId()).toBe("7");
  });

  test("a new tab starts from the last choice, and keeps it when another tab chooses", () => {
    localStorage.setItem(KEY, "3");
    // First read in a fresh tab: inherits, and pins it to the tab.
    expect(getActiveTenantId()).toBe("3");
    expect(sessionStorage.getItem(KEY)).toBe("3");
    // Another tab chooses: only the shared default moves.
    localStorage.setItem(KEY, "9");
    expect(getActiveTenantId()).toBe("3");
  });

  test("a refused selection is dropped from the tab and from the default", () => {
    setActiveTenantId("8");
    expect(dropRejectedSelection("8")).toBe(true);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getActiveTenantId()).toBeNull();
  });

  // NOTE: a member's first tab runs under the default membership with nothing stored, and until it
  // holds that id it would inherit whatever another tab chooses next. The session pins it to the
  // tab, and only to the tab: it is not a choice, so it is not the next tab's default.
  test("the tenant the session resolved is pinned to the tab, and to the tab only", () => {
    pinTabTenantId("6");
    expect(sessionStorage.getItem(KEY)).toBe("6");
    expect(localStorage.getItem(KEY)).toBeNull();
    localStorage.setItem(KEY, "9");
    expect(getActiveTenantId()).toBe("6");
  });

  test("pinning never overrides the tab's own choice", () => {
    sessionStorage.setItem(KEY, "4");
    pinTabTenantId("6");
    expect(getActiveTenantId()).toBe("4");
  });

  // What a fresh session does to the tab (src/client/contexts/AuthContext.tsx, after /auth/me).
  test("a person's session pins the tenant it ran under, and only to this tab", () => {
    adoptSessionTenant({ role: "AGENT", tenantId: "6" }, null);
    expect(sessionStorage.getItem(KEY)).toBe("6");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("a fleet administrator with nothing selected opens on the default tenant", () => {
    adoptSessionTenant({ role: "SUPER_ADMIN", tenantId: null }, "2");
    expect(getActiveTenantId()).toBe("2");
    expect(localStorage.getItem(KEY)).toBe("2");
  });

  test("a fleet administrator's deliberate choice is never overridden", () => {
    setActiveTenantId("5");
    adoptSessionTenant({ role: "SUPER_ADMIN", tenantId: null }, "2");
    expect(getActiveTenantId()).toBe("5");
  });
});

// Every API call reads the selection for its X-Tenant-Id header, so a browser that blocks site data
// (touching either store throws) must read as "nothing selected", not fail every request. A store
// that exists but refuses a write still fails loudly, and so does an explicit choice: a selection
// that silently is not kept would leave this tab on the shared default another tab moves, or reload
// a tenant switch forever.
describe("storage the browser refuses", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  const blocked = () => {
    throw new DOMException("blocked", "SecurityError");
  };

  function withStores(
    session: PropertyDescriptor,
    local: PropertyDescriptor,
    run: () => void,
  ) {
    const s = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    const l = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      ...session,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      ...local,
    });
    try {
      run();
    } finally {
      if (s) Object.defineProperty(globalThis, "sessionStorage", s);
      if (l) Object.defineProperty(globalThis, "localStorage", l);
    }
  }

  test("site data blocked: nothing is selected, the session's pins are skipped, a choice throws", () => {
    withStores({ get: blocked }, { get: blocked }, () => {
      expect(getActiveTenantId()).toBeNull();
      expect(() => pinTabTenantId("7")).not.toThrow();
      expect(() =>
        adoptSessionTenant({ role: "SUPER_ADMIN", tenantId: null }, "7"),
      ).not.toThrow();
      expect(() =>
        adoptSessionTenant({ role: "TENANT_ADMIN", tenantId: "7" }, null),
      ).not.toThrow();
      expect(getActiveTenantId()).toBeNull();
      expect(() => setActiveTenantId("7")).toThrow();
    });
  });

  test("a store whose reads throw reads as nothing selected; its writes still throw", () => {
    const refusing = {
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
    } as unknown as Storage;
    withStores({ value: refusing }, { value: refusing }, () => {
      expect(getActiveTenantId()).toBeNull();
      expect(() => pinTabTenantId("7")).toThrow();
      expect(() => setActiveTenantId("7")).toThrow();
    });
  });

  test("a tab store that refuses the pin fails loudly instead of following the shared default", () => {
    const tabRefusingWrites = {
      getItem: () => null,
      setItem: blocked,
      removeItem: blocked,
    } as unknown as Storage;
    localStorage.setItem(KEY, "3");
    const l = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    withStores({ value: tabRefusingWrites }, l ?? {}, () => {
      expect(() => getActiveTenantId()).toThrow();
    });
  });
});
