# Frontend env vars (`BUN_PUBLIC_*`)

- Env vars exposed to the client must be prefixed `BUN_PUBLIC_` and declared in `build.ts` under `define` (e.g. `"process.env.BUN_PUBLIC_CDN_URL": JSON.stringify(...)`). Without the `define` entry, the value is not inlined into the bundle.
- All reads of `process.env.BUN_PUBLIC_*` in client code must live in `src/client/lib/env.ts` and nowhere else. The rest of the client imports the typed exports from that module. Reason: in production the `define` replacement eliminates the `process` reference, but in dev the browser has no `process` global, so a bare read throws a `ReferenceError` and breaks the module. `env.ts` wraps every read in a `try/catch` and is the only place that has to deal with that.
- The `define` substitution is textual against the literal `process.env.BUN_PUBLIC_X`. Computed access (`process.env[key]`) does not get inlined, so each var must be read by its literal name in `env.ts`.
- This rule is enforced by a Biome GritQL plugin at `biome-plugins/no-bun-public-env.grit`, scoped via `overrides` in `biome.jsonc` to `src/client/**` minus `env.ts`. Violations fail `bun lint`.

## Propagating a new `BUN_PUBLIC_*` through the build pipeline

The `define` substitution happens at `bun run build` time, so every layer between the CI secret store and that command must forward the variable explicitly. A value set only in GitHub repo secrets but not forwarded ships as an **empty string** in the bundle with no build-time or runtime error. `BUN_PUBLIC_CDN_URL` is the existing reference implementation; mirror it when adding a new var:

1. Declare in `build.ts` under `define` (see above)
2. Read via `src/client/lib/env.ts` (see above)
3. In `Dockerfile`, add an `ARG name=""` + `ENV name=$name` pair in the `build` stage, **before** the `RUN bun run build` step (see `BUN_PUBLIC_CDN_URL` there). Repeat the pair in the `runtime` stage only when the server also reads the variable at runtime, as it does `BUN_PUBLIC_EDITION`: an `ARG` does not cross stages
4. In `.github/workflows/publish_github_package.yml`, wire it in **both** places: the `Build frontend assets` step's `env:` block (used for R2 asset upload) **and** the `docker/build-push-action`'s `build-args:` block (used for the image build). Missing either one leaves that half of the pipeline shipping an empty value
5. Add the matching secret in GitHub repo settings (`secrets.BUN_PUBLIC_X`)

If a var is environment-specific and not a secret (e.g., a public URL that differs per deploy), use `vars.X` instead of `secrets.X` in the workflow, but the propagation steps are identical.

For the `BUN_PUBLIC_CDN_URL` end-to-end setup (R2 bucket, custom domain or Worker, asset upload step), see [`cdn-r2-setup.md`](cdn-r2-setup.md).
