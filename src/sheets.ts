import { ApiError, assertHeaders, HEADERS, type Batch, type Snapshot, type Tab } from "./schema";

// This service binding is supplied ONLY by the local test harness. No Google token,
// private key, or real spreadsheet URL is used by this proof.
export class SyntheticSheets {
  constructor(private service: Fetcher, private sheetId: string = "synthetic-h4") {}

  async read(): Promise<Snapshot> {
    const url = new URL(`https://synthetic.invalid/v4/spreadsheets/${this.sheetId}/values:batchGet`);
    for (const tab of Object.keys(HEADERS) as Tab[]) {
      const range = tab === "Schools" ? "A1:AF500" : tab === "CRM Users" ? "A1:D" : tab === "Contacts" ? "A1:N500" : tab === "Activity Log" ? "A1:P" : "A1:O";
      url.searchParams.append("ranges", `'${tab}'!${range}`);
    }
    url.searchParams.set("valueRenderOption", "FORMULA");
    const response = await this.service.fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new ApiError(503, "SHEETS_READ_FAILED");
    const payload = await response.json<{ valueRanges: { values?: Snapshot[Tab] }[] }>();
    if (!Array.isArray(payload.valueRanges) || payload.valueRanges.length !== 5) {
      throw new ApiError(503, "SCHEMA_MISMATCH");
    }
    const snapshot = Object.fromEntries(
      (Object.keys(HEADERS) as Tab[]).map((tab, i) => [tab, payload.valueRanges[i]?.values ?? []]),
    ) as Snapshot;
    assertHeaders(snapshot);
    return snapshot;
  }

  async write(batch: Batch): Promise<Response> {
    return this.service.fetch(`https://synthetic.invalid/v4/spreadsheets/${this.sheetId}/values:batchUpdate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(batch), signal: AbortSignal.timeout(5000),
    });
  }
}
