// Every source of billed traffic: real customers in a Chatwoot inbox, operator tests in the
// playground, and the users of a host application through the client channel. One list, so the poll,
// the console and the cost reconciliation cannot each forget a different source. A module of its own
// because the console imports it, and `usage.ts` pulls in Prisma and the logger.
export const USAGE_SOURCES = ["inbox", "playground", "client"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

// Who the client channel served: a host's signed-in user, or an anonymous visitor's session. A filter
// on either is client traffic of that kind; a row of any other source is neither.
export const CLIENT_AUDIENCES = ["identified", "anonymous"] as const;
export type ClientAudience = (typeof CLIENT_AUDIENCES)[number];
