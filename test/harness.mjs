import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { HEADERS, C } from "../src/schema.ts";

export { C };
export const ACTOR = "alex@example.test";
export const OTHER = "sam@example.test";
export const SUPERVISOR = "morgan@example.test";
export const RECORD = "00000000-0000-4000-8000-000000000001";
export const VERSION = "00000000-0000-4000-8000-000000000002";

function blank(number) {
  const row = Array(32).fill("");
  row[16] = `=IF(A${number}="","","fixture follow-up formula")`;
  row[17] = `=IF(A${number}="","","fixture duplicate formula")`;
  return row;
}

export function fixture() {
  const initial = blank(2);
  Object.entries({
    [C.id]: RECORD, [C.name]: "Maple Example Secondary", [C.board]: "EXAMPLE",
    [C.assigned]: "Alex", [C.owner]: ACTOR, [C.osn]: "900001",
    [C.stage]: "Not Contacted", [C.count]: 0, [C.version]: VERSION, [C.notes]: "Original fixture note",
  }).forEach(([index, value]) => { initial[Number(index)] = value; });
  const partial = blank(4);
  partial[C.notes] = "Orphan fixture note: never overwrite this row";
  return {
    Schools: [[...HEADERS.Schools], initial, blank(3), partial, blank(5), blank(6)],
    "CRM Users": [[...HEADERS["CRM Users"]],
      [ACTOR, "Alex", "co-op", true], [OTHER, "Sam", "co-op", true],
      [SUPERVISOR, "Morgan", "Supervisor", true], ["revoked@example.test", "Revoked", "co-op", false]],
    "Activity Log": [[...HEADERS["Activity Log"]]],
    "School Directory": [[...HEADERS["School Directory"]], ...[1, 2, 3, 4].map((number) => [
      `90000${number}`, number === 1 ? "Maple Example Secondary" : `Example School ${number}`,
      "EXAMPLE", "Secondary", "9-12", "Example City", "123 Example Street", "A1A 1A1",
      `office${number}@example.test`, "", "https://example.test", "Example Region", "Area A",
      "https://example.test/source", "Available",
    ])],
  };
}

function columnIndex(letters) {
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

// A contract fake, NOT Google Sheets. Validation + copy-on-write models Google's
// documented atomic batch semantics. Formula text is preserved, never evaluated.
export class FakeSheets {
  tables = fixture();
  batches = [];
  attempts = 0;
  inFlight = 0;
  maxInFlight = 0;
  fault = undefined;
  readFault = undefined;
  deferred = undefined;
  delayMs = 12;

  apply(batch) {
    if (batch.valueInputOption !== "RAW" || batch.data.length !== 3) throw new Error("Invalid batch contract");
    const next = structuredClone(this.tables);
    for (const [index, range] of batch.data.entries()) {
      const match = /^'(Schools|Activity Log)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range.range);
      if (!match) throw new Error("Unexpected write range");
      const [, tab, startColumn, startRow, endColumn, endRow] = match;
      const from = columnIndex(startColumn), to = columnIndex(endColumn);
      if (startRow !== endRow || Number(startRow) < 2 || range.values.length !== 1 ||
          range.values[0].length !== to - from + 1) throw new Error("Invalid dimensions");
      if (tab === "Schools" && (Number(endRow) > 500 || !((from === 0 && to === 15) || (from === 18 && to === 31)))) {
        throw new Error("Protected or unformatted range");
      }
      if (tab === "Activity Log" && (from !== 0 || to !== 14)) throw new Error("Invalid activity range");
      const number = Number(startRow) - 1;
      next[tab][number] ??= Array(tab === "Schools" ? 32 : 15).fill("");
      range.values[0].forEach((value, offset) => { next[tab][number][from + offset] = value; });
      // Fail after some ranges have been staged, proving no partial commit escapes.
      if (this.fault === "reject" && index === 1) throw new Error("Injected batch validation failure");
    }
    this.tables = next;
    this.batches.push(structuredClone(batch));
  }

  async fetch(request) {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await delay(this.delayMs); // Force external async yields during concurrency tests.
      const url = new URL(request.url);
      const isAllowedSheet = url.pathname.startsWith("/v4/spreadsheets/synthetic-h4/") ||
        url.pathname.startsWith("/v4/spreadsheets/1QzYTKdeWWa2TpOtGSmJ0NDMeY_U-u3ImeCVdpCmJrH4/");
      if (url.origin !== "https://synthetic.invalid" || !isAllowedSheet) {
        throw new Error("Real spreadsheet/network access is forbidden in this harness");
      }
      if (request.method === "GET" && url.pathname.endsWith("values:batchGet")) {
        if (this.readFault) {
          const status = this.readFault;
          this.readFault = undefined;
          return new Response("Read temporarily unavailable", { status });
        }
        const ranges = url.searchParams.getAll("ranges");
        if (ranges.length !== 4 || url.searchParams.get("valueRenderOption") !== "FORMULA") {
          throw new Error("Unexpected read contract");
        }
        const valueRanges = ranges.map((range) => {
          const tab = /^'([^']+)'!/.exec(range)?.[1];
          if (!Object.hasOwn(this.tables, tab)) throw new Error("Unknown tab");
          return { range, values: structuredClone(this.tables[tab]) };
        });
        return Response.json({ valueRanges });
      }
      if (request.method === "POST" && url.pathname.endsWith("values:batchUpdate")) {
        this.attempts++;
        const batch = await request.json();
        const fault = this.fault;
        if (fault === "late") {
          this.fault = undefined;
          this.deferred = structuredClone(batch);
          return new Response("Outcome unknown; write still in progress", { status: 503 });
        }
        if (fault === "unconfirmed") {
          this.fault = undefined;
          return new Response("Outcome unknown", { status: 503 });
        }
        try { this.apply(batch); }
        catch {
          this.fault = undefined;
          return new Response("Batch rejected without applying any ranges", { status: 400 });
        }
        this.fault = undefined;
        if (fault === "lost-ack") return new Response("Acknowledgement lost after commit", { status: 503 });
        if (fault === "lost-ack-unreconciled") {
          this.readFault = 503;
          return new Response("Acknowledgement lost after commit and read unavailable", { status: 503 });
        }
        return Response.json({ totalUpdatedRows: 2, totalUpdatedCells: 45 });
      }
      throw new Error("Unexpected synthetic Sheets operation");
    } finally { this.inFlight--; }
  }

  commitDeferred() {
    if (!this.deferred) throw new Error("No deferred write");
    this.apply(this.deferred);
    this.deferred = undefined;
  }
}

let bundle;
async function workerScript() {
  bundle ??= build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    external: ["cloudflare:workers"],
  }).then((result) => result.outputFiles[0].text);
  return bundle;
}

export async function harness(t, { mode = "synthetic", sheetId = "synthetic-h4" } = {}) {
  const sheets = new FakeSheets();
  const directory = await mkdtemp(join(tmpdir(), "h4-save-proof-"));
  let mf;
  async function start() {
    mf = new Miniflare({
      name: "h4-save-proof", modules: true, script: await workerScript(),
      compatibilityDate: "2026-07-01", cf: false,
      log: new Log(LogLevel.ERROR),
      bindings: { PROOF_MODE: mode, GOOGLE_SHEET_ID: sheetId, PROOF_TODAY: "2026-10-15" },
      durableObjects: { COORDINATOR: { className: "SheetCoordinator", useSQLite: true } },
      durableObjectsPersist: directory,
      serviceBindings: { SHEETS: (request) => sheets.fetch(request) },
      outboundService: () => { throw new Error("Network egress is disabled for local tests"); },
    });
    await mf.ready;
  }
  t.after(async () => {
    await mf?.dispose();
    // Verify the final absolute path before recursive cleanup on Windows too.
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("h4-save-proof-")) {
      throw new Error("Refusing cleanup outside the task-specific temporary test directory");
    }
    await rm(target, { recursive: true, force: true });
  });
  await start();
  return {
    sheets,
    async post(path, input, actor = ACTOR) {
      const response = await mf.dispatchFetch(`http://localhost${path}`, {
        method: "POST", headers: { "content-type": "application/json", ...(actor ? { "x-proof-actor": actor } : {}) },
        body: JSON.stringify(input),
      });
      return { status: response.status, body: await response.json() };
    },
    async get(path, actor = ACTOR) {
      const response = await mf.dispatchFetch(`http://localhost${path}`, {
        method: "GET", headers: { ...(actor ? { "x-proof-actor": actor } : {}) },
      });
      return { status: response.status, body: await response.json() };
    },
    async restart() { await mf.dispose(); await start(); },
  };
}
