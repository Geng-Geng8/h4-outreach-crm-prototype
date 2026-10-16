import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const input = process.env.H4_API_ORIGIN ?? "";
let origin;
try {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.origin !== input || url.username || url.password) throw new Error();
  origin = url.origin;
} catch { throw new Error("Set H4_API_ORIGIN to the deployed HTTPS Worker origin (no trailing slash)."); }
const target = resolve(root, ".wrangler/pages");
await mkdir(target, { recursive: true });
const targetAssets = resolve(target, "assets");
await mkdir(targetAssets, { recursive: true });
// Explicit allowlist: no repository files or credentials enter the Pages artifact.
for (const file of ["app.js", "styles.css", "editor.css"]) {
  await copyFile(resolve(root, "public", file), resolve(target, file));
}
for (const file of ["H4_Logos_BLACK.png", "H4_Logos_GOLD.png", "H4_Logos_ORANGE.png", "H4_Logos_SILVER.png"]) {
  await copyFile(resolve(root, "public/assets", file), resolve(targetAssets, file));
}
const html = await readFile(resolve(root, "public/index.html"), "utf8");
await writeFile(resolve(target, "index.html"), html.replace('name="h4-api-origin" content=""', `name="h4-api-origin" content="${origin}"`));
await writeFile(resolve(target, ".nojekyll"), "");
console.log("Built static Pages artifact; API origin:", origin);
