// Original handoff coordinates. Validate headers before trusting these positions.
export const HEADERS = {
  Schools: [
    "Record ID", "School / Organization", "School Board", "Assigned To",
    "Contact Name", "Contact Role", "Email", "Outreach Goal", "Stage",
    "Last Contacted", "Follow-Up Due", "Next Action", "Priority", "Notes / Reply",
    "Phone (Optional)", "Potential Value (CAD)", "Follow-Up Flag", "Duplicate Flag",
    "Geographic Region", "Neighbourhood", "Board Area / Learning Centre",
    "School Group / Ward", "School Address", "Zone Source / Verification Link",
    "Ontario School Number", "Owner Email", "Follow-Up Count", "Last Request ID",
    "Cold Reason", "Phone Ext", "Social Profile", "Engagement Status",
  ],
  "CRM Users": ["Email", "Name", "Role", "Active"],
  "Activity Log": [
    "Activity ID", "Date", "School / Organization", "Assigned To", "Channel",
    "Outcome", "Contacted Person", "Message Summary", "Next Action", "Follow-Up Due",
    "Related Record ID", "Request ID", "Actor Email", "Activity Type", "Platform",
  ],
  "School Directory": [
    "Ontario School Number", "School Name", "School Board", "School Level",
    "Grade Range", "City / Municipality", "Street Address", "Postal Code", "Email",
    "Phone", "Website", "Geographic Region", "Board Area", "Zone Source Link", "Status",
  ],
} as const;

export type Cell = string | number | boolean;
export type Row = Cell[];
export type Tab = keyof typeof HEADERS;
export type Snapshot = Record<Tab, Row[]>;
export type ValueRange = { range: string; values: Row[] };
export type Batch = { valueInputOption: "RAW"; data: ValueRange[] };

export const C = {
  id: 0, name: 1, board: 2, assigned: 3, contactName: 4, contactRole: 5,
  email: 6, goal: 7, stage: 8, contacted: 9, due: 10, action: 11,
  priority: 12, notes: 13, phone: 14, value: 15, region: 18, address: 22,
  source: 23, osn: 24, owner: 25, count: 26, version: 27,
} as const;

export class ApiError extends Error {
  status: number;
  code: string;
  details: object;
  constructor(status: number, code: string, details: object = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function padded(row: Row | undefined, size = 32): Row {
  return Array.from({ length: size }, (_, i) => row?.[i] ?? "");
}

export function schoolWrites(rowNumber: number, row: Row): ValueRange[] {
  return [
    { range: `'Schools'!A${rowNumber}:P${rowNumber}`, values: [row.slice(0, 16)] },
    { range: `'Schools'!S${rowNumber}:AF${rowNumber}`, values: [row.slice(18, 32)] },
  ];
}

export function record(row: Row) {
  return {
    recordId: row[C.id], schoolName: row[C.name], ownerEmail: row[C.owner],
    lastRequestId: row[C.version], stage: row[C.stage], followUpCount: row[C.count],
    followUpDue: row[C.due], notes: row[C.notes],
  };
}

export function assertHeaders(snapshot: Snapshot) {
  for (const tab of Object.keys(HEADERS) as Tab[]) {
    const header = snapshot[tab]?.[0];
    if (HEADERS[tab].some((name, index) => header?.[index] !== name)) {
      throw new ApiError(503, "SCHEMA_MISMATCH", { tab });
    }
  }
}

export function editableRecord(row: Row) {
  return { ...record(row),
    schoolBoard: row[C.board], assignedTo: row[C.assigned],
    contactName: row[C.contactName] ?? "", contactRole: row[C.contactRole] ?? "",
    email: row[C.email] ?? "", phone: row[C.phone] ?? "", priority: row[C.priority] ?? "",
    outreachGoal: row[C.goal] ?? "", nextAction: row[C.action] ?? "",
  };
}
