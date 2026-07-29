import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "assets"), { recursive: true });
await cp(join(root, "public"), dist, { recursive: true });
await cp(join(root, "index.html"), join(dist, "index.html"));
await cp(join(root, "methodology.html"), join(dist, "methodology.html"));
await writeFile(join(dist, "assets", "styles.css"), await readFile(join(root, "src", "styles.css")));
await writeFile(join(dist, "assets", "tokens.css"), await readFile(join(root, "src", "tokens.css")));
await build({
  entryPoints: ["app.ts", "analyze.ts", "hub.ts", "telemetry.ts"].map(entry => join(root, "src", entry)),
  outdir: join(dist, "assets"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  legalComments: "none",
  logLevel: "silent"
});
console.log(`Built ${relative(root, dist) || "dist"} deterministically.`);
