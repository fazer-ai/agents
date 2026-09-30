#!/usr/bin/env bun
import plugin from "bun-plugin-tailwind";
import { existsSync } from "fs";
import { cp, rename, rm } from "fs/promises";
import path from "path";
import pkg from "./package.json" with { type: "json" };
import {
  findNonAbsoluteUrls,
  rewriteAssetUrlsForCdn,
} from "./scripts/lib/cdn-assets";

// App version shown in the sidebar footer (item 2). An explicit BUN_PUBLIC_VERSION (e.g. a CI build
// tag / git sha) wins; otherwise fall back to package.json's version.
const APP_VERSION = process.env.BUN_PUBLIC_VERSION || pkg.version || "";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
🏗️  Bun Build Script

Usage: bun run build.ts [options]

Common Options:
  --outdir <path>          Output directory (default: "dist")
  --minify                 Enable minification (or --minify.whitespace, --minify.syntax, etc)
  --sourcemap <type>      Sourcemap type: none|linked|inline|external
  --target <target>        Build target: browser|bun|node
  --format <format>        Output format: esm|cjs|iife
  --splitting              Enable code splitting
  --packages <type>        Package handling: bundle|external
  --public-path <path>     Public path for assets
  --env <mode>             Environment handling: inline|disable|prefix*
  --conditions <list>      Package.json export conditions (comma separated)
  --external <list>        External packages (comma separated)
  --banner <text>          Add banner text to output
  --footer <text>          Add footer text to output
  --define <obj>           Define global constants (e.g. --define.VERSION=1.0.0)
  --help, -h               Show this help message

Example:
  bun run build.ts --outdir=dist --minify --sourcemap=linked --external=react,react-dom
`);
  process.exit(0);
}

const toCamelCase = (str: string): string => str.replace(/-([a-z])/g, g => g[1]?.toUpperCase() ?? '');

const parseValue = (value: string): unknown => {
  if (value === "true") return true;
  if (value === "false") return false;

  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d*\.\d+$/.test(value)) return parseFloat(value);

  if (value.includes(",")) return value.split(",").map(v => v.trim());

  return value;
};

function parseArgs(): Partial<Bun.BuildConfig> {
  const config: Partial<Bun.BuildConfig> & Record<string, any> = {};
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) continue;

    if (arg.startsWith("--no-")) {
      const key = toCamelCase(arg.slice(5));
      config[key] = false;
      continue;
    }

    if (!arg.includes("=") && (i === args.length - 1 || args[i + 1]?.startsWith("--"))) {
      const key = toCamelCase(arg.slice(2));
      config[key] = true;
      continue;
    }

    let key: string;
    let value: string;

    if (arg.includes("=")) {
      [key, value] = arg.slice(2).split("=", 2) as [string, string];
    } else {
      key = arg.slice(2);
      value = args[++i] ?? "";
    }

    key = toCamelCase(key);

    if (key.includes(".")) {
      const [parentKey, childKey] = key.split(".") as [string, string];
      config[parentKey] = config[parentKey] || {};
      config[parentKey][childKey] = parseValue(value);
    } else {
      config[key] = parseValue(value);
    }
  }

  return config;
}

const formatFileSize = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
};

console.log("\n🚀 Starting build process...\n");

const cliConfig = parseArgs();
const outdir = (cliConfig.outdir as string) || path.join(process.cwd(), "dist");

if (existsSync(outdir)) {
  console.log(`🗑️ Cleaning previous build at ${outdir}`);
  await rm(outdir, { recursive: true, force: true });
}

const start = performance.now();

const entrypoints = [...new Bun.Glob("**.html").scanSync("public")]
  .map(a => path.resolve("public", a))
  .filter(dir => !dir.includes("node_modules"));
console.log(`📄 Found ${entrypoints.length} HTML ${entrypoints.length === 1 ? "file" : "files"} to process\n`);

if (entrypoints.length === 0) {
  console.error("❌ No HTML files found in public/ directory");
  process.exit(1);
}

const result = await Bun.build({
  entrypoints,
  outdir,
  plugins: [plugin],
  minify: true,
  target: "browser",
  sourcemap: "none",
  // NOTE: Force absolute asset paths so deep BrowserRouter routes (e.g.
  // /settings/profile) don't resolve "./index-abc.js" against the current
  // pathname and 404. Without this, Bun emits relative paths that only
  // work at the document root.
  publicPath: process.env.BUN_PUBLIC_CDN_URL
    ? `${process.env.BUN_PUBLIC_CDN_URL.replace(/\/$/, "")}/`
    : "/",
  naming: {
    entry: "[dir]/[name]-[hash].[ext]",
    chunk: "[name]-[hash].[ext]",
    asset: "[name]-[hash].[ext]",
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env.BUN_PUBLIC_CDN_URL": JSON.stringify(
      process.env.BUN_PUBLIC_CDN_URL || "",
    ),
    "process.env.BUN_PUBLIC_VERSION": JSON.stringify(APP_VERSION),
    // Distribution edition. Defaults to "full" so the master and any plain `bun run build`
    // yield the Full app; the Free derivation flips the fallback to "free" (# @edition-arg).
    "process.env.BUN_PUBLIC_EDITION": JSON.stringify(
      process.env.BUN_PUBLIC_EDITION || "free",
    ),
  },
  ...cliConfig,
});

const end = performance.now();

if (!result.success) {
  console.error("❌ Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const outputTable = result.outputs.map(output => ({
  File: path.relative(process.cwd(), output.path),
  Type: output.kind,
  Size: formatFileSize(output.size),
}));

console.table(outputTable);
const buildTime = (end - start).toFixed(2);

console.log(`\n✅ Build completed in ${buildTime}ms\n`);

for (const output of result.outputs) {
  if (output.kind === "entry-point" && output.path.endsWith(".html")) {
    const dir = path.dirname(output.path);
    const originalName = path.basename(output.path).replace(/-[a-z0-9]+\.html$/, ".html");
    const dest = path.join(dir, originalName);
    if (output.path !== dest) {
      await rename(output.path, dest);
      console.log(`📝 Renamed ${path.basename(output.path)} → ${originalName}`);
    }
  }
}

const cdnUrl = process.env.BUN_PUBLIC_CDN_URL?.replace(/\/$/, "");
if (cdnUrl) {
  const htmlPath = path.join(outdir, "index.html");
  const html = await Bun.file(htmlPath).text();
  const { html: rewrittenHtml, rewritten } = rewriteAssetUrlsForCdn(
    html,
    cdnUrl,
  );
  if (rewritten > 0) {
    await Bun.write(htmlPath, rewrittenHtml);
    console.log(
      `🌐 Pointed ${rewritten} url() reference(s) in index.html at the CDN\n`,
    );
  }
  // NOTE: anything still relative is an asset the CDN rewrite did not reach, which would be served
  // from the application origin while everything else moves. Failing by name beats shipping that.
  const missed = findNonAbsoluteUrls(rewrittenHtml);
  if (missed.length > 0) {
    throw new Error(
      `index.html still points at the application origin for: ${missed.join(", ")}`,
    );
  }
}

const assetsSource = path.join(process.cwd(), "public", "assets");
const assetsDest = path.join(outdir, "assets");

if (existsSync(assetsSource)) {
  console.log("📁 Copying static assets...");
  await cp(assetsSource, assetsDest, { recursive: true });
  console.log(`   └── Copied public/assets → dist/assets\n`);
}
