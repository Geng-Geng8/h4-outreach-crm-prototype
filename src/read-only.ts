import { ApiError } from "./schema";
import { verifyGoogleIdentity } from "./google-auth";
import { GoogleSheetsReadOnly, TEST_SHEET_ID, type ReadOnlyConfig } from "./google-sheets-read";

export { SheetCoordinator, TestSheetCoordinator } from "./index";

interface Env extends ReadOnlyConfig {
  ASSETS?: Fetcher;
  DEMO_COORDINATOR?: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  COORDINATOR?: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  TEST_COORDINATOR?: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  ENABLE_REAL_WRITES?: string;
}
const CLIENT_ID = /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;

function setup(env: Env): string[] {
  const missing: string[] = [];
  if (!env.GOOGLE_CLIENT_ID || !CLIENT_ID.test(env.GOOGLE_CLIENT_ID)) missing.push("Google sign-in client");
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.endsWith(".iam.gserviceaccount.com") || !env.GOOGLE_PRIVATE_KEY) {
    missing.push("Local service-account credentials");
  }
  if (env.GOOGLE_SHEET_ID !== TEST_SHEET_ID) missing.push("Test spreadsheet configuration");
  return missing;
}

export default (() => {
  let reader: GoogleSheetsReadOnly | undefined;
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      const allowed = env.ALLOWED_ORIGIN ?? "http://localhost:8787";
      const headers = new Headers({
        "cache-control": "no-store", "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin", "vary": "Origin",
      });
      if (origin === allowed) headers.set("access-control-allow-origin", allowed);
      const json = (status: number, body: object) => Response.json(body, { status, headers });
      if (url.pathname.startsWith("/api/")) {
        if (origin && origin !== allowed) return json(403, { ok: false, code: "ORIGIN_NOT_ALLOWED" });
        if (request.method === "OPTIONS") {
          const requested = (request.headers.get("access-control-request-headers") ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
          const reqMethod = request.headers.get("access-control-request-method");
          const isPostClaim = ["/api/demo/claim", "/api/schools/claim", "/api/schools/update", "/api/activities", "/api/operator/recovery"].includes(url.pathname) && reqMethod === "POST";
          if ((reqMethod !== "GET" && !isPostClaim) ||
              requested.some((header) => !["authorization", "content-type"].includes(header))) {
            return json(405, { ok: false, code: "READ_ONLY_MODE" });
          }
          headers.set("access-control-allow-methods", isPostClaim ? "POST, OPTIONS" : "GET, OPTIONS");
          headers.set("access-control-allow-headers", "Authorization, Content-Type");
          headers.set("access-control-max-age", "600");
          return new Response(null, { status: 204, headers });
        }
        if (request.method !== "GET" && !(request.method === "POST" && ["/api/demo/claim", "/api/schools/claim", "/api/schools/update", "/api/activities", "/api/operator/recovery"].includes(url.pathname))) {
          headers.set("allow", "GET, OPTIONS");
          return json(405, { ok: false, code: "READ_ONLY_MODE" });
        }
        const writesEnabled = env.ENABLE_REAL_WRITES === "true";
        if (["/api/schools/detail", "/api/schools/update", "/api/activities"].includes(url.pathname)) {
          const expectedMethod = url.pathname.endsWith("/detail") ? "GET" : "POST";
          if (request.method !== expectedMethod) return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
          // Leave disabled-write probes inert, as in earlier read-only milestones.
          if (!writesEnabled) return json(405, { ok: false, code: "READ_ONLY_MODE" });
          try {
            if (setup(env).length) throw new ApiError(503, "GOOGLE_SETUP_REQUIRED");
            const identity = await verifyGoogleIdentity(request, env.GOOGLE_CLIENT_ID!);
            if (!reader?.matches(env)) reader = new GoogleSheetsReadOnly(env);
            const user = await reader.authorize(identity.email);
            const coordinator = env.COORDINATOR ?? env.TEST_COORDINATOR;
            if (!coordinator) throw new ApiError(503, "COORDINATOR_UNAVAILABLE");
            const target = `http://localhost${url.pathname}${expectedMethod === "GET" ? url.search : ""}`;
            const response = await coordinator.getByName(TEST_SHEET_ID).fetch(new Request(target, {
              method: expectedMethod, headers: { "content-type": "application/json", "x-proof-actor": user.email },
              ...(expectedMethod === "POST" ? { body: await request.text() } : {}),
            }));
            return json(response.status, await response.json<object>());
          } catch (error) {
            return error instanceof ApiError ? json(error.status, { ok: false, code: error.code }) : json(503, { ok: false, code: "SAVE_UNAVAILABLE" });
          }
        }
        if (url.pathname === "/api/operator/recovery") {
          try {
            if (!writesEnabled || !env.COORDINATOR) throw new ApiError(503, "REAL_WRITES_DISABLED");
            if (setup(env).length) throw new ApiError(503, "GOOGLE_SETUP_REQUIRED");
            const identity = await verifyGoogleIdentity(request, env.GOOGLE_CLIENT_ID!);
            if (!reader?.matches(env)) reader = new GoogleSheetsReadOnly(env);
            const user = await reader.authorize(identity.email);
            if (user.role !== "Supervisor") throw new ApiError(403, "SUPERVISOR_ROLE_REQUIRED");
            const response = await env.COORDINATOR.getByName(TEST_SHEET_ID).fetch(new Request("http://localhost/api/operator/recovery", {
              method: request.method, headers: { "x-proof-actor": user.email, "content-type": "application/json" },
              ...(request.method === "POST" ? { body: await request.text() } : {}),
            }));
            return json(response.status, await response.json<object>());
          } catch (error) {
            return error instanceof ApiError ? json(error.status, { ok: false, code: error.code }) : json(503, { ok: false, code: "RECOVERY_UNAVAILABLE" });
          }
        }
        if (url.pathname === "/api/health") return json(200, { ok: true, mode: writesEnabled ? "controlled-write" : "read-only", writesEnabled });
        if (url.pathname === "/api/config") {
          const missing = setup(env);
          return json(200, {
            ok: true, mode: writesEnabled ? "controlled-write" : "read-only", writesEnabled, ready: missing.length === 0,
            googleClientId: env.GOOGLE_CLIENT_ID && CLIENT_ID.test(env.GOOGLE_CLIENT_ID) ? env.GOOGLE_CLIENT_ID : "",
            missing, demoAvailable: !!env.DEMO_COORDINATOR,
          });
        }
        if (url.pathname === "/api/schools/claim") {
          const auth = request.headers.get("authorization");
          if (request.method !== "POST" || !auth || !auth.startsWith("Bearer ")) {
            headers.set("allow", "GET, OPTIONS");
            return json(405, { ok: false, code: "READ_ONLY_MODE" });
          }
          try {
            if (setup(env).length) throw new ApiError(503, "GOOGLE_SETUP_REQUIRED");
            const identity = await verifyGoogleIdentity(request, env.GOOGLE_CLIENT_ID!);
            if (!reader?.matches(env)) reader = new GoogleSheetsReadOnly(env);
            const crmUser = await reader.authorize(identity.email);

            if (!writesEnabled) {
              return json(503, {
                ok: false,
                code: "REAL_WRITES_DISABLED",
                writesEnabled: false,
                message: "Real spreadsheet writes are disabled by default. A controlled single-writer setup and supervisor write approval are required before live writes.",
              });
            }

            const coordinator = env.COORDINATOR ?? env.TEST_COORDINATOR;
            if (!coordinator) {
              return json(503, {
                ok: false,
                code: "COORDINATOR_UNAVAILABLE",
                message: "Test spreadsheet coordinator is not configured.",
              });
            }

            const body: { osn?: unknown; requestId?: unknown } = await request.json<{ osn?: unknown; requestId?: unknown }>().catch(() => ({}));
            const osn = String(body.osn ?? "").trim();
            if (!osn) throw new ApiError(422, "MISSING_OSN");
            if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) throw new ApiError(422, "INVALID_REQUEST_ID");
            const requestId = body.requestId;

            const coordinatorReq = new Request("http://localhost/api/schools/claim", {
              method: "POST",
              headers: { "content-type": "application/json", "x-proof-actor": crmUser.email },
              body: JSON.stringify({ osn, requestId }),
            });
            const coordinatorRes = await coordinator.getByName(env.GOOGLE_SHEET_ID ?? TEST_SHEET_ID).fetch(coordinatorReq);
            const resBody = await coordinatorRes.json<{ ok: boolean; code: string; record?: unknown; replayed?: boolean }>();
            if (!coordinatorRes.ok) return json(coordinatorRes.status, resBody);
            const source = (resBody.record ?? {}) as Record<string, unknown>;
            const visibleRecord = Object.fromEntries(["recordId", "schoolName", "ownerEmail", "lastRequestId", "stage", "followUpCount", "followUpDue"].map((key) => [key, source[key]]));
            return json(200, {
              ok: true, code: "SUCCESS",
              message: "School claimed successfully", record: visibleRecord,
              ...(resBody.replayed ? { replayed: true } : {}),
            });
          } catch (error) {
            return error instanceof ApiError
              ? json(error.status, { ok: false, code: error.code })
              : json(503, { ok: false, code: "CLAIM_FAILED" });
          }
        }
        if (url.pathname === "/api/demo/schools") {
          let claimedOsns: Set<string>;
          if (env.DEMO_COORDINATOR) {
            try {
              const stateRes = await env.DEMO_COORDINATOR.getByName("synthetic-h4").fetch(
                new Request("http://localhost/api/schools/demo-status", { method: "GET" })
              );
              if (!stateRes.ok) throw new Error();
              const stateData = await stateRes.json<{ ok: boolean; claimedOsns: string[] }>();
              if (!stateData.ok || !Array.isArray(stateData.claimedOsns)) throw new Error();
              claimedOsns = new Set(stateData.claimedOsns);
            } catch {
              return json(503, {
                ok: false, code: "COORDINATOR_UNAVAILABLE",
                message: "Availability unavailable",
              });
            }
          } else {
            return json(503, {
              ok: false, code: "DEMO_UNAVAILABLE",
              message: "Availability unavailable",
            });
          }
          const INVENTED_SCHOOLS = [
            { osn: "900001", schoolName: "Maple Example Secondary", schoolBoard: "EXAMPLE", schoolLevel: "Secondary", city: "Example City" },
            { osn: "900002", schoolName: "Example School 2", schoolBoard: "EXAMPLE", schoolLevel: "Secondary", city: "Example City" },
            { osn: "900003", schoolName: "Example School 3", schoolBoard: "EXAMPLE", schoolLevel: "Secondary", city: "Example City" },
            { osn: "900004", schoolName: "Example School 4", schoolBoard: "EXAMPLE", schoolLevel: "Secondary", city: "Example City" },
          ];
          return json(200, {
            ok: true, demo: true,
            label: "Synthetic test data only — not connected to real Google Sheets",
            schools: INVENTED_SCHOOLS.map((s) => ({
              ...s,
              available: !claimedOsns.has(s.osn),
            })),
          });
        }
        if (url.pathname === "/api/demo/claim") {
          if (request.method !== "POST") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
          if (!env.DEMO_COORDINATOR) return json(503, { ok: false, code: "DEMO_UNAVAILABLE" });
          try {
            if (setup(env).length) throw new ApiError(503, "GOOGLE_SETUP_REQUIRED");
            const identity = await verifyGoogleIdentity(request, env.GOOGLE_CLIENT_ID!);
            if (!reader?.matches(env)) reader = new GoogleSheetsReadOnly(env);
            // Requirement 1: Verify active CRM membership against real CRM Users; fail closed for unlisted/inactive.
            const crmUser = await reader.authorize(identity.email);
            // Requirement 1: Explicitly map to an isolated synthetic actor. Never copy real identities into fixtures.
            const demoActor = crmUser.role === "Supervisor" ? "morgan@example.test" : "alex@example.test";

            const body: { osn?: unknown; requestId?: unknown } = await request.json<{ osn?: unknown; requestId?: unknown }>().catch(() => ({}));
            const osn = String(body.osn ?? "").trim();
            const INVENTED_OSNS = ["900001", "900002", "900003", "900004"];
            if (!INVENTED_OSNS.includes(osn)) {
              return json(422, {
                ok: false, code: "DEMO_INVENTED_SCHOOLS_ONLY",
                message: "Synthetic demo claiming only works with invented demo schools (900001-900004). Real schools cannot be claimed in demo mode.",
              });
            }
            const requestId = typeof body?.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)
              ? body.requestId : crypto.randomUUID();
            const coordinatorReq = new Request("http://localhost/api/schools/claim", {
              method: "POST",
              headers: { "content-type": "application/json", "x-proof-actor": demoActor },
              body: JSON.stringify({ osn, requestId }),
            });
            const coordinatorRes = await env.DEMO_COORDINATOR.getByName("synthetic-h4").fetch(coordinatorReq);
            const resBody = await coordinatorRes.json<{ ok: boolean; code: string; record?: unknown }>();
            if (!coordinatorRes.ok) return json(coordinatorRes.status, resBody);
            return json(200, {
              ok: true, code: "SUCCESS", demo: true,
              message: "Demo claim saved — test data only", record: resBody.record,
            });
          } catch (error) {
            return error instanceof ApiError
              ? json(error.status, { ok: false, code: error.code })
              : json(503, { ok: false, code: "DEMO_CLAIM_FAILED" });
          }
        }
        if (url.pathname === "/api/directory") {
          try {
            if (setup(env).length) throw new ApiError(503, "GOOGLE_SETUP_REQUIRED");
            const identity = await verifyGoogleIdentity(request, env.GOOGLE_CLIENT_ID!);
            if (!reader?.matches(env)) reader = new GoogleSheetsReadOnly(env);
            await reader.authorize(identity.email);
            const directory = await reader.directory();
            return json(200, { ok: true, mode: "read-only", writesEnabled: false, directory });
          } catch (error) {
            return error instanceof ApiError
              ? json(error.status, { ok: false, code: error.code })
              : json(503, { ok: false, code: "GOOGLE_CONNECTION_UNAVAILABLE" });
          }
        }
        if (url.pathname === "/api/dashboard") {
          try {
            if (setup(env).length) throw new ApiError(503, "GOOGLE_SETUP_REQUIRED");
            const identity = await verifyGoogleIdentity(request, env.GOOGLE_CLIENT_ID!);
            if (!reader?.matches(env)) reader = new GoogleSheetsReadOnly(env);
            const user = await reader.authorize(identity.email);
            return json(200, { ok: true, schools: await reader.teamSchools(user) });
          } catch (error) {
            return error instanceof ApiError
              ? json(error.status, { ok: false, code: error.code })
              : json(503, { ok: false, code: "GOOGLE_CONNECTION_UNAVAILABLE" });
          }
        }
        if (url.pathname !== "/api/bootstrap") return json(404, { ok: false, code: "NOT_FOUND" });
        try {
          if (setup(env).length) throw new ApiError(503, "GOOGLE_SETUP_REQUIRED");
          const identity = await verifyGoogleIdentity(request, env.GOOGLE_CLIENT_ID!);
          if (!reader?.matches(env)) reader = new GoogleSheetsReadOnly(env);
          const user = await reader.authorize(identity.email);
          const schools = await reader.schools(user);
          return json(200, {
            ok: true, mode: "read-only", writesEnabled: false,
            currentUser: { ...user, subject: identity.subject }, sessionExpiresAt: identity.expiresAt,
            schools, visibility: {
              scope: user.role === "Supervisor" ? "all-school-summaries" : "assigned-school-summaries",
              privateNotes: false, contacts: false, activities: false,
            },
          });
        } catch (error) {
          return error instanceof ApiError
            ? json(error.status, { ok: false, code: error.code })
            : json(503, { ok: false, code: "GOOGLE_CONNECTION_UNAVAILABLE" });
        }
      }
      if (!env.ASSETS) return json(404, { ok: false, code: "NOT_FOUND" });
      const asset = await env.ASSETS.fetch(request);
      const safe = new Response(asset.body, asset);
      headers.forEach((value, key) => safe.headers.set(key, value));
      safe.headers.set("cross-origin-opener-policy", "same-origin-allow-popups");
      safe.headers.set("content-security-policy", [
        "default-src 'self'", "script-src 'self' https://accounts.google.com/gsi/client",
        "style-src 'self' https://accounts.google.com/gsi/style", "frame-src https://accounts.google.com",
        "connect-src 'self' https://accounts.google.com/gsi/", "img-src 'self' data:",
        "base-uri 'self'", "form-action 'none'", "frame-ancestors 'none'",
      ].join("; "));
      return safe;
    },
  } satisfies ExportedHandler<Env>;
})();
