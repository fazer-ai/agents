import { inRange } from "@/lib/number-range";
import {
  CHANNEL_REDIRECT_RANGES,
  delayRange,
} from "@/modules/agents/number-ranges";
import {
  CHANNEL_REDIRECT_DEFAULTS,
  type ChannelRedirectConfig,
} from "@/modules/channel-redirect/service";
import type { ChannelRedirectFormState } from "./ChannelRedirectTab";

type DelayPrefix = "resend" | "chatFollowup" | "waFollowup" | "closing";

function intFieldOr(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Serialize the channelRedirect form back to the config shape, parsing defensively so a cleared input
// persists the default, not NaN. A number drawn out of its range holds Save, so one out of range here
// is under a switch that is off: it goes back as `stored` has it, since the server refuses it.
export function fromChannelRedirectForm(
  f: ChannelRedirectFormState,
  stored: unknown,
): ChannelRedirectConfig {
  const D = CHANNEL_REDIRECT_DEFAULTS;
  const was =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {};
  // A delay goes back whole, as stored or as the default: the stored value under the typed unit could
  // be out of range itself, and so could the default value under it.
  const delay = <P extends DelayPrefix>(
    prefix: P,
    text: string,
    unit: ChannelRedirectConfig[`${P}DelayUnit`],
  ): Pick<ChannelRedirectConfig, `${P}DelayValue` | `${P}DelayUnit`> => {
    const [valueKey, unitKey] = [
      `${prefix}DelayValue`,
      `${prefix}DelayUnit`,
    ] as const;
    const value = intFieldOr(text, D[valueKey]);
    const pair = inRange(value, delayRange(unit))
      ? { [valueKey]: value, [unitKey]: unit }
      : typeof was[valueKey] === "number"
        ? { [valueKey]: was[valueKey], [unitKey]: was[unitKey] ?? D[unitKey] }
        : { [valueKey]: D[valueKey], [unitKey]: D[unitKey] };
    return pair as Pick<
      ChannelRedirectConfig,
      `${P}DelayValue` | `${P}DelayUnit`
    >;
  };
  return {
    enabled: f.enabled,
    entryInboxId: f.entryInboxId ? intFieldOr(f.entryInboxId, 0) || null : null,
    widgetInboxId: f.widgetInboxId,
    redirectMessage: f.redirectMessage,
    ...delay("resend", f.resendDelayValue, f.resendDelayUnit),
    maxResends: inRange(
      intFieldOr(f.maxResends, D.maxResends),
      CHANNEL_REDIRECT_RANGES.maxResends,
    )
      ? intFieldOr(f.maxResends, D.maxResends)
      : typeof was.maxResends === "number"
        ? was.maxResends
        : D.maxResends,
    openWidget: f.openWidget,
    cloneWaMessage: f.cloneWaMessage,
    chatFollowupEnabled: f.chatFollowupEnabled,
    ...delay("chatFollowup", f.chatFollowupDelayValue, f.chatFollowupDelayUnit),
    chatFollowupInstructions: f.chatFollowupInstructions,
    waFollowupEnabled: f.waFollowupEnabled,
    ...delay("waFollowup", f.waFollowupDelayValue, f.waFollowupDelayUnit),
    waFollowupMessage: f.waFollowupMessage,
    closingEnabled: f.closingEnabled,
    ...delay("closing", f.closingDelayValue, f.closingDelayUnit),
    closingMessage: f.closingMessage,
  };
}
