// How the Database screen writes its figures, in the console's language: thousands and decimals by
// the locale, durations in the unit that keeps them short, sizes in binary units.

export interface Formatters {
  number: (n: number) => string;
  ms: (ms: number) => string;
  bytes: (n: number) => string;
  signedBytes: (n: number) => string;
  percent: (pct: number) => string;
  ratio: (r: number) => string;
  relative: (iso: string, now?: number) => string;
  dateTime: (iso: string) => string;
}

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

export function formatters(locale: string): Formatters {
  const int = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const one = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const two = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const rel = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const dt = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium",
  });

  const bytes = (n: number) => {
    let v = Math.abs(n);
    let u = 0;
    while (v >= 1024 && u < BYTE_UNITS.length - 1) {
      v /= 1024;
      u++;
    }
    return `${u === 0 ? int.format(v) : one.format(v)} ${BYTE_UNITS[u]}`;
  };

  return {
    number: (n) => int.format(n),
    ms: (ms) => {
      if (ms >= 60_000) return `${one.format(ms / 60_000)} min`;
      if (ms >= 1_000) return `${one.format(ms / 1_000)} s`;
      if (ms >= 10) return `${int.format(ms)} ms`;
      return `${two.format(ms)} ms`;
    },
    bytes,
    signedBytes: (n) =>
      n > 0 ? `+${bytes(n)}` : n < 0 ? `−${bytes(n)}` : bytes(0),
    percent: (pct) => `${pct >= 10 ? int.format(pct) : one.format(pct)}%`,
    ratio: (r) => (r > 0 && r < 0.01 ? "<1%" : `${int.format(r * 100)}%`),
    relative: (iso, now = Date.now()) => {
      const s = (new Date(iso).getTime() - now) / 1000;
      const abs = Math.abs(s);
      if (abs < 60) return rel.format(Math.round(s), "second");
      if (abs < 3600) return rel.format(Math.round(s / 60), "minute");
      if (abs < 86_400) return rel.format(Math.round(s / 3600), "hour");
      return rel.format(Math.round(s / 86_400), "day");
    },
    dateTime: (iso) => dt.format(new Date(iso)),
  };
}
