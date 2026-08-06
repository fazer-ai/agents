// NOTE: The editor's baseURL fields (model / STT / vision) are LOCKED while the credential carries
// its own baseUrl: the field then shows the credential's URL and the operator's own value is parked
// in a ref, to be restored when they switch to a credential without one.
//
// The restore must fire ONLY on that locked → unlocked transition. Firing it whenever the current
// credential has no baseUrl wipes the persisted value on page load (the picker resolves the entry
// once mounted, the ref is still empty, and the field is overwritten with ""), and the next save
// then drops baseURL from the config.
export function shouldRestoreUserBaseUrl(
  prevCredBaseUrl: string | null,
  nextCredBaseUrl: string | null,
): boolean {
  return nextCredBaseUrl === null && prevCredBaseUrl !== null;
}
