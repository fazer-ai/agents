import type { CredentialUse } from "@/modules/vault/secret-types";
import type { BehaviorSettingsPatch } from "./behavior-settings";

// Every settings field that holds a vault credential ref, with where the editor shows it (not derivable
// from the block: guardrails has its own tab). The one list export/import, the MCP ref translation and
// the vault's reverse index all read; a test walks the behavior readers so a new ref field lands here.
export const SETTINGS_CREDENTIAL_PATHS = [
  {
    path: ["stt", "credentialRef"],
    tab: "behavior",
    sectionId: "stt",
    use: "apiKey",
  },
  // The one agent field that is not an API key. It goes through
  // `resolveInjectableCredentialEntry`, which refreshes a managed-OAuth token and injects THAT, so
  // a `google_oauth` entry here is correct configuration and refusing it would break the feature.
  {
    path: ["contactAuth", "credentialRef"],
    tab: "behavior",
    sectionId: "contactAuth",
    use: "injectable",
  },
  {
    path: ["tts", "credentialRef"],
    tab: "behavior",
    sectionId: "tts",
    use: "apiKey",
  },
  {
    path: ["tts", "normalizeCredentialRef"],
    tab: "behavior",
    sectionId: "tts",
    use: "apiKey",
  },
  {
    path: ["vision", "credentialRef"],
    tab: "behavior",
    sectionId: "vision",
    use: "apiKey",
  },
  {
    path: ["guardrails", "credentialRef"],
    tab: "guardrails",
    sectionId: "gr-model",
    use: "apiKey",
  },
  {
    path: ["memory", "compaction", "credentialRef"],
    tab: "behavior",
    sectionId: "memory",
    use: "apiKey",
  },
  {
    path: ["modelFallback", "credentialRef"],
    tab: "behavior",
    sectionId: "modelFallback",
    use: "apiKey",
  },
] as const satisfies ReadonlyArray<{
  path: readonly [keyof BehaviorSettingsPatch, ...string[]];
  tab: "behavior" | "guardrails";
  sectionId: string;
  // What the field DOES with the entry, and therefore which kinds can serve it (secretTypeFits).
  // Required, so a credential field added to this list cannot be silently exempted from the check:
  // seven of the eight read a plain API key and the eighth does not, which is exactly the split a
  // derived rule would have got wrong.
  use: CredentialUse;
}>;

// Walks a path of any depth (`memory.compaction.credentialRef` is two levels down) to the object that
// HOLDS the credential field, so a caller can read or rewrite it in place. Null when the path is
// absent, the normal case for a patch that does not touch the block or an older settings bag.
export function credRefSlot(
  root: Record<string, unknown> | undefined | null,
  path: readonly string[],
): { holder: Record<string, unknown>; key: string } | null {
  const key = path[path.length - 1];
  if (!root || key === undefined) return null;
  let node: Record<string, unknown> = root;
  for (const step of path.slice(0, -1)) {
    const next = node[step];
    if (!next || typeof next !== "object" || Array.isArray(next)) return null;
    node = next as Record<string, unknown>;
  }
  return { holder: node, key };
}

// Copy-on-write along a path: a copy of `root` whose credential leaf has been rewritten (or removed,
// when `map` returns null), with the original untouched at EVERY level the path passes through.
// Returns `root` itself when there is no ref there to rewrite, which is what keeps an untouched
// block untouched.
//
// A shallow copy of the top block was enough while every credential sat directly on it. Once one is
// nested, copying only the top and mutating the sub-object writes straight through to the caller's
// original — the export would hand back a bag it had quietly edited.
export function remapCredRefAt(
  root: Record<string, unknown>,
  path: readonly string[],
  map: (ref: string) => string | null,
): Record<string, unknown> {
  const slot = credRefSlot(root, path);
  if (!slot) return root;
  const ref = slot.holder[slot.key];
  if (typeof ref !== "string" || !ref) return root;
  const mapped = map(ref);
  const containers = path.slice(0, -1);
  const chain: Record<string, unknown>[] = [];
  let node: Record<string, unknown> = root;
  for (const step of containers) {
    chain.push(node);
    node = node[step] as Record<string, unknown>;
  }
  const leaf = { ...node };
  if (mapped === null) delete leaf[slot.key];
  else leaf[slot.key] = mapped;
  let acc: Record<string, unknown> = leaf;
  for (let i = chain.length - 1; i >= 0; i--) {
    const step = containers[i];
    const parent = chain[i];
    if (step === undefined || parent === undefined) continue;
    acc = { ...parent, [step]: acc };
  }
  return acc;
}

// The editor tabs an agent-level credential field can live on, for the import warning's deep link.
export type CredentialFieldTab =
  | "general"
  | (typeof SETTINGS_CREDENTIAL_PATHS)[number]["tab"];

export interface CredentialRefWrite {
  // Dotted path from the agent row, so a refusal names the field the editor shows rather than the
  // bag it lives in: `modelConfig.credentialRef`, `settings.tts.normalizeCredentialRef`.
  path: string;
  ref: string;
  // What this field reads the entry AS, carried alongside the ref so the write boundary can refuse a
  // kind that cannot serve it without re-deriving the field's purpose from its path.
  use: CredentialUse;
  // Writes the canonical spelling back where the ref was found. In place, for the same reason
  // clampOversizedTextInPlace is: the caller owns a freshly parsed payload whose bags hold keys this
  // module knows nothing about, and rebuilding them from the paths listed here would drop the rest.
  replace: (canonical: string) => void;
}

function bagOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// Every credential ref a write INTRODUCES or CHANGES (modelConfig plus the settings paths above). Only
// those: a stored ref the write leaves alone may sit on a field the operator cannot open, so a deleted
// vault entry is reported by config-health as `unresolved`, never a refusal that freezes the agent.
export function collectCredentialRefWrites(
  next: { modelConfig?: unknown; settings?: unknown },
  stored: { modelConfig?: unknown; settings?: unknown },
): CredentialRefWrite[] {
  const out: CredentialRefWrite[] = [];
  const add = (
    path: string,
    holder: Record<string, unknown>,
    key: string,
    storedRef: unknown,
    use: CredentialUse,
  ): void => {
    const ref = holder[key];
    if (typeof ref !== "string" || !ref || ref === storedRef) return;
    out.push({
      path,
      ref,
      use,
      replace: (canonical) => {
        holder[key] = canonical;
      },
    });
  };

  const nextModel =
    next.modelConfig === undefined ? null : bagOf(next.modelConfig);
  if (nextModel) {
    add(
      "modelConfig.credentialRef",
      nextModel,
      "credentialRef",
      bagOf(stored.modelConfig)?.credentialRef,
      // The agent's own model key, handed to the provider SDK by `createChatModel`.
      "apiKey",
    );
  }
  const nextSettings =
    next.settings === undefined ? null : bagOf(next.settings);
  if (nextSettings) {
    const storedSettings = bagOf(stored.settings);
    for (const { path, use } of SETTINGS_CREDENTIAL_PATHS) {
      const slot = credRefSlot(nextSettings, path);
      if (!slot) continue;
      const storedSlot = credRefSlot(storedSettings, path);
      add(
        `settings.${path.join(".")}`,
        slot.holder,
        slot.key,
        storedSlot ? storedSlot.holder[storedSlot.key] : undefined,
        use,
      );
    }
  }
  return out;
}
