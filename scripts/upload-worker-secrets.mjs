// Transfer the existing outside-repository key directly to Cloudflare over stdin.
// Never print credentials or write a temporary JSON key file.
import { spawn } from "node:child_process";
import { localBindings, root } from "./local-runtime.mjs";
import { resolve } from "node:path";

const bindings = await localBindings();
if (!bindings.GOOGLE_SERVICE_ACCOUNT_EMAIL || !bindings.GOOGLE_PRIVATE_KEY) {
  throw new Error("Configure the outside-repository service-account path in .dev.vars first.");
}
const child = spawn(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "secret", "bulk"], {
  cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
// Only report success/failure: upstream debug errors must not echo the key.
child.stdout.resume(); child.stderr.resume();
child.stdin.on("error", () => {});
child.stdin.end(JSON.stringify({
  GOOGLE_SERVICE_ACCOUNT_EMAIL: bindings.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY: bindings.GOOGLE_PRIVATE_KEY,
}));
const code = await new Promise((done) => { child.on("error", () => done(1)); child.on("exit", done); });
if (code !== 0) { console.error("Worker secret upload failed. Check Cloudflare sign-in and permissions."); process.exitCode = 1; }
else console.log("Uploaded the two service-account secrets to the prototype Worker.");
