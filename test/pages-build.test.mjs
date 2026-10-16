import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

test("Pages publishes matching content-versioned scripts/styles and base paths for cached HTML", async () => {
  execFileSync(process.execPath, ["scripts/build-pages.mjs"], { env: { ...process.env, H4_API_ORIGIN: "https://example-api.workers.dev" }, stdio: "pipe" });
  const html = await readFile(".wrangler/pages/index.html", "utf8");
  assert.match(html, /name="h4-api-origin" content="https:\/\/example-api.workers.dev"/);
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
    assert.match(name, /^(?:index\.html|\.nojekyll|assets|(?:app|styles|editor)(?:\.[a-f0-9]{12})?\.(?:js|css))$/);
  }
});
