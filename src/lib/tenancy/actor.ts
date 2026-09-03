// The four doors a request can come through, as a VALUE and not only as a type.
//
// Its own module, with no imports at all, because the console's audit page filters by this and the
// page is part of the browser bundle: taken from `context.ts` it drags `AsyncLocalStorage` in, whose
// browser shim is empty, and the whole console throws before it renders — on every screen, not just
// the one that imported it. `tests/client/bundle-boundary.test.ts` fences that.
export const ACTOR_TYPES = ["user", "api_key", "mcp", "system"] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];
