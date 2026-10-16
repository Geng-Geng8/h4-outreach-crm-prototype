// Developer-only export. Sharp is already installed with the existing local tooling.
// The official H4 artwork is reused intact; no logo tracing or runtime dependency.
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = resolve(root, "public/assets/icons");
await mkdir(target, { recursive: true });
const logo = await sharp(resolve(root, "public/assets/H4_Logos_GOLD.png"))
  .trim().resize({ width: 496 }).png().toBuffer();
const mark = `data:image/png;base64,${logo.toString("base64")}`;
// The complete logo and wordmark fit inside the 80%-diameter maskable safe circle.
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="pine" x2=".85" y2="1"><stop stop-color="#244b3b"/><stop offset="1" stop-color="#102c22"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#pine)"/>
  <rect x="14" y="14" width="484" height="484" rx="100" fill="none" stroke="#e7df66" stroke-opacity=".14" stroke-width="2"/>
  <image href="${mark}" x="132" y="98" width="248" height="267"/>
  <text x="256" y="411" text-anchor="middle" fill="#f6f2df" font-family="Segoe UI,Arial,sans-serif" font-size="29" font-weight="700" letter-spacing="3.2">OUTREACH</text>
</svg>`;
await writeFile(resolve(target, "h4-outreach-master-v1.svg"), icon);
for (const size of [180, 192, 512]) {
  await sharp(Buffer.from(icon)).resize(size, size).png()
    .toFile(resolve(target, `h4-outreach-v1-${size}.png`));
}
// At browser-tab size, the monogram stays legible without miniature lettering.
const favicon = icon.replace('x="132" y="98" width="248" height="267"', 'x="118" y="108" width="276" height="296"')
  .replace(/<text[\s\S]*?<\/text>/, "");
await sharp(Buffer.from(favicon)).resize(48, 48).png().toFile(resolve(target, "h4-outreach-v1-48.png"));
console.log("Exported H4 Outreach installation icons.");
