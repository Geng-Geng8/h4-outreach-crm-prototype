// Manual browser fixture ONLY. Not imported by either application entry point.
// The real app files are served with only the GIS script URL replaced in memory.
// Identity verification and Sheets reads run through the actual read-only Worker,
// using the same ephemeral signing keys / mocked Google endpoints as API tests.
import { createServer } from "node:http";
import { readHarness, ACTOR, SUPERVISOR } from "./read-only-harness.mjs";

let cleanup;
const fixturePort = Number(process.env.H4_FIXTURE_PORT || 8788);
const fixtureOrigin = `http://localhost:${fixturePort}`;
const h = await readHarness({ after(fn) { cleanup = fn; } }, { ALLOWED_ORIGIN: fixtureOrigin, ENABLE_REAL_WRITES: "true", GOOGLE_ADAPTER_TEST: "true" });
// Representative local-only progress, including an overdue task and a booking.
const sample = h.tables.Schools[1];
sample[6] = "office@example.test";
sample[8] = "Contacted"; sample[9] = "2000-01-01"; sample[10] = "2000-01-02"; sample[11] = "Call the school office about a workshop";
for (const [number, name, stage, next] of [[101, "Interested Example School", "Interested", "Confirm a time with the principal"], [102, "Booked Example School", "Booked", "Confirm workshop details"], [103, "New Example School", "Not Contacted", "Introduce H4 to the school office"]]) {
  const row = structuredClone(sample);
  row[0] = `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
  row[1] = name; row[8] = stage; row[9] = stage === "Not Contacted" ? "" : "2000-01-01";
  row[10] = "2099-01-01"; row[11] = next; row[24] = String(900000 + number);
  h.tables.Schools.push(row);
}
h.demoSheets.tables = structuredClone(h.tables);
const fixtureGoogle = `
window.google = {accounts:{id:{
  initialize(options){this.options=options},
  disableAutoSelect(){sessionStorage.removeItem("h4.fixture.actor")},
  cancel(){},
  async prompt(notification){
    const actor=sessionStorage.getItem("h4.fixture.actor");
    if(!actor){notification({isNotDisplayed:()=>true});return}
    const options=this.options;
    const response=await fetch("/fixture/token?actor="+actor+"&nonce="+encodeURIComponent(options.nonce));
    options.callback(await response.json());
  },
  renderButton(container){
    for(const [label,actor] of [["Sign in as Alex (fixture)","student"],["Sign in as Morgan (fixture)","supervisor"]]){
      const button=document.createElement("button");button.className="button";button.textContent=label;
      button.onclick=async()=>{sessionStorage.setItem("h4.fixture.actor",actor);const response=await fetch("/fixture/token?actor="+actor+"&nonce="+encodeURIComponent(this.options.nonce));this.options.callback(await response.json())};
      container.append(button);
    }
  }
}}};`;
const fixtureTools = `
document.getElementById("fixture-revoke").onclick=async()=>{await fetch("/fixture/revoke",{method:"POST"});document.getElementById("fixture-feedback").textContent="Alex access revoked in local fixture. Click Refresh."};
document.getElementById("fixture-restore").onclick=async()=>{await fetch("/fixture/restore",{method:"POST"});document.getElementById("fixture-feedback").textContent="Alex access restored in local fixture."};`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, fixtureOrigin);
    let body, type = "text/plain", status = 200, headers = {};
    if (url.pathname === "/fixture/gsi.js") { body = fixtureGoogle; type = "text/javascript"; }
    else if (url.pathname === "/fixture/tools.js") { body = fixtureTools; type = "text/javascript"; }
    else if (url.pathname === "/fixture/token") {
      body = JSON.stringify({ credential: await h.token({ nonce: url.searchParams.get("nonce"),
        email: url.searchParams.get("actor") === "supervisor" ? SUPERVISOR : ACTOR }) }); type = "application/json";
    } else if (["/fixture/revoke", "/fixture/restore"].includes(url.pathname) && request.method === "POST") {
      h.tables["CRM Users"][1][3] = url.pathname.endsWith("restore"); body = "ok";
    } else {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const reqBody = chunks.length ? Buffer.concat(chunks) : undefined;
      const upstream = await h.request(url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        body: reqBody,
      });
      const isBinary = (upstream.headers.get("content-type") ?? "").startsWith("image/");
      body = isBinary ? Buffer.from(await upstream.arrayBuffer()) : await upstream.text();
      status = upstream.status; headers = Object.fromEntries(upstream.headers);
      if (request.method === "POST" && status === 200 && ["/api/schools/claim", "/api/schools/update", "/api/activities"].includes(url.pathname)) {
        h.tables.Schools = structuredClone(h.demoSheets.tables.Schools);
      }
      type = upstream.headers.get("content-type") ?? type;
      if (url.pathname === "/api/config") body = JSON.stringify({ ...JSON.parse(body), demoAvailable: false });
      if (url.pathname === "/app.js") body = body.replace("https://accounts.google.com/gsi/client", "/fixture/gsi.js");
      if (url.pathname === "/" || url.pathname === "/index.html") {
        body = body.replace("<body>", '<body><aside class="fixture-banner">SYNTHETIC UI TEST · No Google account or real school data used. <button id="fixture-revoke" class="button">Revoke Alex</button> <button id="fixture-restore" class="button">Restore Alex</button><span id="fixture-feedback" role="status"></span></aside><script src="/fixture/tools.js" defer></script>');
      }
      if (url.pathname === "/styles.css") body += "\n.fixture-banner{background:#ffe7a0;padding:12px 22px;font:12px Arial;color:#332d1b;line-height:1.8}.fixture-banner .button{font-size:10px;margin-left:8px}#fixture-feedback{display:block}#google-button .button{margin:3px 6px 3px 0}";
    }
    delete headers["content-length"]; delete headers["content-encoding"];
    response.writeHead(status, { ...headers, "content-type": type, "cache-control": "no-store" }); response.end(body);
  } catch { response.writeHead(500); response.end("Synthetic browser fixture unavailable"); }
});
server.listen(fixturePort, "127.0.0.1", () => console.log(`Synthetic UI test only: ${fixtureOrigin}`));
const stop = async () => { server.close(); await cleanup(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
