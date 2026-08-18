// Wire format for credential references (mirrors VAULT_REF_PREFIX in
// src/modules/vault/service.ts): a stored ref is always the stable `vault:<id>` form. Bare entry
// names appear only as the portable form inside agent export/import JSON.
export const VAULT_REF_PREFIX = "vault:";

export function formatVaultRef(id: string): string {
  return `${VAULT_REF_PREFIX}${id}`;
}

// The one spelling of a ref that can be compared against anything built from the vault list, or
// null when no entry id can be read out of it at all — a bare NAME (which MCP speaks and REST
// stores verbatim) or a malformed id, neither of which any resolver ever matches.
//
// `vault:0007`, `vault: 7` and `vault:7` are the same entry to every resolver in this system: they
// parse the id with BigInt, which tolerates padding and surrounding space. A ref reaches the field
// unvalidated through `PATCH /v1/agents/:id`, so comparing raw strings against a canonical list
// reports a working credential as unavailable, in the picker as much as in the health panel.
export function canonicalVaultRef(ref: string): string | null {
  if (!ref.startsWith(VAULT_REF_PREFIX)) return null;
  try {
    return formatVaultRef(String(BigInt(ref.slice(VAULT_REF_PREFIX.length))));
  } catch {
    return null;
  }
}
