import config from "@/config";

/**
 * The settings an agent is born with, on every door that creates one (create and import). A server
 * running in development logs tool values from creation, so a fresh local database does not begin
 * each test round by switching it on agent by agent; anywhere else the default stays off. A bag that
 * already says either way keeps what it says. Only `NODE_ENV` decides: nothing in the request or the
 * database can turn it on.
 */
export function withCreationDefaults<T>(settings: T): T {
  if (config.env !== "development") return settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return settings;
  const bag = settings as Record<string, unknown>;
  const raw = bag.observability;
  const obs =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if ("logToolValues" in obs) return settings;
  return {
    ...bag,
    observability: { ...obs, logToolValues: true },
  } as T;
}
