import { useTranslation } from "react-i18next";
import type { PlaygroundUsage } from "./usePlaygroundChat";

// What a turn (or the whole session) spent, as the provider reported it (issue #839). The cached
// share is always said, as a part OF the input and never subtracted from it: `cachedReadTokens` is a
// discounted subset, and it is the number a prompt change can zero without anything else moving. A
// cache write (Anthropic's premium) only shows when there was one. Nothing renders for a turn that
// made no model call: a zero line would read as a measurement.
export function usageText(
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string,
  locale: string,
  usage: PlaygroundUsage,
): string {
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const parts = [
    t("playground.usage.input", "In {{input}} ({{cached}} from cache)", {
      input: n(usage.promptTokens),
      cached: n(usage.cachedReadTokens),
    }),
  ];
  if (usage.cacheCreationTokens > 0) {
    parts.push(
      t("playground.usage.cacheWrite", "cache write {{written}}", {
        written: n(usage.cacheCreationTokens),
      }),
    );
  }
  parts.push(
    t("playground.usage.output", "out {{output}}", {
      output: n(usage.completionTokens),
    }),
    t("playground.usage.calls", "{{count}} calls", { count: usage.calls }),
  );
  return parts.join(" · ");
}

export function UsageLine({
  usage,
  label,
}: {
  usage: PlaygroundUsage | undefined;
  // Prefixes the line (the session total says whose it is; a turn's line needs no name).
  label?: string;
}) {
  const { t, i18n } = useTranslation();
  if (!usage || usage.calls === 0) return null;
  const text = usageText(
    t as (k: string, f: string, o?: Record<string, unknown>) => string,
    i18n.language,
    usage,
  );
  return (
    <p
      className="text-text-muted text-xs tabular-nums"
      data-testid="playground-usage"
    >
      {label ? `${label}: ${text}` : text}
    </p>
  );
}
