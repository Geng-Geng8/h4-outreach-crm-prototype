import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const artifactDir = "C:\\Users\\glen_\\.gemini\\antigravity-ide\\brain\\8dfa3f68-358a-452a-ab22-7178420adf63";
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 8795;
const cdpPort = 9229;

console.log("Starting browser-fixture...");
const fixture = spawn("node", ["test/browser-fixture.mjs"], {
  env: { ...process.env, H4_FIXTURE_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

fixture.stdout.on("data", (d) => process.stdout.write("[fixture] " + d));
fixture.stderr.on("data", (d) => process.stderr.write("[fixture-err] " + d));

// Wait for fixture to be ready
await new Promise((r) => setTimeout(r, 2000));

console.log("Launching headless Chrome on port", cdpPort);
const chrome = spawn(chromePath, [
  `--remote-debugging-port=${cdpPort}`,
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" });

await new Promise((r) => setTimeout(r, 1500));

try {
  // Query CDP version endpoint
  const versionRes = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  const versionData = await versionRes.json();
  const listRes = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const pages = await listRes.json();
  const targetPage = pages.find((p) => p.type === "page");
  const pageWsUrl = targetPage?.webSocketDebuggerUrl;
  if (!pageWsUrl) throw new Error("No page target found: " + JSON.stringify(pages));

  console.log("Connecting to CDP WebSocket for page:", pageWsUrl);
  const ws = new WebSocket(pageWsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(data.error);
      else resolve(data.result);
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Page.enable");
  await send("Runtime.enable");

  const setViewport = async (width, height, isMobile = false) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: isMobile,
    });
  };

  const capture = async (filename) => {
    // Hide fixture banner in screenshot for clean look
    await send("Runtime.evaluate", {
      expression: `document.querySelectorAll('.fixture-banner').forEach(el => el.remove());`
    });
    const res = await send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.data, "base64");
    const filepath = path.join(artifactDir, filename);
    await fs.writeFile(filepath, buffer);
    console.log("Saved screenshot:", filepath);
  };

  const evaluate = async (expression) => {
    return (await send("Runtime.evaluate", { expression, awaitPromise: true })).result?.value;
  };

  // 1. Navigate to Sign-in Screen
  console.log("Navigating to app...");
  await send("Page.navigate", { url: `http://localhost:${port}/` });
  await new Promise((r) => setTimeout(r, 1500));

  // Desktop Sign-in
  await setViewport(1280, 800, false);
  await new Promise((r) => setTimeout(r, 300));
  await capture("desktop_signin.png");

  // Mobile Sign-in
  await setViewport(390, 844, true);
  await new Promise((r) => setTimeout(r, 300));
  await capture("mobile_signin.png");

  // 2. Click "Sign in as Alex (fixture)"
  console.log("Signing in as Alex...");
  await evaluate(`
    const btn = Array.from(document.querySelectorAll('#google-button button')).find(b => b.textContent.includes('Alex'));
    if (btn) btn.click();
  `);
  await new Promise((r) => setTimeout(r, 2000));

  // Desktop Schools View
  await setViewport(1280, 800, false);
  await new Promise((r) => setTimeout(r, 500));
  await capture("desktop_schools.png");

  // Mobile Schools View
  await setViewport(390, 844, true);
  await new Promise((r) => setTimeout(r, 500));
  await capture("mobile_schools.png");

  // 3. Open School Editor (Edit details form)
  console.log("Opening Edit school dialog...");
  await evaluate(`
    const card = document.querySelector('.school-open');
    if (card) card.click();
  `);
  await new Promise((r) => setTimeout(r, 1200));

  // Desktop Edit School
  await setViewport(1280, 800, false);
  await new Promise((r) => setTimeout(r, 300));
  await capture("desktop_edit_school.png");

  // Mobile Edit School
  await setViewport(390, 844, true);
  await new Promise((r) => setTimeout(r, 300));
  await capture("mobile_edit_school.png");

  // 4. Close and Open Outreach Form (Log outreach)
  console.log("Opening Log outreach dialog...");
  await evaluate(`
    document.getElementById('editor-close')?.click();
  `);
  await new Promise((r) => setTimeout(r, 500));
  await evaluate(`
    const logBtn = document.querySelector('.school-log');
    if (logBtn) logBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 1200));

  // Desktop Log Outreach
  await setViewport(1280, 800, false);
  await new Promise((r) => setTimeout(r, 300));
  await capture("desktop_log_outreach.png");

  // Mobile Log Outreach
  await setViewport(390, 844, true);
  await new Promise((r) => setTimeout(r, 300));
  await capture("mobile_log_outreach.png");

  ws.close();
} catch (err) {
  console.error("Screenshot capture error:", err);
} finally {
  console.log("Cleaning up processes...");
  chrome.kill();
  fixture.kill();
}
