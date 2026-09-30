// NOTE: `Env` is no longer declared here — worker-configuration.d.ts derives it
// from the bindings in wrangler.toml (`wrangler types`). Add a binding there and
// re-run `bunx wrangler types` instead of hand-editing an interface here.

const HASHED_ASSET_PATTERN = /-[a-z0-9]{8,}\.\w+$/i;

// build.ts copies public/assets/ verbatim, so nothing under assets/ is a build output, whatever its
// name looks like: `inter-variable.woff2` passes the hash shape. Keys are dist/-relative, with no
// leading slash. Same rule as the app's cacheControlFor (src/api/lib/static-cache.ts), and
// tests/workers/cdn.test.ts holds the two together.
const VERBATIM_PREFIX = "assets/";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".eot": "application/vnd.ms-fontobject",
	".webp": "image/webp",
	".avif": "image/avif",
	".mp4": "video/mp4",
	".webm": "video/webm",
};

function getMimeType(path: string): string {
	const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
	return MIME_TYPES[ext] || "application/octet-stream";
}

function getCacheControl(path: string): string {
	if (HASHED_ASSET_PATTERN.test(path) && !path.startsWith(VERBATIM_PREFIX)) {
		return "public, max-age=31536000, immutable";
	}
	return "public, max-age=86400";
}

function getCorsHeaders(request: Request, allowedOrigins: string[]): Record<string, string> {
	const origin = request.headers.get("Origin");
	if (!origin) return {};

	const isAllowed = allowedOrigins.some(
		(allowed) => origin === allowed || allowed === "*",
	);
	if (!isAllowed) return {};

	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
		"Access-Control-Allow-Headers": "*",
		"Access-Control-Expose-Headers": "Content-Length, Content-Type, ETag",
		"Access-Control-Max-Age": "86400",
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
		const corsHeaders = getCorsHeaders(request, allowedOrigins);

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
		}

		const url = new URL(request.url);
		const key = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;

		if (!key) {
			return new Response("Not Found", { status: 404, headers: corsHeaders });
		}

		const object = await env.ASSETS.get(key);
		if (!object) {
			return new Response("Not Found", { status: 404, headers: corsHeaders });
		}

		const headers: Record<string, string> = {
			"Content-Type": getMimeType(key),
			"Cache-Control": getCacheControl(key),
			ETag: object.httpEtag,
			...corsHeaders,
		};

		if (object.size) {
			headers["Content-Length"] = object.size.toString();
		}

		const ifNoneMatch = request.headers.get("If-None-Match");
		if (ifNoneMatch === object.httpEtag) {
			return new Response(null, { status: 304, headers });
		}

		const body = request.method === "HEAD" ? null : object.body;
		return new Response(body, { status: 200, headers });
	},
} satisfies ExportedHandler<Env>;
