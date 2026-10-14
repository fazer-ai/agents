// The build this server hands to browsers, named on every response so an open console tab can tell
// that the frontend it is running was replaced (docs/routing.md, "A tab older than the server").
// build.ts writes dist/build.json next to the document it built; the client carries the same id
// inlined (APP_BUILD_ID), so the comparison is between two values of one build step.

import {
  SERVED_BUILD_HEADER,
  SERVED_VERSION_HEADER,
} from "@/lib/served-build-headers";

export type ServedBuild = { version: string; buildId: string };

// Null when there is nothing to name: dev serves no build, and a dist/ without build.json (an image
// built before the file existed) must not make every tab look stale.
export async function readServedBuild(
  file: string,
): Promise<ServedBuild | null> {
  try {
    const parsed: unknown = await Bun.file(file).json();
    if (!parsed || typeof parsed !== "object") return null;
    const { version, buildId } = parsed as Record<string, unknown>;
    if (typeof buildId !== "string" || !buildId) return null;
    return { version: typeof version === "string" ? version : "", buildId };
  } catch {
    return null;
  }
}

export function stampServedBuild(
  build: ServedBuild | null,
  headers: Record<string, string | number>,
): void {
  if (!build) return;
  headers[SERVED_BUILD_HEADER] = build.buildId;
  headers[SERVED_VERSION_HEADER] = build.version;
}
