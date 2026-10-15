import { GoogleSheetsReadOnly, TEST_SHEET_ID, type ReadOnlyConfig } from "./google-sheets-read";
import { ApiError, HEADERS, assertHeaders, type Batch, type Snapshot, type Tab, type Row } from "./schema";

export const SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

// The coordinator uses this adapter only for the pinned test workbook.
export class GoogleSheetsCoordinator extends GoogleSheetsReadOnly {
  constructor(config: ReadOnlyConfig) { super(config, SHEETS_WRITE_SCOPE); }

  private async request(method: string, suffix: string, body?: object): Promise<Response> {
    if (this.config.GOOGLE_SHEET_ID !== TEST_SHEET_ID) throw new ApiError(503, "TEST_SHEET_REQUIRED");
    return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${TEST_SHEET_ID}/${suffix}`, {
      method, redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async snapshot(): Promise<Snapshot> {
    const query = new URLSearchParams({ valueRenderOption: "FORMULA", dateTimeRenderOption: "FORMATTED_STRING" });
    const tabs = Object.keys(HEADERS) as Tab[];
    for (const tab of tabs) query.append("ranges", `'${tab}'!${tab === "Schools" ? "A:AF" : tab === "CRM Users" ? "A:D" : "A:O"}`);
    const response = await this.request("GET", `values:batchGet?${query}`);
    if (!response.ok) throw new ApiError(503, response.status === 403 ? "TEST_SHEET_ACCESS_REQUIRED" : "SHEETS_READ_FAILED");
    const data = await response.json<{ valueRanges?: { values?: Row[] }[] }>();
    if (data.valueRanges?.length !== tabs.length) throw new ApiError(503, "SCHEMA_MISMATCH");
    const snapshot = Object.fromEntries(tabs.map((tab, i) => [tab, data.valueRanges![i]!.values ?? []])) as Snapshot;
    // Verified workbook labels differ from the original handoff. Normalize only
    // known header aliases in memory; no workbook headers are changed.
    const aliases: Record<string, string> = {
      "School Number": "Ontario School Number", Board: "School Board", Level: "School Level",
      Grades: "Grade Range", City: "City / Municipality", "Outreach Status": "Status",
      "School Email": "Email", "Board Zone": "Board Area", "Data Source": "Zone Source Link",
    };
    const header = snapshot["School Directory"][0];
    if (header) snapshot["School Directory"][0] = header.map((cell) => aliases[String(cell)] ?? cell);
    assertHeaders(snapshot);
    return snapshot;
  }

  async write(batch: Batch): Promise<Response> {
    if (batch.valueInputOption !== "RAW" || batch.data.length !== 3) throw new ApiError(422, "INVALID_WRITE_RANGES");
    const a = /^'Schools'!A(\d+):P\1$/.exec(batch.data[0]!.range);
    const b = /^'Schools'!S(\d+):AF\1$/.exec(batch.data[1]!.range);
    const log = /^'Activity Log'!A(\d+):O\1$/.exec(batch.data[2]!.range);
    if (!a || !b || !log || a[1] !== b[1] || Number(a[1]) < 2 || Number(a[1]) > 500 || Number(log[1]) < 2 ||
        batch.data.some((range, i) => range.values.length !== 1 || range.values[0]?.length !== [16, 14, 15][i])) {
      throw new ApiError(422, "INVALID_WRITE_RANGES");
    }
    return this.request("POST", "values:batchUpdate", batch);
  }
}
