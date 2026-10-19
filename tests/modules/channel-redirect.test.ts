import { describe, expect, test } from "bun:test";
import {
  buildWidgetUrl,
  classifyWidgetHealth,
  normalizeWebsiteUrl,
} from "@/modules/channel-redirect/link";
import {
  CHANNEL_REDIRECT_DEFAULTS,
  isRedirectEntryInbox,
  readChannelRedirectConfig,
  redirectDelayMinutes,
  shouldSendRedirect,
} from "@/modules/channel-redirect/service";
import { parseFollowUpStep } from "@/modules/followups/settings";

const NOW = new Date("2026-07-05T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("readChannelRedirectConfig", () => {
  test("defaults when absent or non-object", () => {
    expect(readChannelRedirectConfig(undefined)).toEqual(
      CHANNEL_REDIRECT_DEFAULTS,
    );
    expect(readChannelRedirectConfig({ channelRedirect: {} })).toEqual(
      CHANNEL_REDIRECT_DEFAULTS,
    );
    expect(readChannelRedirectConfig({ channelRedirect: 7 })).toEqual(
      CHANNEL_REDIRECT_DEFAULTS,
    );
  });

  test("reads + clamps numeric fields", () => {
    const c = readChannelRedirectConfig({
      channelRedirect: {
        enabled: true,
        entryInboxId: 12,
        widgetInboxId: 34,
        resendDelayValue: 999999,
        resendDelayUnit: "hours",
        maxResends: -5,
        chatFollowupDelayValue: 0,
        waFollowupDelayValue: 999999,
      },
    });
    expect(c.enabled).toBe(true);
    expect(c.entryInboxId).toBe(12);
    expect(c.widgetInboxId).toBe(34);
    // A delay is clamped in its own unit, 30 days at most: 720 hours, 43200 minutes.
    expect(c.resendDelayValue).toBe(720);
    expect(c.resendDelayUnit).toBe("hours");
    expect(c.maxResends).toBe(0); // clamp 0..10
    expect(c.chatFollowupDelayValue).toBe(1);
    expect(c.waFollowupDelayValue).toBe(43_200);
  });

  // The default is a number of minutes, so a stored unit with no value reads at most that unit's ceiling.
  test("a unit stored without its value reads the default within the unit's range", () => {
    const c = readChannelRedirectConfig({
      channelRedirect: { resendDelayUnit: "days", closingDelayUnit: "days" },
    });
    expect(c.resendDelayValue).toBeLessThanOrEqual(30);
    expect(c.closingDelayValue).toBeLessThanOrEqual(30);
  });

  test("falls back to the default unit for an invalid delay unit", () => {
    const c = readChannelRedirectConfig({
      channelRedirect: { chatFollowupDelayUnit: "weeks" },
    });
    expect(c.chatFollowupDelayUnit).toBe(
      CHANNEL_REDIRECT_DEFAULTS.chatFollowupDelayUnit,
    );
  });

  test("rejects invalid inbox refs (non-positive / non-integer)", () => {
    const c = readChannelRedirectConfig({
      channelRedirect: { entryInboxId: 0, widgetInboxId: 1.5 },
    });
    expect(c.entryInboxId).toBeNull();
    expect(c.widgetInboxId).toBeNull();
  });
});

describe("isRedirectEntryInbox", () => {
  const base = { ...CHANNEL_REDIRECT_DEFAULTS, enabled: true, entryInboxId: 7 };
  test("true only when enabled + entry set + matching inbox", () => {
    expect(isRedirectEntryInbox(base, 7)).toBe(true);
    expect(isRedirectEntryInbox(base, 8)).toBe(false);
    expect(isRedirectEntryInbox({ ...base, enabled: false }, 7)).toBe(false);
    expect(isRedirectEntryInbox({ ...base, entryInboxId: null }, 7)).toBe(
      false,
    );
  });
});

describe("shouldSendRedirect", () => {
  const cfg = {
    ...CHANNEL_REDIRECT_DEFAULTS,
    resendDelayValue: 6,
    resendDelayUnit: "hours" as const,
    maxResends: 1,
  };
  test("first contact (never sent) → send", () => {
    expect(shouldSendRedirect(cfg, null, 0, NOW)).toBe(true);
  });
  test("within cooldown → silent", () => {
    expect(shouldSendRedirect(cfg, hoursAgo(1), 1, NOW)).toBe(false);
  });
  test("past cooldown + resend budget left → re-send", () => {
    expect(shouldSendRedirect(cfg, hoursAgo(7), 1, NOW)).toBe(true);
  });
  test("resend budget exhausted → silent even past cooldown", () => {
    expect(shouldSendRedirect(cfg, hoursAgo(48), 2, NOW)).toBe(false);
  });
});

describe("redirectDelayMinutes", () => {
  test("converts value + unit to minutes, clamped to [1, 43200]", () => {
    expect(redirectDelayMinutes(15, "minutes")).toBe(15);
    expect(redirectDelayMinutes(2, "hours")).toBe(120);
    expect(redirectDelayMinutes(1, "days")).toBe(1440);
    expect(redirectDelayMinutes(0, "minutes")).toBe(1); // clamp low
    expect(redirectDelayMinutes(100, "days")).toBe(43200); // clamp high (30d)
  });
});

describe("buildWidgetUrl", () => {
  const parseFrag = (url: string) =>
    new URLSearchParams(new URL(url).hash.slice(1));

  test("the token rides in the fragment (not the query) with the open flag", () => {
    const url = buildWidgetUrl({
      websiteUrl: "https://cliente.com/atendimento",
      token: "tok_abc123",
      open: true,
    });
    expect(url.startsWith("https://cliente.com/atendimento#")).toBe(true);
    expect(new URL(url).search).toBe(""); // nothing leaked into the query
    const f = parseFrag(url);
    expect(f.get("cw_redirect")).toBe("tok_abc123");
    expect(f.get("cw_open")).toBe("1");
  });

  test("omits cw_open when not set; preserves an existing query", () => {
    const url = buildWidgetUrl({
      websiteUrl: "https://cliente.com/x?utm=abc",
      token: "tok_2",
      open: false,
    });
    expect(new URL(url).search).toBe("?utm=abc");
    const f = parseFrag(url);
    expect(f.get("cw_redirect")).toBe("tok_2");
    expect(f.get("cw_open")).toBeNull();
  });

  test("throws on an invalid website_url", () => {
    expect(() =>
      buildWidgetUrl({ websiteUrl: "not a url", token: "tok_3" }),
    ).toThrow();
  });

  test("recovers a scheme-less website_url by prepending https", () => {
    const url = buildWidgetUrl({
      websiteUrl: "cliente.com/atendimento",
      token: "tok_4",
    });
    expect(url.startsWith("https://cliente.com/atendimento#")).toBe(true);
    expect(parseFrag(url).get("cw_redirect")).toBe("tok_4");
  });
});

describe("normalizeWebsiteUrl", () => {
  test("passes through a valid absolute URL (recovered=false)", () => {
    expect(normalizeWebsiteUrl("https://cliente.com/chat")).toEqual({
      url: "https://cliente.com/chat",
      recovered: false,
    });
  });

  test("prepends https:// to a scheme-less value (recovered=true)", () => {
    expect(normalizeWebsiteUrl("cliente.com/chat")).toEqual({
      url: "https://cliente.com/chat",
      recovered: true,
    });
  });

  test("returns null for empty or unparseable values", () => {
    expect(normalizeWebsiteUrl("")).toBeNull();
    expect(normalizeWebsiteUrl("   ")).toBeNull();
    expect(normalizeWebsiteUrl(null)).toBeNull();
    expect(normalizeWebsiteUrl("not a url")).toBeNull();
    expect(normalizeWebsiteUrl("ftp://cliente.com")).toBeNull();
  });
});

describe("classifyWidgetHealth", () => {
  test("unreachable Chatwoot is 'unknown', never a false 'invalid'", () => {
    // The bug this guards: a transient outage must not raise "your Website URL is broken".
    expect(classifyWidgetHealth(false, null)).toEqual({
      websiteUrl: null,
      status: "unknown",
    });
  });

  test("fetched but no website_url set is 'missing'", () => {
    expect(classifyWidgetHealth(true, null)).toEqual({
      websiteUrl: null,
      status: "missing",
    });
    expect(classifyWidgetHealth(true, "")).toEqual({
      websiteUrl: null,
      status: "missing",
    });
  });

  test("fetched valid absolute URL is 'ok'", () => {
    expect(classifyWidgetHealth(true, "https://cliente.com/chat")).toEqual({
      websiteUrl: "https://cliente.com/chat",
      status: "ok",
    });
  });

  test("fetched scheme-less URL is 'recovered' (runtime repairs it)", () => {
    expect(classifyWidgetHealth(true, "cliente.com/chat")).toEqual({
      websiteUrl: "cliente.com/chat",
      status: "recovered",
    });
  });

  test("fetched unrepairable URL is 'invalid'", () => {
    expect(classifyWidgetHealth(true, "ftp://cliente.com")).toEqual({
      websiteUrl: "ftp://cliente.com",
      status: "invalid",
    });
  });
});

// Same for a follow-up step: the default is minutes, so a step naming only `days` reads within 30 days.
test("a follow-up step with a unit and no value reads within the unit's range", () => {
  expect(parseFollowUpStep({ delayUnit: "days" })?.delayValue).toBe(30);
});
