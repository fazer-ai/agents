// Rule-based Vietnamese buying-intent scorer for social posts (no LLM). Keyword
// signals are matched on a diacritics-stripped normalization of the text, so both
// "cần mua" and telex-less "can mua" hit the same pattern. A post that reads as a
// SELLER's own listing ("mình pass", "em bán") is capped near zero rather than
// promoted, unless a buyer phrase is also present ("cần pass lại...").

export interface ScorerProduct {
  id: bigint;
  name: string;
  tags: string[];
}

export interface ScoredMatch {
  productId: bigint;
  // 0..1 relevance of this lead's text to the product.
  score: number;
  reason: string;
}

export interface LeadScore {
  // 0..100 intent score written onto Lead.score.
  score: number;
  // Matched signal group names, kept for the audit projection and debugging.
  signals: string[];
  matches: ScoredMatch[];
}

// Strips Vietnamese diacritics so a keyword list written once matches both
// accented and unaccented typing. "đ" is not a combining mark, so NFD never
// decomposes it; it is mapped by hand.
export function normalizeVi(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-phrase match on the normalized text: a keyword must not fire inside a
// longer word ("ship" inside "relationship" style noise).
function hasPhrase(normalized: string, phrase: string): boolean {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`).test(normalized);
}

interface SignalGroup {
  name: string;
  weight: number;
  phrases: string[];
}

const SIGNAL_GROUPS: SignalGroup[] = [
  {
    name: "buy-intent",
    weight: 45,
    phrases: [
      "can mua",
      "muon mua",
      "ai ban",
      "co ai ban",
      "can tim",
      "dat hang",
      "dat mua",
      "order",
      "chot",
      "inbox",
      "ib",
      "sdt",
      "mua gap",
    ],
  },
  {
    name: "price-or-stock",
    weight: 25,
    phrases: [
      "bao nhieu",
      "gia",
      "tam gia",
      "budget",
      "con hang",
      "con khong",
      "ship",
      "phi ship",
      "giao hang",
      "freeship",
    ],
  },
  {
    name: "searching",
    weight: 25,
    phrases: [
      "tim",
      "tim mua",
      "tu van",
      "goi y",
      "recommend",
      "review",
      "co ai biet",
      "cho em hoi",
      "cho minh hoi",
    ],
  },
  {
    name: "resale",
    weight: 15,
    phrases: ["pass", "thanh ly", "2hand", "secondhand", "do cu", "like new"],
  },
];

// Seller's own listing ("mình bán", "em pass lại"). These only drag the score
// down when no buyer phrase is present alongside them.
const SELLER_PHRASES = [
  "minh ban",
  "em ban",
  "shop ban",
  "minh pass",
  "em pass",
  "minh thanh ly",
  "em thanh ly",
  "can ban",
  "can ra",
  "chuyen nhuong",
  "sang lai",
];

// Phrases that mark the author as the buyer even when a resale word appears
// ("cần pass", "tìm đồ thanh lý").
const BUYER_OVERRIDE_PHRASES = [
  "can",
  "muon",
  "tim",
  "ai co",
  "ai ban",
  "ai dang",
];

const MAX_MATCHES = 5;
const MATCH_MIN_SCORE = 0.3;

function matchProduct(
  normalizedText: string,
  textTokens: Set<string>,
  product: ScorerProduct,
): ScoredMatch | null {
  const name = normalizeVi(product.name).trim();
  if (name.length >= 2 && hasPhrase(normalizedText, name)) {
    return {
      productId: product.id,
      score: 0.95,
      reason: `post names product "${product.name}"`,
    };
  }
  for (const tag of product.tags) {
    const t = normalizeVi(tag).trim();
    if (t.length >= 2 && hasPhrase(normalizedText, t)) {
      return {
        productId: product.id,
        score: 0.65,
        reason: `post mentions tag "${tag}"`,
      };
    }
  }
  const nameTokens = name.split(/\s+/).filter((w) => w.length >= 3);
  if (nameTokens.length > 0) {
    const hits = nameTokens.filter((w) => textTokens.has(w)).length;
    const ratio = hits / nameTokens.length;
    if (ratio >= 0.5) {
      return {
        productId: product.id,
        score: Math.min(0.7, ratio * 0.7),
        reason: `partial name match for "${product.name}" (${hits}/${nameTokens.length} words)`,
      };
    }
  }
  return null;
}

export function scoreLeadText(
  text: string,
  products: ScorerProduct[],
): LeadScore {
  const normalized = ` ${normalizeVi(text).replace(/[^\p{L}\p{N}\s]/gu, " ")} `;
  const textTokens = new Set(normalized.split(/\s+/).filter(Boolean));

  const signals: string[] = [];
  let intent = 0;
  for (const group of SIGNAL_GROUPS) {
    if (group.phrases.some((p) => hasPhrase(normalized, p))) {
      signals.push(group.name);
      intent += group.weight;
    }
  }

  const matches = products
    .map((p) => matchProduct(normalized, textTokens, p))
    .filter((m): m is ScoredMatch => m !== null && m.score >= MATCH_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES);

  const productBoost = Math.round((matches[0]?.score ?? 0) * 30);

  const seller = SELLER_PHRASES.some((p) => hasPhrase(normalized, p));
  const buyer = BUYER_OVERRIDE_PHRASES.some((p) => hasPhrase(normalized, p));
  if (seller && !buyer) {
    signals.push("seller-post");
    return { score: Math.min(intent + productBoost, 10), signals, matches };
  }

  return {
    score: Math.min(100, Math.max(0, intent + productBoost)),
    signals,
    matches,
  };
}
