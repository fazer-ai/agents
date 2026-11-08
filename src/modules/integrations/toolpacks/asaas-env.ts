// Asaas origins per environment, confirmed against docs.asaas.com (Authentication / Sandbox,
// 2026-06): the sandbox host is `api-sandbox.asaas.com`, not the legacy `sandbox.asaas.com/api/v3`.
// Shared by the toolpack and the vault's credential test so the two pick the same host for a key.
export const ASAAS_ORIGINS = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
} as const;
export type AsaasEnv = keyof typeof ASAAS_ORIGINS;

// Keys minted since 2025-03 name their environment in the prefix (docs.asaas.com changelog, "novo
// prefixo de identificação das chaves API"). An older key carries no marker: null.
const KEY_PREFIX_ENV: ReadonlyArray<readonly [string, AsaasEnv]> = [
  ["$aact_prod_", "production"],
  ["$aact_hmlg_", "sandbox"],
];

export function asaasEnvFromKey(token: string): AsaasEnv | null {
  return (
    KEY_PREFIX_ENV.find(([prefix]) => token.startsWith(prefix))?.[1] ?? null
  );
}
