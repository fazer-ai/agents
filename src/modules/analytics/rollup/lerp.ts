import { Prisma } from "@/../generated/prisma/client";
import type { ScopedDb } from "@/lib/tenancy";

// THE LAST DIGIT OF percentile_cont, AS THE SERVER COMPUTES IT. Postgres takes the fraction as
// `p * (n - 1) - first_row` and interpolates as `lo + frac * (hi - lo)`, and a build whose compiler
// fuses a multiply and an add into one rounding (an ARM build does, a plain x86-64 one does not)
// answers one unit in the last place away from the unfused arithmetic. The kept days compute the
// same interpolation in JavaScript, so they ask the server once which of the two it fuses and repeat
// it bit for bit: a figure read from kept days equals the live one to the last digit.

type Fused = { frac: boolean; lerp: boolean };

let fused: Fused | null = null;

function parts(x: number): [bigint, bigint] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const exp = (bits >> 52n) & 0x7ffn;
  const m = bits & 0xfffffffffffffn;
  if (exp === 0n) return [sign * m, -1074n];
  return [sign * (m | (1n << 52n)), exp - 1075n];
}

// m * 2^e rounded once, to nearest with ties to even (the values here are far from subnormal).
function rounded(m: bigint, e: bigint): number {
  if (m === 0n) return 0;
  const neg = m < 0n;
  let mag = neg ? -m : m;
  let exp = e;
  let extra = 0n;
  while (mag >> (extra + 53n) > 0n) extra++;
  if (extra > 0n) {
    const q = mag >> extra;
    const r = mag - (q << extra);
    const half = 1n << (extra - 1n);
    mag = r > half || (r === half && (q & 1n) === 1n) ? q + 1n : q;
    exp += extra;
  }
  const v = Number(mag) * 2 ** Number(exp);
  return neg ? -v : v;
}

/** a * b + c with a single rounding, as a fused multiply-add computes it. */
export function fma(a: number, b: number, c: number): number {
  const [ma, ea] = parts(a);
  const [mb, eb] = parts(b);
  const [mc, ec] = parts(c);
  const ep = ea + eb;
  const e = ep < ec ? ep : ec;
  return rounded(((ma * mb) << (ep - e)) + (mc << (ec - e)), e);
}

/** percentile_cont(p) over n values whose ranks floor(p*(n-1)) and ceil(p*(n-1)) hold lo and hi. */
export function pgLerp(p: number, n: number, lo: number, hi: number): number {
  return lerpAs(fused ?? { frac: false, lerp: false }, p, n, lo, hi);
}

function lerpAs(
  f: Fused,
  p: number,
  n: number,
  lo: number,
  hi: number,
): number {
  const first = Math.floor(p * (n - 1));
  const frac = f.frac ? fma(p, n - 1, -first) : p * (n - 1) - first;
  return f.lerp ? fma(frac, hi - lo, lo) : lo + frac * (hi - lo);
}

// Two probes, each separating one of the two sites: the first fraction is exact either way and only
// the interpolation can differ; the second interpolation differs only through the fraction.
export async function learnPgLerp(db: ScopedDb): Promise<void> {
  if (fused) return;
  const [row] = await db.$queryRaw<{ a: number; b: number }[]>(Prisma.sql`
    SELECT (SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY v)
              FROM (VALUES (0.1::float8), (0.7::float8)) x(v)) AS a,
           (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY v)
              FROM (SELECT CASE WHEN g <= 147 THEN 6184.164::float8 ELSE 6314.419::float8 END AS v
                      FROM generate_series(0, 164) g) x) AS b`);
  const lerp = Number(row?.a) === fma(0.75, 0.7 - 0.1, 0.1);
  const frac =
    Number(row?.b) ===
    lerpAs({ frac: true, lerp }, 0.9, 165, 6184.164, 6314.419);
  fused = { frac, lerp };
}
