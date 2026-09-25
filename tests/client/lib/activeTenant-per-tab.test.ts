import { beforeEach, describe, expect, test } from "bun:test";
import {
  adoptSessionTenant,
  dropRejectedSelection,
  getActiveTenantId,
  pinTabTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";

// Issue #756: with a person able to belong to several tenants, choosing one in one tab must not move
// the others. The selection lives in the TAB (sessionStorage); the last choice is only the starting
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

  test("the tab's own choice wins over the shared default", () => {
    sessionStorage.setItem(KEY, "4");
    localStorage.setItem(KEY, "5");
    expect(getActiveTenantId()).toBe("4");
  });

  test("a refused selection is dropped from the tab and from the default", () => {
    setActiveTenantId("8");
    expect(dropRejectedSelection("8")).toBe(true);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getActiveTenantId()).toBeNull();
  });

  // Review round 1: a member's first tab runs under the default membership with nothing stored, and
  // until it holds that id it would inherit whatever another tab chooses next. The session pins it to
  // the tab, and only to the tab: it is not a choice, so it is not the next tab's default.
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
