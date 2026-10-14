// The id build.ts inlines into the console bundle and writes to dist/build.json (docs/routing.md,
// "A tab older than the server"). Derived from the inputs and never from the clock, because CI builds
// the same tree more than once (the CDN upload and each image architecture) and every copy has to
// inline the same id, or the image's document names bundles the CDN never received.

// The Docker context drops `*.md`, so they are not inputs.
const INPUT_GLOB = "{src,public}/**";
const ROOT_INPUTS = ["package.json", "bun.lock", "build.ts"];

export async function buildId({
  root = ".",
  version,
  env,
}: {
  root?: string;
  version: string;
  env: Record<string, string | undefined>;
}): Promise<string> {
  const files = [...new Bun.Glob(INPUT_GLOB).scanSync(root), ...ROOT_INPUTS]
    .filter((file) => !file.endsWith(".md"))
    .sort();
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    const content = Bun.file(`${root}/${file}`);
    if (!(await content.exists())) continue;
    hasher.update(`${file}\0`);
    hasher.update(await content.arrayBuffer());
  }
  hasher.update(
    `${env.BUN_PUBLIC_CDN_URL ?? ""}\0${env.BUN_PUBLIC_EDITION ?? ""}`,
  );
  return `${version}+${hasher.digest("hex").slice(0, 12)}`;
}
