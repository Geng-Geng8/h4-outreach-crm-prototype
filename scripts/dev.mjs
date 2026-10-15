import { Miniflare, Log, LogLevel } from "miniflare";
import { readOnlyScript, staticAssets, localBindings } from "./local-runtime.mjs";
import { resolve } from "node:path";
import { root } from "./local-runtime.mjs";

try {
  const bindings = await localBindings();
  const mf = new Miniflare({
    name: "h4-read-only-local", modules: true, script: await readOnlyScript(),
    compatibilityDate: "2026-07-01", cf: false, host: "127.0.0.1", port: 8787,
    bindings: { ...bindings, PROOF_MODE: "disabled" },
    durableObjects: { COORDINATOR: { className: "TestSheetCoordinator", useSQLite: true } },
    durableObjectsPersist: resolve(root, ".wrangler/local-coordinator"),
    serviceBindings: { ASSETS: staticAssets },
    log: new Log(LogLevel.ERROR),
  });
  const address = await mf.ready;
  console.log(`H4 test CRM: ${address.href}`);
  console.log(bindings.ENABLE_REAL_WRITES === "true" ? "Claims save to the TEST spreadsheet. Production is untouched." : "Spreadsheet writes are disabled.");
  const stop = async () => { await mf.dispose(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
} catch {
  // Config/runtime errors can contain credential material. Never echo raw errors.
  console.error("The local preview could not start. Check the port and docs/google-setup.md; keep the credential file outside the repository.");
  process.exitCode = 1;
}
