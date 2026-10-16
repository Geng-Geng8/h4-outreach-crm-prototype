import { Miniflare, Log, LogLevel } from "miniflare";
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT, jwtVerify } from "jose";
import { readOnlyScript, staticAssets, testSheetId } from "../scripts/local-runtime.mjs";
import { fixture, FakeSheets, ACTOR, OTHER, SUPERVISOR, C } from "./harness.mjs";

export { ACTOR, OTHER, SUPERVISOR };
export const CLIENT = "1234567890-h4-readonly-test.apps.googleusercontent.com";
export const SERVICE = "h4-read-only@fixture-project.iam.gserviceaccount.com";
export const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
let generated;
async function keys() {
  generated ??= (async () => {
    const [google, service] = await Promise.all([
      generateKeyPair("RS256", { extractable: true }), generateKeyPair("RS256", { extractable: true }),
    ]);
    const jwk = { ...await exportJWK(google.publicKey), kid: "fixture-google-key", alg: "RS256", use: "sig" };
    return { google, service, jwk, pem: await exportPKCS8(service.privateKey) };
  })();
  return generated;
}
let script;
export async function readHarness(t, overrides = {}) {
  const key = await keys();
  const tables = fixture();
  // One school belongs to another student. Private fields carry conspicuous
  // sentinels so accidental disclosure is visible in both reads and responses.
  const row = structuredClone(tables.Schools[1]);
  row[C.id] = "00000000-0000-4000-8000-000000000099"; row[C.name] = "Other Student School";
  row[C.assigned] = "Sam"; row[C.owner] = OTHER;
  tables.Schools.push(row);
  for (const school of tables.Schools.slice(1)) {
    school[C.notes] = "PRIVATE_NOTES_MUST_NOT_LEAK";
    school[C.email] = "PRIVATE_CONTACT_MUST_NOT_LEAK";
    school[C.phone] = "PRIVATE_PHONE_MUST_NOT_LEAK";
    school[30] = "PRIVATE_SOCIAL_MUST_NOT_LEAK";
  }
  const calls = [], assertions = [], unexpected = [];
  let sheetError = 0, tokenError = 0, jwksError = 0;
  const env = { GOOGLE_CLIENT_ID: CLIENT, GOOGLE_SHEET_ID: testSheetId,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE, GOOGLE_PRIVATE_KEY: key.pem,
    ALLOWED_ORIGIN: "http://localhost:8787", ...overrides };

  async function google(request) {
    const url = new URL(request.url);
    calls.push({ host: url.hostname, path: url.pathname, method: request.method, ranges: url.searchParams.getAll("ranges") });
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs" && request.method === "GET") {
      return jwksError ? new Response("Unavailable", { status: jwksError }) :
        Response.json({ keys: [key.jwk] }, { headers: { "cache-control": "public, max-age=3600" } });
    }
    if (url.href === "https://oauth2.googleapis.com/token" && request.method === "POST") {
      const form = await request.formData();
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") throw new Error("Invalid grant");
      const { payload } = await jwtVerify(form.get("assertion"), key.service.publicKey, {
        algorithms: ["RS256"], issuer: SERVICE, audience: "https://oauth2.googleapis.com/token",
      });
      if (payload.scope !== SCOPE && !(overrides.GOOGLE_ADAPTER_TEST === "true" && payload.scope === "https://www.googleapis.com/auth/spreadsheets")) throw new Error("Unexpected scope");
      assertions.push(payload);
      if (tokenError) return new Response("PRIVATE_UPSTREAM_ERROR_MUST_NOT_LEAK", { status: tokenError });
      return Response.json({ access_token: "fixture-service-access-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.hostname === "sheets.googleapis.com" &&
        url.pathname === `/v4/spreadsheets/${testSheetId}/values:batchGet` && request.method === "GET") {
      if (request.headers.get("authorization") !== "Bearer fixture-service-access-token") throw new Error("Wrong Sheets credential");
      if (sheetError) return new Response("PRIVATE_UPSTREAM_ERROR_MUST_NOT_LEAK", { status: sheetError });
      if (overrides.GOOGLE_ADAPTER_TEST === "true" && url.searchParams.get("valueRenderOption") === "FORMULA") {
        return Response.json({ valueRanges: Object.entries(demoSheets.tables).map(([tab, values]) => ({ range: tab, values })) });
      }
      const valueRanges = url.searchParams.getAll("ranges").map((range) => {
        if (range === "'CRM Users'!A1:D1000" || range === "'CRM Users'!A:D") return { range, values: tables["CRM Users"] };
        if (range === "'School Directory'!A1:O1000" || range === "'School Directory'!A:O") return { range, values: tables["School Directory"] };
        const selected = new Map([
          ["'Schools'!A1:D1000", [0, 1, 2, 3]], ["'Schools'!A:D", [0, 1, 2, 3]],
          ["'Schools'!I1:I1000", [8]], ["'Schools'!I:I", [8]],
          ["'Schools'!I1:K1000", [8, 9, 10]],
          ["'Schools'!M1:M1000", [12]], ["'Schools'!M:M", [12]],
          ["'Schools'!S1:S1000", [18]], ["'Schools'!S:S", [18]],
          ["'Schools'!Z1:Z1000", [25]], ["'Schools'!Z:Z", [25]],
          ["'Schools'!A1:B1000", [0, 1]], ["'Schools'!A:B", [0, 1]],
          ["'Schools'!Y1:Y1000", [24]], ["'Schools'!Y:Y", [24]],
        ]).get(range);
        if (!selected) { unexpected.push(range); throw new Error("Private or unknown range requested"); }
        return { range, values: tables.Schools.map((row) => selected.map((column) => row[column] ?? "")) };
      });
      return Response.json({ valueRanges });
    }
    if (overrides.GOOGLE_ADAPTER_TEST === "true" && url.href === `https://sheets.googleapis.com/v4/spreadsheets/${testSheetId}/values:batchUpdate` && request.method === "POST") {
      if (request.headers.get("authorization") !== "Bearer fixture-service-access-token") throw new Error("Wrong credential");
      demoSheets.attempts++;
      demoSheets.apply(await request.json());
      return Response.json({ totalUpdatedCells: 45 });
    }
    unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
    return new Response("Unexpected network request", { status: 500 });
  }
  script ??= readOnlyScript();
  const demoSheets = new FakeSheets();
  const mf = new Miniflare({
    name: "h4-read-only-test", modules: true, script: await script, compatibilityDate: "2026-07-01",
    cf: false, log: new Log(LogLevel.ERROR),
    bindings: { PROOF_MODE: "synthetic", PROOF_TODAY: "2026-10-15", ...env },
    durableObjects: {
      DEMO_COORDINATOR: { className: "SheetCoordinator", useSQLite: true },
      COORDINATOR: { className: overrides.GOOGLE_ADAPTER_TEST === "true" ? "TestSheetCoordinator" : "SheetCoordinator", useSQLite: true },
    },
    serviceBindings: { ASSETS: staticAssets, SHEETS: (request) => demoSheets.fetch(request) },
    outboundService: google,
  });
  t.after(async () => { await mf.dispose(); if (unexpected.length) throw new Error(`Unexpected requests: ${unexpected.join(", ")}`); });
  await mf.ready;
  async function token(claims = {}, options = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: "fixture-alex-subject", email: ACTOR, email_verified: true, hd: "example.test",
      aud: CLIENT, iss: "https://accounts.google.com", iat: now, exp: now + 3600, ...claims };
    for (const field of options.omit ?? []) delete payload[field];
    return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "fixture-google-key", ...options.header })
      .sign(options.privateKey ?? key.google.privateKey);
  }
  async function request(path, { method = "GET", token: bearer, headers = {}, body } = {}) {
    return mf.dispatchFetch(`http://localhost:8787${path}`, {
      method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
      ...(body !== undefined ? { body } : {}),
    });
  }
  async function bootstrap(bearer, headers) {
    const response = await request("/api/bootstrap", { token: bearer, headers });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function directory(bearer, headers) {
    const response = await request("/api/directory", { token: bearer, headers });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function demoClaim(bearer, body, headers) {
    const response = await request("/api/demo/claim", {
      method: "POST", token: bearer,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function claimSchool(bearer, body, headers) {
    const response = await request("/api/schools/claim", {
      method: "POST", token: bearer,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { tables, calls, assertions, token, request, bootstrap, directory, demoClaim, claimSchool, demoSheets,
    fault(kind, status) { if (kind === "sheet") sheetError = status; else if (kind === "token") tokenError = status; else jwksError = status; },
  };
}
