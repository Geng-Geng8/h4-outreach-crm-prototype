import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

test("Pages publishes matching content-versioned scripts/styles and base paths for cached HTML", async () => {
  execFileSync(process.execPath, ["scripts/build-pages.mjs"], { env: { ...process.env, H4_API_ORIGIN: "https://example-api.workers.dev" }, stdio: "pipe" });
  const html = await readFile(".wrangler/pages/index.html", "utf8");
  assert.match(html, /name="h4-api-origin" content="https:\/\/example-api.workers.dev"/);
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest\?v=1"/);
  assert.match(html, /name="apple-mobile-web-app-title" content="H4 Outreach"/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\.\/assets\/icons\/h4-outreach-v1-180\.png"/);
  const manifest = JSON.parse(await readFile(".wrangler/pages/manifest.webmanifest", "utf8"));
  assert.equal(manifest.name, "H4 Outreach"); assert.equal(manifest.short_name, "H4 Outreach");
  assert.equal(manifest.start_url, "./"); assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) {
    assert.match(icon.purpose, /maskable/);
    const png = await readFile(`.wrangler/pages/${icon.src.replace(/^\.\//, "")}`);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
  for (const size of [48, 180]) {
    const png = await readFile(`.wrangler/pages/assets/icons/h4-outreach-v1-${size}.png`);
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
  }
  for (const file of ["app.js", "styles.css", "editor.css"]) {
    const source = await readFile(`public/${file}`);
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
    const dot = file.lastIndexOf("."); const versioned = `${file.slice(0, dot)}.${hash}${file.slice(dot)}`;
    assert.ok(html.includes(`./${versioned}`), `${file} must reference its matching version`);
    assert.ok(!html.includes(`./${file}"`), `${file} must not use the unversioned path on a new page`);
    assert.deepEqual(await readFile(`.wrangler/pages/${versioned}`), source);
    assert.deepEqual(await readFile(`.wrangler/pages/${file}`), source);
  }
  for (const name of await readdir(".wrangler/pages")) {
    assert.match(name, /^(?:index\.html|manifest\.webmanifest|\.nojekyll|assets|(?:app|styles|editor)(?:\.[a-f0-9]{12})?\.(?:js|css))$/);
  }
});
