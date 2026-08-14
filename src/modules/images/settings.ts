// Per-agent config for the `send_image` native tool, read from `agent.settings.sendImage`.
//
// The one control that matters is `allowedHosts`. The tool fetches a URL the MODEL supplies, so the
// set of hosts it may reach is an OPERATOR decision and lives here — never in a tool argument, which
// a prompt injection could steer. Empty ⇒ the tool refuses every call, so granting it without
// configuring a host cannot silently turn the agent into a fetcher for arbitrary URLs (nor into an
// exfiltration channel, since the URL itself is model-written and would carry whatever it encodes).

export interface SendImageConfig {
  // Hostnames the agent may fetch an image from. A leading "*." matches the apex AND any subdomain
  // ("*.loja.com.br" covers loja.com.br and cdn.loja.com.br); anything else matches that host exactly.
  allowedHosts: string[];
}

export const SEND_IMAGE_DEFAULTS: SendImageConfig = { allowedHosts: [] };

// Bounded so one misconfigured agent cannot hold a turn open or push an unbounded body through
// Chatwoot. WhatsApp itself rejects images past ~5 MB, so the cap is a product limit, not just a
// guard rail.
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 10_000;
export const MAX_ALLOWED_HOSTS = 50;

// Per-TURN ceilings, which the per-image cap above does not give: one model response can carry a
// batch of tool calls, every accepted image is held in memory until the turn's gates clear, and each
// one costs an upload to Chatwoot on the way out. Three is already more pictures than a single reply
// has any business carrying.
export const SEND_IMAGE_MAX_PER_TURN = 3;
export const SEND_IMAGE_MAX_TURN_BYTES = 12 * 1024 * 1024;

// A caption rides ALONG with the attachment, and a channel that caps it rejects the whole upload
// rather than trimming the text — so an over-long caption does not cost the sentence, it costs the
// picture. Same 500 as `drive_send_file`, which posts through the same sendFileAttachment path.
export const SEND_IMAGE_MAX_CAPTION_CHARS = 500;

// Accepts what an operator is likely to paste: a bare host, a full URL, a host with a port, with or
// without a "*." prefix. Returns null for anything that does not reduce to a hostname.
export function normalizeAllowedHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  const wildcard = v.startsWith("*.");
  if (wildcard) v = v.slice(2);
  if (v.includes("://")) {
    try {
      v = new URL(v).hostname;
    } catch {
      return null;
    }
  } else {
    // NOTE: A pasted "cdn.loja.com.br/imagens" or "cdn.loja.com.br:443" still names one host.
    v = v.split("/")[0]?.split(":")[0] ?? "";
  }
  v = v.replace(/\.$/, "");
  if (!v || !/^[a-z0-9.-]+$/.test(v) || !v.includes(".")) return null;
  return wildcard ? `*.${v}` : v;
}

export function readSendImageConfig(settings: unknown): SendImageConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).sendImage
      : undefined;
  if (!s || typeof s !== "object") return { allowedHosts: [] };
  const raw = (s as Record<string, unknown>).allowedHosts;
  if (!Array.isArray(raw)) return { allowedHosts: [] };
  const seen = new Set<string>();
  for (const entry of raw) {
    const host = normalizeAllowedHost(entry);
    if (host) seen.add(host);
    if (seen.size >= MAX_ALLOWED_HOSTS) break;
  }
  return { allowedHosts: [...seen] };
}

// Matches a URL hostname against the operator's list. The "." in the suffix check is what keeps
// "*.loja.com.br" from matching "evil-loja.com.br".
export function isAllowedImageHost(
  hostname: string,
  allowedHosts: string[],
): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return allowedHosts.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === pattern;
  });
}

// Every write path for `agent.settings` funnels through this: the operator is invited to paste a
// full URL on the promise that only the host is kept, and that has to hold for what is STORED, not
// only for what is read back. A pasted presigned link would otherwise leave its signature (and any
// `user:pass@`) sitting in the row, handed to the editor on every load and to an export on the way
// out. Blocks other than sendImage are clamped on read and hold nothing secret, so this is the one
// that has to be normalized on the way in.
export function normalizeSettingsForStorage(
  settings: unknown,
): Record<string, unknown> | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return undefined;
  }
  const bag = settings as Record<string, unknown>;
  if (bag.sendImage === undefined) return undefined;
  return { ...bag, sendImage: readSendImageConfig(bag) };
}
