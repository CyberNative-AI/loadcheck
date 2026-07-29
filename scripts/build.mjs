import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "assets"), { recursive: true });
await cp(join(root, "public"), dist, { recursive: true });
await cp(join(root, "index.html"), join(dist, "index.html"));
await cp(join(root, "methodology.html"), join(dist, "methodology.html"));
for (const entry of await readdir(join(root, "src"))) {
  const source = join(root, "src", entry);
  if (!entry.endsWith(".ts") && !entry.endsWith(".css")) continue;
  const target = join(dist, "assets", entry.replace(/\.ts$/, ".js"));
  await writeFile(target, await readFile(source));
}
console.log(`Built ${relative(root, dist) || "dist"} deterministically.`);
