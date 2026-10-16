import { build } from "esbuild";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { parseEnv } from "node:util";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const testSheetId = "1QzYTKdeWWa2TpOtGSmJ0NDMeY_U-u3ImeCVdpCmJrH4";
export async function readOnlyScript() {
  const result = await build({ entryPoints: [resolve(root, "src/read-only.ts")], bundle: true,
    format: "esm", platform: "browser", target: "es2022", write: false, external: ["cloudflare:workers"] });
  return result.outputFiles[0].text;
}
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/editor.css", ["editor.css", "text/css; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ...[48, 180, 192, 512].map((size) => [`/assets/icons/h4-outreach-v1-${size}.png`, [`assets/icons/h4-outreach-v1-${size}.png`, "image/png"]]),
  ["/assets/H4_Logos_BLACK.png", ["assets/H4_Logos_BLACK.png", "image/png"]],
  ["/assets/H4_Logos_GOLD.png", ["assets/H4_Logos_GOLD.png", "image/png"]],
  ["/assets/H4_Logos_ORANGE.png", ["assets/H4_Logos_ORANGE.png", "image/png"]],
  ["/assets/H4_Logos_SILVER.png", ["assets/H4_Logos_SILVER.png", "image/png"]],
]);
export async function staticAssets(request) {
  if (!["GET", "HEAD"].includes(request.method)) return new Response("Read-only preview", { status: 405 });
  const file = files.get(new URL(request.url).pathname);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : await readFile(resolve(root, "public", file[0])), {
    headers: { "content-type": file[1] },
  });
}

export async function localBindings() {
  let local = {};
  try { local = parseEnv(await readFile(resolve(root, ".dev.vars"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("LOCAL_CONFIG_UNREADABLE"); }
  const bindings = {
    GOOGLE_SHEET_ID: testSheetId, ALLOWED_ORIGIN: "http://localhost:8787",
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? local.GOOGLE_CLIENT_ID ?? "",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "", GOOGLE_PRIVATE_KEY: "",
    ENABLE_REAL_WRITES: process.env.ENABLE_REAL_WRITES ?? local.ENABLE_REAL_WRITES ?? "false",
  };
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? local.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) return bindings;
  try {
    if (!isAbsolute(keyPath)) throw new Error();
    const target = await realpath(keyPath);
    const repository = await realpath(root);
    const inside = relative(repository, target);
    if (!inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(inside)) throw new Error();
    const key = JSON.parse(await readFile(target, "utf8"));
    if (key.type !== "service_account" || typeof key.client_email !== "string" ||
        !key.client_email.endsWith(".iam.gserviceaccount.com") || typeof key.private_key !== "string") throw new Error();
    bindings.GOOGLE_SERVICE_ACCOUNT_EMAIL = key.client_email;
    bindings.GOOGLE_PRIVATE_KEY = key.private_key;
    return bindings;
  } catch { throw new Error("SERVICE_ACCOUNT_FILE_INVALID_OR_INSIDE_REPOSITORY"); }
}
