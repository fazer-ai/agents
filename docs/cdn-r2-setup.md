# CDN Setup with Cloudflare R2

This guide covers setting up a CDN using Cloudflare R2 storage to serve your frontend assets (JS, CSS, images) from a global edge network. There are two approaches:

| | R2 Custom Domain | Cloudflare Worker |
|---|---|---|
| **Complexity** | Simpler — no code to deploy | Requires deploying a worker |
| **CORS** | Configured via R2 bucket settings | Custom logic with configurable origins |
| **Cache control** | R2 defaults (requires Cloudflare rules to customize) | Per-file rules (immutable for hashed, 24h for others) |
| **Best for** | Simple setups, fewer moving parts | Fine-grained control over headers and caching |

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed (`bun add -g wrangler`)
- A custom domain on a Cloudflare-managed zone (recommended)

## Step 1: Create the R2 Bucket

```bash
wrangler r2 bucket create my-app-assets
```

Replace `my-app-assets` with your desired bucket name.

## Step 2: Choose a Serving Method

### Option A: R2 Custom Domain (simpler)

Serve assets directly from R2 using a custom domain. No worker needed.

1. In **Cloudflare Dashboard → R2 → your bucket → Settings → Custom Domains**, add your CDN domain (e.g. `cdn.myapp.com`).
   - The domain must be on a Cloudflare-managed zone.

2. In **R2 → your bucket → Settings → CORS Policy**, add:

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["Content-Length", "Content-Type", "ETag"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

3. In **GitHub repo → Settings → Variables → Actions**, set `CDN_WORKER_DISABLED` to `true` to skip the worker deploy step in CI.

> **Caveat**: Cache control headers use R2 defaults — you cannot customize per-file cache rules without adding a Transform Rule or Cache Rule in Cloudflare.

### Option B: Cloudflare Worker (more control)

Serve assets through a Cloudflare Worker that proxies R2. Allows custom CORS, per-file cache control, and MIME type handling.

1. Edit `workers/cdn/wrangler.toml`:

   ```toml
   name = "my-app-cdn"
   main = "src/index.ts"
   compatibility_date = "2025-01-01"

   [vars]
   ALLOWED_ORIGINS = "https://myapp.com,http://localhost:3000"

   [[r2_buckets]]
   binding = "ASSETS"
   bucket_name = "my-app-assets"
   ```

   Update:
   - `name` — your worker name
   - `ALLOWED_ORIGINS` — comma-separated list of allowed origins for CORS
   - `bucket_name` — must match the bucket created in Step 1

2. Deploy the worker:

   ```bash
   cd workers/cdn
   bunx wrangler deploy
   ```

   The worker will be available at `https://my-app-cdn.<your-account>.workers.dev`.

3. Add a custom domain (recommended):
   - Go to **Cloudflare Dashboard → Workers & Pages → your worker → Settings → Domains & Routes**
   - Add a custom domain (e.g. `cdn.myapp.com`)
   - Cloudflare will automatically configure the DNS

## Step 3: Set Environment Variables

### Local Development

Add to your `.env` file:

```env
BUN_PUBLIC_CDN_URL=https://cdn.myapp.com
```

> **Note**: Leave `BUN_PUBLIC_CDN_URL` empty for local development to serve assets from the app server directly.

### Docker / Production

Pass the build arg to Docker:

```bash
docker build --build-arg BUN_PUBLIC_CDN_URL=https://cdn.myapp.com .
```

For Coolify, set the `CDN_URL` environment variable in your service configuration.

## Step 4: Upload Assets

After building, upload the `dist/` directory to R2:

```bash
bun run build

cd dist
find . -type f | while IFS= read -r file; do
  key="${file#./}"
  echo "Uploading $key"
  bunx wrangler r2 object put "my-app-assets/$key" --file "$file" --remote
done
```

## CI/CD Integration

Here's a GitHub Actions job to automate asset upload and worker deployment:

```yaml
upload-assets:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@agents

    - uses: oven-sh/setup-bun@v2
      with:
        bun-version: latest

    - run: bun install --frozen-lockfile

    - name: Build frontend assets
      run: bun run build
      env:
        BUN_PUBLIC_CDN_URL: ${{ secrets.BUN_PUBLIC_CDN_URL }}

    - name: Upload assets to R2
      env:
        CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      run: |
        cd dist
        find . -type f | while IFS= read -r file; do
          key="${file#./}"
          echo "Uploading $key"
          bunx wrangler r2 object put "my-app-assets/$key" --file "$file" --remote
        done

    - name: Deploy CDN Worker
      if: vars.CDN_WORKER_DISABLED != 'true'
      run: bunx wrangler deploy
      working-directory: workers/cdn
      env:
        CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

> **Note**: If using Option A (R2 Custom Domain), set the `CDN_WORKER_DISABLED` Actions variable to `true` to skip the worker deploy step.

### Required GitHub Secrets / Variables

| Name                     | Type     | Description                                 |
| ------------------------ | -------- | ------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`   | Secret   | API token with Workers and R2 permissions   |
| `CLOUDFLARE_ACCOUNT_ID`  | Secret   | Your Cloudflare account ID                  |
| `BUN_PUBLIC_CDN_URL`     | Secret   | Your CDN URL (e.g. `https://cdn.myapp.com`) |
| `CDN_WORKER_DISABLED`    | Variable | Set to `true` to skip worker deploy (Option A) |

### Creating the Cloudflare API Token

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use the **Edit Cloudflare Workers** template
4. Add **R2 Storage → Edit** permission
5. Create and copy the token

## How It Works

### Build Time

When `BUN_PUBLIC_CDN_URL` is set, the build process (`build.ts`) rewrites all asset URLs to point to the CDN:

```
/index-a1b2c3d4.css → https://cdn.myapp.com/index-a1b2c3d4.css
```

The `getAssetUrl()` utility in `src/client/lib/utils.ts` handles runtime asset URL resolution for static assets like logos.

The `@font-face` rules in `public/index.html` are the one place `publicPath` does not reach: they sit in a `<style>` so the CSS bundler does not inline the fonts (see `docs/csp.md`), and a URL the bundler passes through is one it never rewrites. `build.ts` covers them in a post-build pass (`scripts/lib/cdn-assets.ts`) that points every root-relative `/assets/` reference in `dist/index.html` at the CDN, and fails the build naming any reference in the document still relative. The font files reach the CDN with the rest of `dist/`.

### Runtime — R2 Custom Domain (Option A)

R2 serves files directly with its built-in HTTP handling. CORS is controlled by the bucket's CORS policy. Cache behavior uses Cloudflare defaults (customizable via Cache Rules or Transform Rules in the dashboard).

### Runtime — Cloudflare Worker (Option B)

The CDN worker (`workers/cdn/src/index.ts`):

- Serves files from the R2 bucket
- Sets proper `Content-Type` headers based on file extension
- Applies **immutable caching** (1 year) for hashed build outputs (e.g. `index-a1b2c3d4.css`)
- Applies **24-hour caching** to everything else, including anything under `assets/` whatever its name looks like: `build.ts` copies `public/assets/` verbatim, and `inter-variable.woff2` has the shape of a hashed name without being one. Same policy as the app's own static serving (`src/api/lib/static-cache.ts`); `tests/workers/cdn.test.ts` runs the worker's real `fetch` and fails if the two disagree
- Handles CORS with configurable allowed origins
- Supports `ETag` / `If-None-Match` for conditional requests
- Handles `HEAD` and `OPTIONS` requests
