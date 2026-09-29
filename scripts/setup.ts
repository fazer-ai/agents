import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";

import { name } from "@/../package.json";

const ROOT = process.cwd();
const REPO_NAME = path.basename(ROOT);

const SNAKE_REPO_NAME = REPO_NAME.replace(/-/g, "_");

// Order matters: longer/more specific markers must come first so they
// match before the general project-name substitution overwrites their prefix.
const SUBSTITUTIONS: [string, string][] = [
  // Postgres database identifier (snake_case, must be a valid postgres identifier)
  [`${name}_db`, `${SNAKE_REPO_NAME}_db`],
  // Environment variable prefix (SCREAMING_SNAKE_CASE)
  [
    `SERVICE_URL_${name.toUpperCase().replace(/-/g, "_")}`,
    `SERVICE_URL_${SNAKE_REPO_NAME.toUpperCase()}`,
  ],
  // Package name and general project name
  [name, REPO_NAME],
];

const IGNORES = new Set([
  "node_modules",
  ".git",
  ".venv",
  "dist",
  "build",
  "tmp",
  "logs",
  "public",
  ".next",
  "out",
]);

async function walk(dir: string): Promise<string[]> {
  let results: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const e of entries) {
    if (IGNORES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results = results.concat(await walk(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

async function main() {
  const files = await walk(ROOT);
  let fileCount = 0;
  let replaceCount = 0;
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    try {
      let content = await fs.readFile(file, "utf8");
      let modified = false;

      for (const [search, replace] of SUBSTITUTIONS) {
        if (content.includes(search)) {
          const occurrences = (content.match(new RegExp(search, "g")) || [])
            .length;
          content = content.split(search).join(replace);
          replaceCount += occurrences;
          modified = true;
        }
      }

      if (modified) {
        await fs.writeFile(file, content, "utf8");
        console.log(`Updated: ${rel}`);
        fileCount++;
      }
    } catch {
      // skip binary/unreadable files
    }
  }

  console.log(
    `Done — modified ${fileCount} file(s), replaced ${replaceCount} occurrence(s).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
