// Generate the published OpenAPI document from the live REST route schemas and keep the committed
// `openapi.json` in sync. It boots the app in-process, fetches the auto-generated document, normalizes
// the host-dependent `servers` entry so the output is deterministic across machines, then either writes
// the file (`--write`, wired as `bun openapi:generate`) or verifies the committed copy matches and fails
// on drift (default, wired into `bun check` + CI). GitHub Pages serves the committed file (see
// `.github/workflows/deploy-swagger.yml`), so this is the single source of truth for the public docs.

// NOTE: The `@elysiajs/openapi` plugin is `enabled: env !== "production"` (src/api/index.ts), and
// config reads NODE_ENV at module-eval time. Force development BEFORE anything imports config: this
// assignment must run before the dynamic `@/app` import evaluates, so `@/app`/`@/config` are imported
// dynamically below (a static import would be hoisted above this line and read the ambient NODE_ENV).
process.env.NODE_ENV = "development";
process.env.LOG_LEVEL ??= "warn";

const OUTPUT_PATH = "openapi.json";
const DOCS_JSON_PATH = "/api/docs/json";

// The published spec is host-agnostic: agents is self-hosted, so there is no single canonical origin.
// We expose the API base as an editable OpenAPI server variable — Swagger UI renders `baseUrl` as a
// free-text input so a reader can point "Try it out" at their own instance — defaulting to the local
// dev URL. This replaces the generated `${PUBLIC_URL}/api` entry (machine-specific, so it would also
// break the drift check). The `x-tenant-id` header that injectTenantHeaderParam (src/api/index.ts)
// adds is kept: it is the SUPER_ADMIN tenant selector, useful to a self-hosting operator.
const API_SERVER = {
  url: "{baseUrl}",
  description: "Your self-hosted fazer.ai agents instance",
  variables: {
    baseUrl: {
      default: "http://localhost:3000/api",
      description: "Base URL of your instance, including the /api prefix",
    },
  },
} as const;

type OpenApiDoc = { servers?: unknown } & Record<string, unknown>;

// NOTE: TypeBox emits modern JSON Schema (`patternProperties` for Record<string, X>, and
// `anyOf: [X, {type: "null"}]` for nullable unions), neither of which exists in OpenAPI 3.0 —
// that dialect predates JSON Schema 2020-12. The plugin still labels the document 3.0.3, so
// every such schema is a hard validation error and Swagger UI flags the spec as invalid.
// OpenAPI 3.1 *is* JSON Schema 2020-12, so declaring 3.1 makes the emitted schemas legal as-is
// instead of lossily rewriting them (`patternProperties` -> `additionalProperties` would drop
// the key pattern; `type: "null"` -> `nullable` is 3.0-only vocabulary).
const OPENAPI_VERSION = "3.1.0";

// NOTE: Keys the generator emits that are not OpenAPI in any dialect, so they stay invalid even
// under 3.1: `nullable` is 3.0-only vocabulary (dropped in 3.1) and is redundant here anyway —
// every occurrence sits beside an `anyOf` that already carries `{type: "null"}`, so removing it
// loses nothing. `maxSize` (TypeBox file constraint) and `ws` (Elysia WebSocket route) have no
// OpenAPI counterpart; both remain enforced at runtime, they just are not documentable here.
const NON_OPENAPI_KEYS = ["nullable", "maxSize", "ws"] as const;

function stripNonOpenApiKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripNonOpenApiKeys);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if ((NON_OPENAPI_KEYS as readonly string[]).includes(key)) continue;
    out[key] = stripNonOpenApiKeys(value);
  }
  return out;
}

// Elysia emits a group's index route as `/v1/agents/` (the `.get("/")` inside the group),
// but the server answers both spellings, so the trailing slash is an artifact of how the route is
// declared, not the canonical path, and it makes readers think the two forms differ. Strip it.
// Guarded against collisions: if the unslashed twin already exists, the entries would silently
// overwrite each other.
function stripTrailingSlashes(
  paths: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(paths)) {
    const canonical =
      path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
    if (canonical !== path && (canonical in paths || canonical in out)) {
      throw new Error(
        `normalize: dropping the trailing slash from "${path}" would collide with "${canonical}"; merge them by hand.`,
      );
    }
    out[canonical] = item;
  }
  return out;
}

// NOTE: For a body-less response (`t.Void()`, e.g. the 302 on the MCP authorize endpoint) the plugin
// emits the bare schema as `content` — `{"type": "void", …}` — but OpenAPI's `content` is a map of
// MEDIA TYPES, so that shape is invalid in every dialect. A response with no body simply omits
// `content`, which is what this restores. Detection: a real media-type map has "/" in its keys. For a
// redirect the payload IS the destination, so declare the `Location` header (per RFC 9110 every 3xx
// we emit carries it) — otherwise the operation would document a redirect with no way to follow it.
function normalizeBodylessResponses(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeBodylessResponses);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "responses" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const responses: Record<string, unknown> = {};
      for (const [status, raw] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          responses[status] = raw;
          continue;
        }
        const response = { ...(raw as Record<string, unknown>) };
        const content = response.content;
        const isMediaTypeMap =
          content !== null &&
          typeof content === "object" &&
          !Array.isArray(content) &&
          Object.keys(content as object).every((k) => k.includes("/"));
        if (content !== undefined && !isMediaTypeMap) {
          delete response.content;
          if (/^3\d\d$/.test(status)) {
            response.headers = {
              Location: {
                description: "Redirect destination.",
                schema: { type: "string" },
              },
              ...(typeof response.headers === "object" &&
              response.headers !== null
                ? (response.headers as Record<string, unknown>)
                : {}),
            };
          }
        }
        responses[status] = response;
      }
      out[key] = responses;
      continue;
    }
    out[key] = normalizeBodylessResponses(value);
  }
  return out;
}

function normalize(doc: OpenApiDoc): OpenApiDoc {
  const cleaned = normalizeBodylessResponses(
    stripNonOpenApiKeys(doc),
  ) as OpenApiDoc;
  if (cleaned.paths && typeof cleaned.paths === "object") {
    cleaned.paths = stripTrailingSlashes(
      cleaned.paths as Record<string, unknown>,
    );
  }
  cleaned.openapi = OPENAPI_VERSION;
  cleaned.servers = [API_SERVER];
  return cleaned;
}

async function generate(): Promise<string> {
  const { default: app } = await import("@/app");
  return new Promise((resolve, reject) => {
    app.listen(0, async (server) => {
      try {
        const res = await fetch(
          `http://localhost:${server.port}${DOCS_JSON_PATH}`,
        );
        if (res.status !== 200) {
          throw new Error(
            `GET ${DOCS_JSON_PATH} returned ${res.status} (expected 200). The openapi plugin is dev-only; is NODE_ENV=production?`,
          );
        }
        const doc = normalize((await res.json()) as OpenApiDoc);
        resolve(`${JSON.stringify(doc, null, 2)}\n`);
      } catch (error) {
        reject(error);
      } finally {
        server.stop(true);
      }
    });
  });
}

async function main() {
  const write = process.argv.includes("--write");
  const generated = await generate();

  const outFile = Bun.file(OUTPUT_PATH);
  const existing = (await outFile.exists()) ? await outFile.text() : "";

  if (generated === existing) {
    if (write) console.error(`${OUTPUT_PATH} is up to date.`);
    return 0;
  }

  await Bun.write(OUTPUT_PATH, generated);
  if (write) {
    console.error(`${OUTPUT_PATH} written.`);
    return 0;
  }

  console.error(
    `Error: ${OUTPUT_PATH} is out of date and has been regenerated. Stage it and commit (or run \`bun openapi:generate\`).`,
  );
  return 1;
}

process.exit(await main());
