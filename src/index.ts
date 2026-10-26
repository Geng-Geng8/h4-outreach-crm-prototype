import { DurableObject } from "cloudflare:workers";
import {
  ApiError, C, ContactCol, padded, record, editableRecord, contactRecord, schoolWrites,
  assertStudentPrivacy, evaluateColdEligibility, DEFAULT_DECLINE_REASON, UNRESPONSIVE_COLD_REASON, EXPLICIT_REJECTION_REASONS,
  type Batch, type Row, type Snapshot, type ValueRange,
} from "./schema";
import { SyntheticSheets } from "./sheets";
import { GoogleSheetsCoordinator } from "./google-sheets-write";
import { TEST_SHEET_ID } from "./google-sheets-read";

interface Env {
  COORDINATOR: DurableObjectNamespace<SheetCoordinator>;
  DEMO_COORDINATOR?: DurableObjectNamespace<SheetCoordinator>;
  SHEETS?: Fetcher;
  PROOF_MODE?: string;
  GOOGLE_SHEET_ID?: string;
  PROOF_TODAY?: string;
  ENABLE_REAL_WRITES?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
}

type Actor = { email: string; name: string; role: "Supervisor" | "co-op" };
type Input = Record<string, unknown>;
type Result = { status: number; body: Record<string, unknown> };
type Journal = { request_id: string; fingerprint: string; state: string; plan: string; result: string };
type Plan = { batch: Batch; result: Result };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const paths = new Set(["/api/schools/claim", "/api/schools/update", "/api/schools/contacts", "/api/activities"]);

function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
function errorResponse(error: unknown): Response {
  return error instanceof ApiError
    ? json(error.status, { ok: false, code: error.code, ...error.details })
    : json(503, { ok: false, code: "PROOF_UNAVAILABLE" });
}
function proofEnabled(env: Env) {
  if (env.ENABLE_REAL_WRITES === "true" && (env.SHEETS ||
      (env.GOOGLE_SHEET_ID === TEST_SHEET_ID && env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY))) return true;
  if (env.PROOF_MODE !== "synthetic" || !env.SHEETS) return false;
  if (env.GOOGLE_SHEET_ID === "synthetic-h4") return true;
  if (env.DEMO_COORDINATOR) return true;
  return false;
}
function text(input: unknown, max = 4000): string {
  if (typeof input !== "string" || input.length > max) throw new ApiError(422, "INVALID_TEXT");
  // RAW (or typed stringValue in a future adapter) prevents formula evaluation.
  // Do not prepend apostrophes: RAW would persist those as data.
  return input;
}
function onlyKeys(input: Input, allowed: string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new ApiError(422, "UNKNOWN_FIELD");
}
function date(input: unknown): string {
  const value = text(input, 10);
  if (value !== "" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) {
    throw new ApiError(422, "INVALID_DATE");
  }
  return value;
}
function today(env: Env): string {
  if (env.PROOF_TODAY) return date(env.PROOF_TODAY);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (name: string) => parts.find((part) => part.type === name)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function canonical(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
async function fingerprint(actor: string, path: string, input: Input): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical({ actor, path, input })));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function actorFrom(snapshot: Snapshot, email: string): Actor {
  const matches = snapshot["CRM Users"].slice(1).filter((row) => String(row[0]).toLowerCase() === email);
  if (matches.length !== 1) throw new ApiError(403, "USER_NOT_ALLOWED");
  const row = matches[0]!;
  const active = String(row[3] ?? "").trim().toUpperCase();
  if (!["", "TRUE"].includes(active) || !["Supervisor", "co-op"].includes(String(row[2]))) {
    throw new ApiError(403, "USER_NOT_ALLOWED");
  }
  return { email, name: String(row[1]), role: row[2] as Actor["role"] };
}
function writableBlank(row: Row): boolean {
  return row.every((cell, index) => index === 16 || index === 17 || cell === "");
}
function sameName(a: unknown, b: unknown): boolean {
  const normalize = (value: unknown) => String(value).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return normalize(a) === normalize(b);
}

export class SheetCoordinator extends DurableObject<Env> {
  private google?: GoogleSheetsCoordinator;

  private sheets() {
    if (this.env.SHEETS) return new SyntheticSheets(this.env.SHEETS, this.env.GOOGLE_SHEET_ID ?? "synthetic-h4");
    this.google ??= new GoogleSheetsCoordinator(this.env);
    return { read: () => this.google!.snapshot(), write: (batch: Batch) => this.google!.write(batch) };
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS operations (
      request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, plan TEXT NOT NULL, result TEXT NOT NULL
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    // External fetch() yields. Serialize the WHOLE read/check/journal/write sequence,
    // not just SQLite calls. Each upstream call has a five-second bound; Cloudflare
    // resets blockConcurrencyWhile after 30 seconds. Catch within the callback.
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/schools/detail" && request.method === "GET") {
          if (!proofEnabled(this.env)) throw new ApiError(503, "LOCAL_PROOF_DISABLED");
          const snapshot = await this.sheets().read();
          const actor = actorFrom(snapshot, request.headers.get("x-proof-actor")?.trim().toLowerCase() ?? "");
          const id = new URL(request.url).searchParams.get("recordId") ?? "";
          if (!uuid.test(id)) throw new ApiError(422, "INVALID_RECORD_ID");
          const matches = snapshot.Schools.slice(1).filter((row) => row[C.id] === id);
          if (matches.length !== 1) throw new ApiError(matches.length ? 503 : 404, "RECORD_NOT_FOUND");
          const row = padded(matches[0]);
          if (actor.role !== "Supervisor" && String(row[C.owner]).toLowerCase() !== actor.email) throw new ApiError(403, "NOT_OWNER");
          const contacts = (snapshot.Contacts?.slice(1) ?? [])
            .filter((cRow) => cRow[ContactCol.recordId] === id && String(cRow[ContactCol.active]).trim().toUpperCase() === "TRUE")
            .map(contactRecord);
          return json(200, { ok: true, record: editableRecord(row), contacts });
        }
        if (request.method === "GET" && pathname === "/api/schools/demo-status") {
          if (!proofEnabled(this.env)) throw new ApiError(503, "LOCAL_PROOF_DISABLED");
          const sheets = this.sheets();
          const snapshot = await sheets.read();
          const claimedOsns = new Set<string>();
          for (const row of snapshot.Schools.slice(1)) {
            const osn = String(row[C.osn] ?? "").trim();
            if (osn) claimedOsns.add(osn);
          }
          return json(200, { ok: true, claimedOsns: Array.from(claimedOsns) });
        }
        if (pathname === "/api/operator/recovery") {
          return await this.operatorRecovery(request);
        }
        return await this.mutate(request);
      } catch (error) {
        return errorResponse(error);
      }
    });
  }

  private operation(id: string): Journal | undefined {
    return this.ctx.storage.sql.exec<Journal>("SELECT * FROM operations WHERE request_id = ?", id).toArray()[0];
  }

  private finish(id: string, state: "committed" | "rejected", result: Result): Response {
    this.ctx.storage.sql.exec("UPDATE operations SET state = ?, result = ? WHERE request_id = ?",
      state, JSON.stringify(result), id);
    return json(result.status, result.body);
  }

  private async operatorRecovery(request: Request): Promise<Response> {
    if (!proofEnabled(this.env)) throw new ApiError(503, "LOCAL_PROOF_DISABLED");
    const email = request.headers.get("x-proof-actor")?.trim().toLowerCase();
    if (!email) throw new ApiError(401, "SYNTHETIC_ACTOR_REQUIRED");

    const sheets = this.sheets();
    const snapshot = await sheets.read();
    const actor = actorFrom(snapshot, email);
    if (actor.role !== "Supervisor") throw new ApiError(403, "SUPERVISOR_ROLE_REQUIRED");

    if (request.method === "GET") {
      const pending = this.ctx.storage.sql.exec<Journal>(
        "SELECT * FROM operations WHERE state = 'pending' LIMIT 1",
      ).toArray()[0];
      const lastOp = this.ctx.storage.sql.exec<Journal>(
        "SELECT * FROM operations ORDER BY rowid DESC LIMIT 1",
      ).toArray()[0];

      if (!pending) {
        return json(200, {
          ok: true,
          blocked: false,
          pendingOperation: null,
          lastOperation: lastOp ? {
            requestId: lastOp.request_id,
            state: lastOp.state,
            result: JSON.parse(lastOp.result || "{}"),
          } : null,
          message: "Workbook is not blocked. No pending uncertain operations.",
        });
      }

      const plan = JSON.parse(pending.plan) as Plan;
      const activities = snapshot["Activity Log"].slice(1).filter((row) => row[11] === pending.request_id);
      const rangeChecks = plan.batch.data.map(({ range, values }) => {
        const match = /^'(Schools|Activity Log|Contacts)'!([A-Z]+)(\d+):[A-Z]+\d+$/.exec(range);
        if (!match) return { range, matches: false };
        const tab = match[1] as "Schools" | "Activity Log" | "Contacts";
        const column = match[2] === "S" ? 18 : 0;
        const actual = snapshot[tab][Number(match[3]) - 1] ?? [];
        const matches = values[0]!.every((value, index) => value === (actual[column + index] ?? ""));
        return { range, matches };
      });
      const allRangesMatch = rangeChecks.every((c) => c.matches);
      const anyRangesMatch = rangeChecks.some((c) => c.matches);

      let evidenceStatus: string;
      let explanation: string;
      let reconcilable = false;

      if (activities.length === 1 && allRangesMatch) {
        evidenceStatus = "CONFIRMED_COMMITTED";
        explanation = "Unique activity marker (Activity Log!L) and all planned ranges match the workbook. The write committed upstream before acknowledgement was lost.";
        reconcilable = true;
      } else if (activities.length === 0 && !anyRangesMatch) {
        evidenceStatus = "ABSENT_UNRESOLVED";
        explanation = "No activity marker or planned cell updates found in the workbook. The upstream write may still be in-flight, delayed, or lost. Writes remain blocked to prevent duplicate writes or row corruption.";
        reconcilable = false;
      } else if (activities.length > 1) {
        evidenceStatus = "CONFLICTING_DUPLICATE_MARKERS";
        explanation = "Multiple activity log rows contain this request ID. Conflicting or corrupt workbook state detected. Automatic resolution is blocked.";
        reconcilable = false;
      } else {
        evidenceStatus = "PARTIAL_OR_CONFLICTING";
        explanation = "Incomplete or conflicting evidence: some planned changes or activity markers are present, but not all match the plan. Workbook may have been edited concurrently. Writes remain blocked.";
        reconcilable = false;
      }

      return json(200, {
        ok: true,
        blocked: true,
        pendingOperation: {
          requestId: pending.request_id,
          fingerprint: pending.fingerprint,
          state: pending.state,
          plan,
        },
        evidence: {
          status: evidenceStatus,
          explanation,
          reconcilable,
          activityMarkerCount: activities.length,
          rangeChecks,
        },
      });
    }

    if (request.method === "POST") {
      const pending = this.ctx.storage.sql.exec<Journal>(
        "SELECT * FROM operations WHERE state = 'pending' LIMIT 1",
      ).toArray()[0];
      if (!pending) {
        return json(400, { ok: false, code: "NO_PENDING_OPERATION", message: "No pending uncertain operation to reconcile." });
      }

      const raw = await request.text();
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        throw new ApiError(400, "INVALID_JSON");
      }

      if (body.action === "force_unlock") {
        throw new ApiError(403, "BLIND_FORCE_UNLOCK_FORBIDDEN", {
          message: "Blind force unlock is forbidden. Uncertain operations cannot be dismissed merely because a request ID is absent; doing so risks data corruption from delayed upstream writes or race conditions.",
          requestId: pending.request_id,
          blocked: true,
        });
      }

      if (body.action !== "reconcile") {
        throw new ApiError(422, "INVALID_RECOVERY_ACTION", {
          expectedAction: "reconcile",
        });
      }

      if (typeof body.requestId !== "string" || !uuid.test(body.requestId)) {
        throw new ApiError(422, "INVALID_REQUEST_ID");
      }

      if (body.requestId !== pending.request_id) {
        throw new ApiError(409, "REQUEST_ID_MISMATCH", {
          pendingRequestId: pending.request_id,
        });
      }

      const plan = JSON.parse(pending.plan) as Plan;
      const activities = snapshot["Activity Log"].slice(1).filter((row) => row[11] === pending.request_id);
      const allRangesMatch = plan.batch.data.every(({ range, values }) => {
        const match = /^'(Schools|Activity Log|Contacts)'!([A-Z]+)(\d+):[A-Z]+\d+$/.exec(range);
        if (!match) return false;
        const tab = match[1] as "Schools" | "Activity Log" | "Contacts";
        const column = match[2] === "S" ? 18 : 0;
        const actual = snapshot[tab][Number(match[3]) - 1] ?? [];
        return values[0]!.every((value, index) => value === (actual[column + index] ?? ""));
      });

      if (activities.length === 1 && allRangesMatch) {
        this.finish(pending.request_id, "committed", plan.result);
        return json(200, {
          ok: true,
          code: "RECONCILED_COMMITTED",
          message: "Pending operation confirmed in workbook and successfully reconciled.",
          requestId: pending.request_id,
          blocked: false,
          result: plan.result.body,
        });
      }

      const anyRangesMatch = plan.batch.data.some(({ range, values }) => {
        const match = /^'(Schools|Activity Log|Contacts)'!([A-Z]+)(\d+):[A-Z]+\d+$/.exec(range);
        if (!match) return false;
        const tab = match[1] as "Schools" | "Activity Log" | "Contacts";
        const column = match[2] === "S" ? 18 : 0;
        const actual = snapshot[tab][Number(match[3]) - 1] ?? [];
        return values[0]!.every((value, index) => value === (actual[column + index] ?? ""));
      });
      const evidenceStatus = (activities.length === 0 && !anyRangesMatch)
        ? "ABSENT_UNRESOLVED"
        : (activities.length > 1 ? "CONFLICTING_DUPLICATE_MARKERS" : "PARTIAL_OR_CONFLICTING");

      return json(409, {
        ok: false,
        code: "RECONCILIATION_REFUSED",
        message: "Cannot reconcile: workbook evidence is absent, partial, or conflicting. Workbook remains blocked.",
        requestId: pending.request_id,
        evidenceStatus,
        blocked: true,
      });
    }

    throw new ApiError(405, "METHOD_NOT_ALLOWED");
  }

  private async mutate(request: Request): Promise<Response> {
    if (!proofEnabled(this.env)) throw new ApiError(503, "LOCAL_PROOF_DISABLED");
    const path = new URL(request.url).pathname;
    if (!paths.has(path)) throw new ApiError(404, "NOT_FOUND");
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED");
    const email = request.headers.get("x-proof-actor")?.trim().toLowerCase();
    if (!email) throw new ApiError(401, "SYNTHETIC_ACTOR_REQUIRED");
    const raw = await request.text();
    if (raw.length > 16384) throw new ApiError(413, "BODY_TOO_LARGE");
    let input: Input;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      input = parsed as Input;
    } catch { throw new ApiError(400, "INVALID_JSON"); }
    if (typeof input.requestId !== "string" || !uuid.test(input.requestId)) throw new ApiError(422, "INVALID_REQUEST_ID");
    const requestId = input.requestId;
    const hash = await fingerprint(email, path, input);
    const sheets = this.sheets();
    const snapshot = await sheets.read();
    const actor = actorFrom(snapshot, email); // Revocations also apply to result replays.
    const previous = this.operation(requestId);
    if (previous) {
      if (previous.fingerprint !== hash) throw new ApiError(409, "REQUEST_ID_REUSED");
      if (previous.state === "pending") return this.reconcile(previous, snapshot);
      const result = JSON.parse(previous.result) as Result;
      return json(result.status, { ...result.body, replayed: true });
    }
    // An absent marker after a timeout does NOT prove failure. Do not permit a
    // new operation to overtake an unresolved external write, even after restart.
    const pending = this.ctx.storage.sql.exec<{ request_id: string }>(
      "SELECT request_id FROM operations WHERE state = 'pending' LIMIT 1",
    ).toArray()[0];
    if (pending) throw new ApiError(503, "WORKBOOK_BLOCKED", { pendingRequestId: pending.request_id });
    const plan = this.plan(path, input, actor, snapshot);
    this.ctx.storage.sql.exec(
      "INSERT INTO operations (request_id, fingerprint, state, plan, result) VALUES (?, ?, 'pending', ?, '')",
      requestId, hash, JSON.stringify(plan),
    );
    try {
      const response = await sheets.write(plan.batch);
      if (response.ok) return this.finish(requestId, "committed", plan.result);
      // Only a definite rejection can release the workbook without reconciliation.
      if ([400, 401, 403, 404, 422, 429].includes(response.status)) {
        return this.finish(requestId, "rejected", {
          status: 502, body: { ok: false, code: response.status === 403 && !this.env.SHEETS ? "TEST_SHEET_EDIT_ACCESS_REQUIRED" : "SHEETS_REJECTED", requestId,
            message: response.status === 403 ? "The app account needs Editor access to the test spreadsheet. Nothing was saved." : "Google rejected the save. Nothing was saved; you can try again." },
        });
      }
    } catch { /* The write may have committed; inspect it, never blindly retry. */ }
    try {
      return this.reconcile(this.operation(requestId)!, await sheets.read());
    } catch {
      return json(503, { ok: false, code: "COMMIT_UNCERTAIN", requestId });
    }
  }

  private reconcile(operation: Journal, snapshot: Snapshot): Response {
    const plan = JSON.parse(operation.plan) as Plan;
    // Every proof mutation writes its marker in Activity Log!L in the SAME batch.
    const activities = snapshot["Activity Log"].slice(1).filter((row) => row[11] === operation.request_id);
    if (activities.length === 1 && plan.batch.data.every(({ range, values }) => {
      const match = /^'(Schools|Activity Log|Contacts)'!([A-Z]+)(\d+):[A-Z]+\d+$/.exec(range);
      if (!match) return false;
      const tab = match[1] as "Schools" | "Activity Log" | "Contacts";
      const column = match[2] === "S" ? 18 : 0;
      const actual = snapshot[tab][Number(match[3]) - 1] ?? [];
      return values[0]!.every((value, index) => value === (actual[column + index] ?? ""));
    })) {
      return this.finish(operation.request_id, "committed", plan.result);
    }
    return json(503, { ok: false, code: "COMMIT_UNCERTAIN", requestId: operation.request_id });
  }

  private plan(path: string, input: Input, actor: Actor, snapshot: Snapshot): Plan {
    const requestId = input.requestId as string;
    let row: Row;
    let rowNumber: number;
    let activityType = "Outreach";
    let channel = "App";
    let outcome = "Updated";
    let summary = "";
    let contactedPerson = "";
    let contactIdsStr = "";
    const contactRanges: ValueRange[] = [];
    const day = today(this.env);
    if (path === "/api/schools/claim") {
      onlyKeys(input, ["requestId", "osn"]);
      const osn = text(input.osn, 20);
      const entries = snapshot["School Directory"].slice(1).filter((entry) => String(entry[0]) === osn);
      if (entries.length !== 1 || entries[0]?.[14] !== "Available") throw new ApiError(422, "SCHOOL_UNAVAILABLE");
      const entry = entries[0]!;
      if (snapshot.Schools.slice(1).some((candidate) =>
        String(candidate[C.osn] ?? "") === osn ||
        (candidate[C.name] !== undefined && candidate[C.name] !== "" && sameName(candidate[C.name], entry[1])))) {
        throw new ApiError(409, "SCHOOL_ALREADY_CLAIMED");
      }
      rowNumber = 0;
      for (let number = 2; number <= 500; number++) {
        if (writableBlank(padded(snapshot.Schools[number - 1]))) { rowNumber = number; break; }
      }
      if (!rowNumber) throw new ApiError(422, "PREFORMATTED_ROWS_FULL");
      row = padded(undefined);
      row[C.id] = crypto.randomUUID(); row[C.name] = entry[1] ?? ""; row[C.board] = entry[2] ?? "";
      row[C.assigned] = actor.name; row[C.owner] = actor.email; row[C.osn] = osn;
      row[C.email] = entry[8] ?? ""; row[C.phone] = entry[9] ?? "";
      row[C.region] = entry[11] ?? ""; row[20] = entry[12] ?? "";
      row[C.address] = entry[6] ?? ""; row[C.source] = entry[13] ?? "";
      row[C.stage] = "Not Contacted"; row[C.count] = 0;
      activityType = outcome = "Claimed";
    } else {
      if (typeof input.recordId !== "string" || !uuid.test(input.recordId) ||
          typeof input.expectedRequestId !== "string" || !uuid.test(input.expectedRequestId)) {
        throw new ApiError(422, "INVALID_RECORD_VERSION");
      }
      const matches = snapshot.Schools.map((candidate, index) => ({ candidate, number: index + 1 }))
        .filter(({ candidate, number }) => number > 1 && candidate[C.id] === input.recordId);
      if (matches.length !== 1) throw new ApiError(matches.length ? 503 : 404, matches.length ? "DUPLICATE_RECORD_ID" : "RECORD_NOT_FOUND");
      row = padded(matches[0]!.candidate); rowNumber = matches[0]!.number;
      if (actor.role !== "Supervisor" && String(row[C.owner]).toLowerCase() !== actor.email) throw new ApiError(403, "NOT_OWNER");
      if (row[C.version] !== input.expectedRequestId) {
        throw new ApiError(409, "CONFLICT_STALE_VERSION", { currentServerRecord: record(row) });
      }
      if (path === "/api/schools/update") {
        onlyKeys(input, ["requestId", "recordId", "expectedRequestId", "patch", "coldReason", "isExplicitRejection"]);
        if (!input.patch && (input.coldReason !== undefined || input.isExplicitRejection !== undefined)) {
          input.patch = {};
        }
        if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)) throw new ApiError(422, "INVALID_PATCH");
        const patch = input.patch as Input;
        if (input.coldReason !== undefined && patch.coldReason === undefined) {
          patch.coldReason = input.coldReason;
        }
        if (input.isExplicitRejection !== undefined && patch.isExplicitRejection === undefined) {
          patch.isExplicitRejection = input.isExplicitRejection;
        }
        const columns: Record<string, number> = {
          notes: C.notes, contactName: C.contactName, contactRole: C.contactRole,
          email: C.email, phone: C.phone, priority: C.priority, outreachGoal: C.goal,
          followUpDue: C.due, nextAction: C.action, stage: C.stage, coldReason: C.coldReason,
        };
        onlyKeys(patch, [...Object.keys(columns), "isExplicitRejection"]);
        if (!Object.keys(patch).length) throw new ApiError(422, "EMPTY_PATCH");
        let isExplicitCold = false;
        if (patch.stage !== undefined) {
          const targetStage = String(patch.stage);
          if (!["Not Contacted", "Contacted", "Interested", "Engaged", "Booked", "Cold"].includes(targetStage)) throw new ApiError(422, "INVALID_STAGE");
          if (targetStage === "Cold" && row[C.stage] !== "Cold") {
            const isExplicit = Boolean(patch.isExplicitRejection) ||
              (typeof patch.coldReason === "string" && EXPLICIT_REJECTION_REASONS.includes(patch.coldReason.trim() as any));
            const coldReasonVal = patch.coldReason !== undefined && String(patch.coldReason).trim() !== ""
              ? String(patch.coldReason).trim()
              : (isExplicit ? DEFAULT_DECLINE_REASON : undefined);
            const evaluation = evaluateColdEligibility({
              currentStage: String(row[C.stage]),
              followUpCount: Number(row[C.count]),
              followUpDue: row[C.due] ? String(row[C.due]) : null,
              coldReason: coldReasonVal,
              isExplicitRejection: isExplicit,
              today: day,
            });
            if (!evaluation.allowed) {
              throw new ApiError(422, "COLD_RULE_VIOLATION", { reason: evaluation.reason });
            }
            if (isExplicit) {
              isExplicitCold = true;
              row[C.coldReason] = coldReasonVal || DEFAULT_DECLINE_REASON;
              row[C.due] = "";
              row[C.action] = "Archived for season";
            } else {
              row[C.coldReason] = coldReasonVal || UNRESPONSIVE_COLD_REASON;
            }
          } else if (targetStage !== "Cold" && row[C.stage] === "Cold" && patch.coldReason === undefined) {
            row[C.coldReason] = "";
          }
        }
        for (const [key, value] of Object.entries(patch)) {
          if (key === "isExplicitRejection") continue;
          if (key === "priority" && !["High", "Medium", "Low", ""].includes(String(value))) throw new ApiError(422, "INVALID_PRIORITY");
          if (isExplicitCold && key === "followUpDue" && (value === undefined || value === null || value === "")) continue;
          if (isExplicitCold && key === "nextAction" && (value === undefined || value === null || value === "")) continue;
          row[columns[key]!] = key === "followUpDue" ? date(value) : text(value);
        }

        // Enforce one source of truth: synchronize Contacts when contact fields are patched
        const contactFieldKeys = ["contactName", "contactRole", "email", "phone"] as const;
        const touchesContacts = contactFieldKeys.some((k) => k in patch);
        if (touchesContacts && snapshot.Contacts) {
          const schoolContacts = snapshot.Contacts.slice(1).map((cRow, index) => ({
            rowNumber: index + 2,
            row: [...cRow],
            contact: contactRecord(cRow),
          })).filter((c) => c.contact.recordId === input.recordId);

          const currentPrimary = schoolContacts.find((c) => c.contact.active && c.contact.isPrimary);
          if (currentPrimary) {
            const updated = [...currentPrimary.row];
            if (patch.contactName !== undefined) updated[ContactCol.name] = text(patch.contactName, 300).trim();
            if (patch.contactRole !== undefined) updated[ContactCol.role] = text(patch.contactRole, 300).trim();
            if (patch.email !== undefined) updated[ContactCol.email] = text(patch.email, 300).trim();
            if (patch.phone !== undefined) updated[ContactCol.phone] = text(patch.phone, 100).trim();
            updated[ContactCol.updatedAt] = day;

            assertStudentPrivacy(
              String(updated[ContactCol.category] ?? ""),
              String(updated[ContactCol.email] ?? ""),
              String(updated[ContactCol.phone] ?? ""),
            );

            row[C.contactName] = updated[ContactCol.name] ?? "";
            row[C.contactRole] = updated[ContactCol.role] ?? "";
            row[C.email] = updated[ContactCol.email] ?? "";
            row[C.phone] = updated[ContactCol.phone] ?? "";

            contactRanges.push({ range: `'Contacts'!A${currentPrimary.rowNumber}:N${currentPrimary.rowNumber}`, values: [updated] });
          } else if (String(row[C.contactName] ?? "").trim() || String(row[C.email] ?? "").trim()) {
            const newName = String(row[C.contactName] ?? "").trim() || "School Representative";
            const newRole = String(row[C.contactRole] ?? "").trim() || "Contact";
            const newEmail = String(row[C.email] ?? "").trim();
            const newPhone = String(row[C.phone] ?? "").trim();

            let newRowNumber = 2;
            while ((snapshot.Contacts?.[newRowNumber - 1] ?? []).some((cell) => cell !== "")) newRowNumber++;

            const newContactRow: Row = [
              crypto.randomUUID(), row[C.id]!, row[C.name]!, newName, newRole,
              "Administration", "", "Main Office", newEmail, newPhone,
              "Created via school update", "TRUE", "TRUE", day,
            ];
            contactRanges.push({ range: `'Contacts'!A${newRowNumber}:N${newRowNumber}`, values: [newContactRow] });
          }
        }
        activityType = outcome = "Updated";
      } else if (path === "/api/schools/contacts") {
        onlyKeys(input, ["requestId", "recordId", "expectedRequestId", "action", "contactId", "contact"]);
        const action = text(input.action, 50);
        if (!["create", "update", "set_primary", "deactivate"].includes(action)) throw new ApiError(422, "INVALID_ACTION");

        const schoolContacts = (snapshot.Contacts?.slice(1) ?? []).map((cRow, index) => ({
          rowNumber: index + 2,
          row: [...cRow],
          contact: contactRecord(cRow),
        })).filter((c) => c.contact.recordId === input.recordId);

        const currentPrimary = schoolContacts.find((c) => c.contact.active && c.contact.isPrimary);
        let contactResult: ReturnType<typeof contactRecord> | null = null;

        if (action === "create") {
          if (!input.contact || typeof input.contact !== "object" || Array.isArray(input.contact)) throw new ApiError(422, "INVALID_CONTACT");
          const cData = input.contact as Input;
          onlyKeys(cData, ["name", "role", "category", "gradeRange", "programGroup", "email", "phone", "notes", "isPrimary"]);
          const name = text(cData.name, 300).trim();
          const role = text(cData.role, 300).trim();
          if (!name || !role) throw new ApiError(422, "CONTACT_DETAILS_REQUIRED");
          const category = text(cData.category ?? "Other", 100);
          if (!["Administration", "Teacher", "Staff", "Student", "Other"].includes(category)) throw new ApiError(422, "INVALID_CATEGORY");
          const gradeRange = text(cData.gradeRange ?? "", 100);
          const programGroup = text(cData.programGroup ?? "", 200);
          const email = text(cData.email ?? "", 300);
          const phone = text(cData.phone ?? "", 100);
          const notes = text(cData.notes ?? "", 4000);
          const activeCount = schoolContacts.filter((c) => c.contact.active).length;
          const willBePrimary = Boolean(cData.isPrimary) || activeCount === 0;
          assertStudentPrivacy(category, email, phone);

          const contactId = crypto.randomUUID();
          let newRowNumber = 2;
          while ((snapshot.Contacts?.[newRowNumber - 1] ?? []).some((cell) => cell !== "")) newRowNumber++;

          const newContactRow: Row = [
            contactId, row[C.id]!, row[C.name]!, name, role,
            category, gradeRange, programGroup, email, phone,
            notes, willBePrimary ? "TRUE" : "FALSE", "TRUE", day,
          ];

          if (willBePrimary) {
            row[C.contactName] = name; row[C.contactRole] = role;
            row[C.email] = email; row[C.phone] = phone;
            if (currentPrimary) {
              const prev = [...currentPrimary.row];
              prev[ContactCol.isPrimary] = "FALSE";
              prev[ContactCol.updatedAt] = day;
              contactRanges.push({ range: `'Contacts'!A${currentPrimary.rowNumber}:N${currentPrimary.rowNumber}`, values: [prev] });
            }
          }
          contactRanges.push({ range: `'Contacts'!A${newRowNumber}:N${newRowNumber}`, values: [newContactRow] });
          contactResult = contactRecord(newContactRow);
          activityType = outcome = "ContactCreated";
          summary = `Added contact ${name} (${role})`;
        } else {
          if (typeof input.contactId !== "string" || !uuid.test(input.contactId)) throw new ApiError(422, "INVALID_CONTACT_ID");
          const target = schoolContacts.find((c) => c.contact.contactId === input.contactId && c.contact.active);
          if (!target) throw new ApiError(404, "CONTACT_NOT_FOUND");

          if (action === "set_primary") {
            if (currentPrimary && currentPrimary.contact.contactId !== target.contact.contactId) {
              const prev = [...currentPrimary.row];
              prev[ContactCol.isPrimary] = "FALSE";
              prev[ContactCol.updatedAt] = day;
              contactRanges.push({ range: `'Contacts'!A${currentPrimary.rowNumber}:N${currentPrimary.rowNumber}`, values: [prev] });
            }
            const updated = [...target.row];
            updated[ContactCol.isPrimary] = "TRUE";
            updated[ContactCol.updatedAt] = day;
            contactRanges.push({ range: `'Contacts'!A${target.rowNumber}:N${target.rowNumber}`, values: [updated] });
            row[C.contactName] = target.contact.name; row[C.contactRole] = target.contact.role;
            row[C.email] = target.contact.email; row[C.phone] = target.contact.phone;
            contactResult = contactRecord(updated);
            activityType = outcome = "ContactUpdated";
            summary = `Set ${target.contact.name} as primary contact`;
          } else if (action === "deactivate") {
            const updated = [...target.row];
            updated[ContactCol.active] = "FALSE";
            updated[ContactCol.isPrimary] = "FALSE";
            updated[ContactCol.updatedAt] = day;
            contactRanges.push({ range: `'Contacts'!A${target.rowNumber}:N${target.rowNumber}`, values: [updated] });

            if (target.contact.isPrimary) {
              const remaining = schoolContacts.filter((c) => c.contact.active && c.contact.contactId !== target.contact.contactId);
              if (remaining.length > 0) {
                const nextPrimary = remaining[0]!;
                const nextRow = [...nextPrimary.row];
                nextRow[ContactCol.isPrimary] = "TRUE";
                nextRow[ContactCol.updatedAt] = day;
                contactRanges.push({ range: `'Contacts'!A${nextPrimary.rowNumber}:N${nextPrimary.rowNumber}`, values: [nextRow] });
                row[C.contactName] = nextPrimary.contact.name; row[C.contactRole] = nextPrimary.contact.role;
                row[C.email] = nextPrimary.contact.email; row[C.phone] = nextPrimary.contact.phone;
              } else {
                row[C.contactName] = ""; row[C.contactRole] = "";
                row[C.email] = ""; row[C.phone] = "";
              }
            }
            contactResult = contactRecord(updated);
            activityType = outcome = "ContactDeactivated";
            summary = `Deactivated contact ${target.contact.name}`;
          } else if (action === "update") {
            if (!input.contact || typeof input.contact !== "object" || Array.isArray(input.contact)) throw new ApiError(422, "INVALID_CONTACT");
            const cData = input.contact as Input;
            onlyKeys(cData, ["name", "role", "category", "gradeRange", "programGroup", "email", "phone", "notes", "isPrimary"]);
            const updated = [...target.row];
            if (cData.name !== undefined) updated[ContactCol.name] = text(cData.name, 300).trim();
            if (cData.role !== undefined) updated[ContactCol.role] = text(cData.role, 300).trim();
            if (cData.category !== undefined) {
              const cat = text(cData.category, 100);
              if (!["Administration", "Teacher", "Staff", "Student", "Other"].includes(cat)) throw new ApiError(422, "INVALID_CATEGORY");
              updated[ContactCol.category] = cat;
            }
            if (cData.gradeRange !== undefined) updated[ContactCol.gradeRange] = text(cData.gradeRange, 100);
            if (cData.programGroup !== undefined) updated[ContactCol.programGroup] = text(cData.programGroup, 200);
            if (cData.email !== undefined) updated[ContactCol.email] = text(cData.email, 300);
            if (cData.phone !== undefined) updated[ContactCol.phone] = text(cData.phone, 100);
            if (cData.notes !== undefined) updated[ContactCol.notes] = text(cData.notes, 4000);
            if (!String(updated[ContactCol.name]).trim() || !String(updated[ContactCol.role]).trim()) {
              throw new ApiError(422, "CONTACT_DETAILS_REQUIRED");
            }
            updated[ContactCol.updatedAt] = day;

            assertStudentPrivacy(
              String(updated[ContactCol.category] ?? ""),
              String(updated[ContactCol.email] ?? ""),
              String(updated[ContactCol.phone] ?? ""),
            );

            const wasPrimary = target.contact.isPrimary;
            const willBePrimary = cData.isPrimary !== undefined ? Boolean(cData.isPrimary) : wasPrimary;
            updated[ContactCol.isPrimary] = willBePrimary ? "TRUE" : "FALSE";

            if (willBePrimary) {
              if (currentPrimary && currentPrimary.contact.contactId !== target.contact.contactId) {
                const prev = [...currentPrimary.row];
                prev[ContactCol.isPrimary] = "FALSE";
                prev[ContactCol.updatedAt] = day;
                contactRanges.push({ range: `'Contacts'!A${currentPrimary.rowNumber}:N${currentPrimary.rowNumber}`, values: [prev] });
              }
              row[C.contactName] = updated[ContactCol.name] ?? ""; row[C.contactRole] = updated[ContactCol.role] ?? "";
              row[C.email] = updated[ContactCol.email] ?? ""; row[C.phone] = updated[ContactCol.phone] ?? "";
            } else if (wasPrimary && !willBePrimary) {
              const remaining = schoolContacts.filter((c) => c.contact.active && c.contact.contactId !== target.contact.contactId);
              if (remaining.length > 0) {
                const nextPrimary = remaining[0]!;
                const nextRow = [...nextPrimary.row];
                nextRow[ContactCol.isPrimary] = "TRUE";
                nextRow[ContactCol.updatedAt] = day;
                contactRanges.push({ range: `'Contacts'!A${nextPrimary.rowNumber}:N${nextPrimary.rowNumber}`, values: [nextRow] });
                row[C.contactName] = nextPrimary.contact.name; row[C.contactRole] = nextPrimary.contact.role;
                row[C.email] = nextPrimary.contact.email; row[C.phone] = nextPrimary.contact.phone;
              } else {
                row[C.contactName] = ""; row[C.contactRole] = "";
                row[C.email] = ""; row[C.phone] = "";
              }
            }
            contactRanges.push({ range: `'Contacts'!A${target.rowNumber}:N${target.rowNumber}`, values: [updated] });
            contactResult = contactRecord(updated);
            activityType = outcome = "ContactUpdated";
            summary = `Updated contact ${updated[ContactCol.name]}`;
          }
        }

        const contactIdVal = contactResult?.contactId ?? (typeof input.contactId === "string" ? input.contactId : "");
        const contactPerson = contactResult?.name ?? String(row[C.contactName] ?? "");
        row[C.version] = requestId;
        let activityNumber = 2;
        while ((snapshot["Activity Log"][activityNumber - 1] ?? []).some((cell) => cell !== "")) activityNumber++;
        const activity: Row = [
          crypto.randomUUID(), day, row[C.name]!, row[C.assigned]!, channel, outcome,
          contactPerson, summary, row[C.action]!, row[C.due]!, row[C.id]!, requestId,
          actor.email, activityType, this.env.GOOGLE_SHEET_ID === "synthetic-h4" ? "Local synthetic proof" : "App",
          contactIdVal,
        ];
        return {
          batch: {
            valueInputOption: "RAW",
            data: [
              ...schoolWrites(rowNumber, row),
              ...contactRanges,
              { range: `'Activity Log'!A${activityNumber}:P${activityNumber}`, values: [activity] },
            ],
          },
          result: {
            status: 200,
            body: { ok: true, code: "SUCCESS", requestId, record: editableRecord(row), contact: contactResult },
          },
        };
      } else {
        onlyKeys(input, ["requestId", "recordId", "expectedRequestId", "channel", "activityType", "outcome", "summary", "stage", "followUpDue", "nextAction", "contactIds", "coldReason", "isExplicitRejection"]);
        channel = text(input.channel, 30);
        if (!["Email", "Phone", "Follow-Up", "Social", "Meeting", "Reply", "App", "Text", "Visit"].includes(channel)) throw new ApiError(422, "INVALID_CHANNEL");
        activityType = text(input.activityType, 30);
        if (!["Outreach", "FollowUp"].includes(activityType)) throw new ApiError(422, "INVALID_ACTIVITY_TYPE");
        outcome = text(input.outcome, 300); summary = text(input.summary);
        if (!outcome.trim() || !summary.trim()) throw new ApiError(422, "OUTREACH_DETAILS_REQUIRED");

        if (input.contactIds !== undefined) {
          if (!Array.isArray(input.contactIds)) throw new ApiError(422, "INVALID_CONTACT_IDS");
          for (const cid of input.contactIds) {
            if (typeof cid !== "string" || !uuid.test(cid)) throw new ApiError(422, "INVALID_CONTACT_ID");
          }
          const uniqueIds = new Set(input.contactIds);
          if (uniqueIds.size !== input.contactIds.length) throw new ApiError(422, "DUPLICATE_CONTACT_IDS");

          if (input.contactIds.length > 0) {
            const allContacts = (snapshot.Contacts?.slice(1) ?? []).map(contactRecord);
            const selected: ReturnType<typeof contactRecord>[] = [];
            for (const cid of input.contactIds) {
              const found = allContacts.find((c) => c.contactId === cid);
              if (!found) throw new ApiError(404, "CONTACT_NOT_FOUND", { contactId: cid });
              if (found.recordId !== input.recordId) throw new ApiError(422, "CROSS_SCHOOL_CONTACT_FORBIDDEN", { contactId: cid, schoolRecordId: input.recordId });
              if (!found.active) throw new ApiError(422, "INACTIVE_CONTACT_FORBIDDEN", { contactId: cid });
              selected.push(found);
            }
            contactedPerson = selected.map((c) => c.role ? `${c.name} (${c.role})` : c.name).join(", ");
            contactIdsStr = selected.map((c) => c.contactId).join(",");
          } else {
            contactedPerson = "General School Outreach";
            contactIdsStr = "";
          }
        } else {
          const primary = (snapshot.Contacts?.slice(1) ?? [])
            .map(contactRecord)
            .find((c) => c.recordId === input.recordId && c.active && c.isPrimary);
          contactedPerson = String(row[C.contactName] ?? "").trim() || (primary ? (primary.role ? `${primary.name} (${primary.role})` : primary.name) : "General School Outreach");
          contactIdsStr = "";
        }

        // Explicit follow-up events increment once; other outreach does not reset the count.
        const count = Number(row[C.count]);
        if (!Number.isInteger(count) || count < 0) throw new ApiError(422, "INVALID_STORED_COUNT");
        const originalStage = row[C.stage];
        let isExplicitCold = false;
        if (input.stage !== undefined) {
          const stage = text(input.stage, 30);
          if (!["Not Contacted", "Contacted", "Interested", "Engaged", "Booked", "Cold"].includes(stage)) throw new ApiError(422, "INVALID_STAGE");
          if (stage === "Cold") {
            const isExplicit = Boolean(input.isExplicitRejection) ||
              (typeof input.coldReason === "string" && EXPLICIT_REJECTION_REASONS.includes(input.coldReason.trim() as any)) ||
              (typeof outcome === "string" && (
                outcome.trim().toLowerCase() === "not interested" ||
                outcome.trim().toLowerCase().includes("declined") ||
                EXPLICIT_REJECTION_REASONS.some((r) => r.toLowerCase() === outcome.trim().toLowerCase())
              ));
            const coldReasonVal = input.coldReason !== undefined && String(input.coldReason).trim() !== ""
              ? text(input.coldReason, 300)
              : (isExplicit ? DEFAULT_DECLINE_REASON : undefined);
            const evaluation = evaluateColdEligibility({
              currentStage: String(originalStage),
              followUpCount: count,
              followUpDue: row[C.due] ? String(row[C.due]) : null,
              coldReason: coldReasonVal,
              isExplicitRejection: isExplicit,
              today: day,
            });
            if (!evaluation.allowed) throw new ApiError(422, "COLD_RULE_VIOLATION", { reason: evaluation.reason });
            row[C.stage] = "Cold";
            if (isExplicit) {
              isExplicitCold = true;
              row[C.coldReason] = coldReasonVal || DEFAULT_DECLINE_REASON;
              row[C.due] = "";
              row[C.action] = "Archived for season";
            } else {
              row[C.coldReason] = coldReasonVal || UNRESPONSIVE_COLD_REASON;
            }
          } else {
            row[C.stage] = stage;
            if (originalStage === "Cold" && input.coldReason === undefined) {
              row[C.coldReason] = "";
            }
          }
        }
        row[C.count] = count + (activityType === "FollowUp" ? 1 : 0);
        row[C.contacted] = day;
        if (!isExplicitCold) {
          if (input.followUpDue !== undefined) row[C.due] = date(input.followUpDue);
          if (input.nextAction !== undefined) row[C.action] = text(input.nextAction);
        }
      }
    }
    if (path === "/api/schools/claim" || path === "/api/schools/update") {
      contactedPerson = String(row[C.contactName] ?? "");
      contactIdsStr = "";
    }
    row[C.version] = requestId;
    let activityNumber = 2;
    while ((snapshot["Activity Log"][activityNumber - 1] ?? []).some((cell) => cell !== "")) activityNumber++;
    const activity: Row = [
      crypto.randomUUID(), day, row[C.name]!, row[C.assigned]!, channel, outcome,
      contactedPerson, summary, row[C.action]!, row[C.due]!, row[C.id]!, requestId,
      actor.email, activityType, this.env.GOOGLE_SHEET_ID === "synthetic-h4" ? "Local synthetic proof" : "App",
      contactIdsStr,
    ];
    return {
      batch: { valueInputOption: "RAW", data: [
        ...schoolWrites(rowNumber, row),
        ...contactRanges,
        { range: `'Activity Log'!A${activityNumber}:P${activityNumber}`, values: [activity] },
      ] },
      result: { status: 200, body: { ok: true, code: "SUCCESS", requestId, record: record(row) } },
    };
  }
}

// Local real coordinator cannot accidentally receive the demo's FakeSheets binding.
export class TestSheetCoordinator extends SheetCoordinator {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, SHEETS: undefined, PROOF_MODE: "disabled", DEMO_COORDINATOR: undefined,
      GOOGLE_SHEET_ID: TEST_SHEET_ID });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/health" && request.method === "GET") {
      return json(200, { ok: true, code: "SUCCESS", mode: "local-synthetic-proof" });
    }
    if (!proofEnabled(env)) return json(503, { ok: false, code: "LOCAL_PROOF_DISABLED" });
    try {
      // One server-chosen name per workbook. Never accept a client object/sheet ID.
      return await env.COORDINATOR.getByName(env.GOOGLE_SHEET_ID!).fetch(request);
    } catch (error) { return errorResponse(error); }
  },
} satisfies ExportedHandler<Env>;
