// The two headers the server names its build with (api/lib/served-build.ts) and the console reads
// (client/lib/staleBuild.ts). No imports, so both bundles can hold it.
export const SERVED_BUILD_HEADER = "x-app-build";
export const SERVED_VERSION_HEADER = "x-app-version";
