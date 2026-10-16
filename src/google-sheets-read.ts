import { importPKCS8, SignJWT } from "jose";
import { ApiError, HEADERS, type Cell, type Row } from "./schema";

export const TEST_SHEET_ID = "1QzYTKdeWWa2TpOtGSmJ0NDMeY_U-u3ImeCVdpCmJrH4";
export const SHEETS_READ_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface ReadOnlyConfig {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_SHEET_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
  ALLOWED_ORIGIN?: string;
}
export type CrmUser = { email: string; name: string; role: "Supervisor" | "co-op" };
export type SchoolSummary = {
  recordId: string; schoolName: string; schoolBoard: string;
  assignedTo: string; stage: string; priority: string; geographicRegion: string;
};
export type DirectoryEntry = {
  osn: string; schoolName: string; schoolBoard: string;
  schoolLevel: string; gradeRange: string; city: string;
  streetAddress: string; postalCode: string; geographicRegion: string;
  available: boolean;
};
type ValueRange = { range: string; values?: Row[] };

function value(cell: Cell | undefined) { return cell === undefined ? "" : String(cell); }
function checkHeader(row: Row | undefined, expected: readonly string[]) {
  if (expected.some((header, index) => row?.[index] !== header)) throw new ApiError(503, "SCHEMA_MISMATCH");
}
function sameName(a: unknown, b: unknown): boolean {
  const normalize = (val: unknown) => String(val).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return normalize(a) === normalize(b);
}
function checkDirectoryHeader(row: Row | undefined) {
  if (!row) throw new ApiError(503, "SCHEMA_MISMATCH");
  const checks: [number, string, string[]][] = [
    [0, "School Number", ["School Number", "Ontario School Number"]],
    [1, "School Name", ["School Name"]],
    [2, "School Board", ["Board", "School Board"]],
    [3, "School Level", ["Level", "School Level"]],
    [4, "Grade Range", ["Grades", "Grade Range"]],
    [5, "City", ["City", "City / Municipality"]],
    [6, "Street Address", ["Street Address"]],
    [7, "Postal Code", ["Postal Code"]],
    [11, "Geographic Region", ["Geographic Region"]],
    [14, "Status", ["Outreach Status", "Status"]],
  ];
  for (const [col, _name, allowed] of checks) {
    const val = value(row[col]).trim();
    if (!allowed.includes(val)) {
      throw new ApiError(503, "SCHEMA_MISMATCH");
    }
  }
}

export class GoogleSheetsReadOnly {
  private token?: { value: string; expiresAt: number };
  private obtainingToken?: Promise<string>;
  constructor(protected config: ReadOnlyConfig, private scope = SHEETS_READ_SCOPE) {}

  matches(config: ReadOnlyConfig): boolean {
    return this.config.GOOGLE_SERVICE_ACCOUNT_EMAIL === config.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      this.config.GOOGLE_PRIVATE_KEY === config.GOOGLE_PRIVATE_KEY &&
      this.config.GOOGLE_SHEET_ID === config.GOOGLE_SHEET_ID;
  }

  protected async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60000) return this.token.value;
    if (!this.obtainingToken) {
      this.obtainingToken = this.exchangeToken().finally(() => { this.obtainingToken = undefined; });
    }
    return this.obtainingToken;
  }

  private async exchangeToken(): Promise<string> {
    try {
      const key = await importPKCS8(this.config.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"), "RS256");
      const now = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({ scope: this.scope })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(this.config.GOOGLE_SERVICE_ACCOUNT_EMAIL!)
        .setAudience(TOKEN_URL).setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
      const response = await fetch(TOKEN_URL, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
        signal: AbortSignal.timeout(10000), redirect: "manual",
      });
      if (!response.ok) throw new Error();
      const data = await response.json<{ access_token?: string; expires_in?: number; token_type?: string }>();
      if (typeof data.access_token !== "string" || !data.access_token ||
          !Number.isFinite(data.expires_in) || data.expires_in! < 120 || data.expires_in! > 3600 ||
          data.token_type?.toLowerCase() !== "bearer") throw new Error();
      this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in! * 1000 };
      return data.access_token;
    } catch { throw new ApiError(503, "GOOGLE_CONNECTION_UNAVAILABLE"); }
  }

  private async read(ranges: string[]): Promise<ValueRange[]> {
    // This adapter has no write method and cannot target any other workbook.
    if (this.config.GOOGLE_SHEET_ID !== TEST_SHEET_ID) throw new ApiError(503, "TEST_SHEET_REQUIRED");
    const token = await this.accessToken();
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${TEST_SHEET_ID}/values:batchGet`);
    ranges.forEach((range) => url.searchParams.append("ranges", range));
    url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET", headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000), redirect: "manual",
      });
    } catch { throw new ApiError(503, "GOOGLE_CONNECTION_UNAVAILABLE"); }
    if (response.status === 401) this.token = undefined;
    if (response.status === 403 || response.status === 404) throw new ApiError(503, "TEST_SHEET_ACCESS_REQUIRED");
    if (response.status === 429) throw new ApiError(503, "GOOGLE_READ_LIMIT_REACHED");
    if (!response.ok) throw new ApiError(503, "GOOGLE_CONNECTION_UNAVAILABLE");
    const result = await response.json<{ valueRanges?: ValueRange[] }>();
    if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== ranges.length) {
      throw new ApiError(503, "SCHEMA_MISMATCH");
    }
    return result.valueRanges;
  }

  async authorize(email: string): Promise<CrmUser> {
    // Fresh every request. Never cache mutable permissions in an isolate.
    const [users] = await this.read(["'CRM Users'!A1:D1000"]);
    checkHeader(users?.values?.[0], HEADERS["CRM Users"]);
    const matches = (users?.values ?? []).slice(1)
      .filter((row) => value(row[0]).trim().toLowerCase() === email);
    if (matches.length !== 1) throw new ApiError(403, "USER_NOT_ALLOWED");
    const row = matches[0]!;
    const active = value(row[3]).trim().toUpperCase();
    const role = value(row[2]).trim();
    if (!["TRUE", ""].includes(active) || !["Supervisor", "co-op"].includes(role)) {
      throw new ApiError(403, "USER_NOT_ALLOWED");
    }
    return { email, name: value(row[1]).trim() || email, role: role as CrmUser["role"] };
  }

  async schools(user: CrmUser): Promise<SchoolSummary[]> {
    // Read only the columns needed for the minimal screen and ownership checks.
    // No notes, contacts, phone numbers, value, social handles, or Activity Log.
    const ranges = await this.read([
      "'Schools'!A1:D1000", "'Schools'!I1:I1000", "'Schools'!M1:M1000",
      "'Schools'!S1:S1000", "'Schools'!Z1:Z1000",
    ]);
    const [base, stages, priorities, regions, owners] = ranges.map((range) => range.values ?? []);
    checkHeader(base?.[0], HEADERS.Schools.slice(0, 4));
    checkHeader(stages?.[0], ["Stage"]); checkHeader(priorities?.[0], ["Priority"]);
    checkHeader(regions?.[0], ["Geographic Region"]); checkHeader(owners?.[0], ["Owner Email"]);
    const summaries: SchoolSummary[] = [];
    for (let index = 1; index < (base?.length ?? 0); index++) {
      const row = base![index]!;
      if (!row[0]) continue;
      const owner = value(owners?.[index]?.[0]).trim().toLowerCase();
      if (user.role !== "Supervisor" && owner !== user.email) continue;
      summaries.push({
        recordId: value(row[0]), schoolName: value(row[1]), schoolBoard: value(row[2]),
        assignedTo: value(row[3]), stage: value(stages?.[index]?.[0]),
        priority: value(priorities?.[index]?.[0]), geographicRegion: value(regions?.[index]?.[0]),
      });
    }
    return summaries;
  }

  async teamSchools(user: CrmUser): Promise<(SchoolSummary & {
    lastContacted: string; followUpDue: string; canEdit: boolean;
  })[]> {
    // Team visibility is limited to progress summaries. Owner email is used
    // only for the server-computed permission; contacts and notes are not read.
    const ranges = await this.read([
      "'Schools'!A1:D1000", "'Schools'!I1:K1000", "'Schools'!M1:M1000",
      "'Schools'!S1:S1000", "'Schools'!Z1:Z1000",
    ]);
    const [base, progress, priorities, regions, owners] = ranges.map((range) => range.values ?? []);
    checkHeader(base?.[0], HEADERS.Schools.slice(0, 4));
    checkHeader(progress?.[0], ["Stage", "Last Contacted", "Follow-Up Due"]);
    checkHeader(priorities?.[0], ["Priority"]);
    checkHeader(regions?.[0], ["Geographic Region"]); checkHeader(owners?.[0], ["Owner Email"]);
    const summaries = [];
    for (let index = 1; index < (base?.length ?? 0); index++) {
      const row = base![index]!;
      if (!row[0]) continue;
      summaries.push({
        recordId: value(row[0]), schoolName: value(row[1]), schoolBoard: value(row[2]),
        assignedTo: value(row[3]), stage: value(progress?.[index]?.[0]),
        lastContacted: value(progress?.[index]?.[1]), followUpDue: value(progress?.[index]?.[2]),
        priority: value(priorities?.[index]?.[0]), geographicRegion: value(regions?.[index]?.[0]),
        canEdit: user.role === "Supervisor" || value(owners?.[index]?.[0]).trim().toLowerCase() === user.email,
      });
    }
    return summaries;
  }

  async directory(): Promise<DirectoryEntry[]> {
    const ranges = await this.read([
      "'School Directory'!A:O",
      "'Schools'!A:B",
      "'Schools'!Y:Y",
    ]);
    const [dirRange, schoolsBase, schoolsOsn] = ranges.map((r) => r.values ?? []);
    checkDirectoryHeader(dirRange?.[0]);
    checkHeader(schoolsBase?.[0], ["Record ID", "School / Organization"]);
    checkHeader(schoolsOsn?.[0], ["Ontario School Number"]);

    const claimedOsns = new Set<string>();
    const claimedNames: string[] = [];
    for (let i = 1; i < (schoolsBase?.length ?? 0); i++) {
      const row = schoolsBase![i];
      if (!row || !value(row[0])) continue;
      const name = value(row[1]).trim();
      const osn = value(schoolsOsn?.[i]?.[0]).trim();
      if (osn) claimedOsns.add(osn);
      if (name) claimedNames.push(name);
    }

    const entries: DirectoryEntry[] = [];
    for (let index = 1; index < (dirRange?.length ?? 0); index++) {
      const row = dirRange![index];
      if (!row || !row[0] || !row[1]) continue;
      const osn = value(row[0]).trim();
      const schoolName = value(row[1]).trim();
      const rawStatus = value(row[14]).trim();
      // Requirement: Blank Status does NOT count as Available. Require explicit Available.
      const isStatusAvailable = rawStatus.toLowerCase() === "available";
      const isOsnClaimed = osn !== "" && claimedOsns.has(osn);
      const isNameClaimed = claimedNames.some((claimedName) => sameName(claimedName, schoolName));
      const available = isStatusAvailable && !isOsnClaimed && !isNameClaimed;

      entries.push({
        osn, schoolName,
        schoolBoard: value(row[2]).trim(),
        schoolLevel: value(row[3]).trim(),
        gradeRange: value(row[4]).trim(),
        city: value(row[5]).trim(),
        streetAddress: value(row[6]).trim(),
        postalCode: value(row[7]).trim(),
        geographicRegion: value(row[11]).trim(),
        available,
      });
    }
    return entries;
  }
}

