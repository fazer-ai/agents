import { describe, expect, test } from "bun:test";
import {
  getToolpackToolNames,
  getToolpackToolViews,
} from "@/modules/integrations/toolpacks";

// Locks the UI-facing projection: names + args (derived from each tool's zod schema, the single
// source). This is what the integration modal and the agent Tools tab render.

describe("toolpack tool specs (UI projection)", () => {
  test("ASAAS exposes its tools with args derived from zod", () => {
    const views = getToolpackToolViews("ASAAS");
    expect(views.map((v) => v.name).sort()).toEqual([
      "asaas_create_pix_charge",
      "asaas_payment_link_create",
      "asaas_payment_status",
    ]);
    const pix = views.find((v) => v.name === "asaas_create_pix_charge");
    const value = pix?.args.find((a) => a.name === "value");
    expect(value).toMatchObject({ required: true });
    expect(value?.description).toContain("BRL");
    // optional args report required: false (mirrors how MCP optional args show).
    const mobile = pix?.args.find((a) => a.name === "mobilePhone");
    expect(mobile?.required).toBe(false);
  });

  test("asaas_payment_status exposes paymentId + paymentLinkId, both optional", () => {
    const views = getToolpackToolViews("ASAAS");
    const status = views.find((v) => v.name === "asaas_payment_status");
    expect(status?.args.map((a) => a.name)).toEqual([
      "paymentId",
      "paymentLinkId",
    ]);
    expect(status?.args.every((a) => a.required === false)).toBe(true);
    expect(
      status?.args.find((a) => a.name === "paymentId")?.description,
    ).toContain("pay_");
    expect(
      status?.args.find((a) => a.name === "paymentLinkId")?.description,
    ).toContain("link");
  });

  test("getToolpackToolNames is the fail-closed allowlist; empty for unknown/native", () => {
    expect(getToolpackToolNames("ASAAS")).toContain("asaas_create_pix_charge");
    expect(getToolpackToolNames("GOOGLE_DRIVE")).toEqual([
      "drive_find_file",
      "drive_send_file",
    ]);
    expect(getToolpackToolNames("NOPE")).toEqual([]);
  });

  test("calendar exposes the optional calendarId arg with its description", () => {
    const views = getToolpackToolViews("GOOGLE_CALENDAR");
    const list = views.find((v) => v.name === "calendar_list_events");
    const cal = list?.args.find((a) => a.name === "calendarId");
    expect(cal?.required).toBe(false);
    expect(cal?.description?.toLowerCase()).toContain("calendar");
  });
});
