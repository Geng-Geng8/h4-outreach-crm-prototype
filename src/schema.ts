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
    "Contact IDs",
  ],
  Contacts: [
    "Contact ID", "Record ID", "School Name", "Name", "Role",
    "Category", "Grade Range", "Program / Group", "Email", "Phone",
    "Notes", "Is Primary", "Active", "Updated At",
  ],
  "School Directory": [
    "Ontario School Number", "School Name", "School Board", "School Level",
    "Grade Range", "City / Municipality", "Street Address", "Postal Code", "Email",
    "Phone", "Website", "Geographic Region", "Board Area", "Zone Source Link", "Status",
  ],
  "Program Delivery": [
    "Delivery ID", "Record ID", "School Name", "Program Track",
    "Teachers Count", "Students Count", "Dance Team Confirmed",
    "Intro Workshop Done", "Music Submitted", "Video Submitted",
    "Finale Confirmed", "Thank You Sent", "Workshop Date",
    "Class Time", "School Start Time", "School End Time",
    "Student Mentors", "Delivery Notes", "Last Edited By",
    "Last Edited At", "Last Request ID",
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
  source: 23, osn: 24, owner: 25, count: 26, version: 27, coldReason: 28,
  engagementStatus: 31,
} as const;

export const ContactCol = {
  id: 0, recordId: 1, schoolName: 2, name: 3, role: 4,
  category: 5, gradeRange: 6, programGroup: 7, email: 8, phone: 9,
  notes: 10, isPrimary: 11, active: 12, updatedAt: 13,
} as const;

export const ActivityCol = {
  id: 0, date: 1, schoolName: 2, assignedTo: 3, channel: 4,
  outcome: 5, contactedPerson: 6, messageSummary: 7, nextAction: 8, followUpDue: 9,
  relatedRecordId: 10, requestId: 11, actorEmail: 12, activityType: 13, platform: 14,
  contactIds: 15,
} as const;

export const DELIVERY_TRACKS = ["Cypher Program", "Competitive Arts"] as const;
export type DeliveryTrack = (typeof DELIVERY_TRACKS)[number];

export const DeliveryCol = {
  id: 0,
  recordId: 1,
  schoolName: 2,
  programTrack: 3,
  teachersCount: 4,
  studentsCount: 5,
  danceTeamConfirmed: 6,
  introWorkshopDone: 7,
  musicSubmitted: 8,
  videoSubmitted: 9,
  finaleConfirmed: 10,
  thankYouSent: 11,
  workshopDate: 12,
  classTime: 13,
  schoolStartTime: 14,
  schoolEndTime: 15,
  studentMentors: 16,
  deliveryNotes: 17,
  lastEditedBy: 18,
  lastEditedAt: 19,
  lastRequestId: 20,
} as const;

export function deliveryRecord(row: Row) {
  const toBool = (cell: Cell | undefined) => String(cell ?? "").trim().toUpperCase() === "TRUE";
  const toCount = (cell: Cell | undefined) => {
    const n = Number(cell ?? 0);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  };
  return {
    deliveryId: String(row[DeliveryCol.id] ?? ""),
    recordId: String(row[DeliveryCol.recordId] ?? ""),
    schoolName: String(row[DeliveryCol.schoolName] ?? ""),
    programTrack: String(row[DeliveryCol.programTrack] ?? ""),
    teachersCount: toCount(row[DeliveryCol.teachersCount]),
    studentsCount: toCount(row[DeliveryCol.studentsCount]),
    danceTeamConfirmed: toBool(row[DeliveryCol.danceTeamConfirmed]),
    introWorkshopDone: toBool(row[DeliveryCol.introWorkshopDone]),
    musicSubmitted: toBool(row[DeliveryCol.musicSubmitted]),
    videoSubmitted: toBool(row[DeliveryCol.videoSubmitted]),
    finaleConfirmed: toBool(row[DeliveryCol.finaleConfirmed]),
    thankYouSent: toBool(row[DeliveryCol.thankYouSent]),
    workshopDate: String(row[DeliveryCol.workshopDate] ?? ""),
    classTime: String(row[DeliveryCol.classTime] ?? ""),
    schoolStartTime: String(row[DeliveryCol.schoolStartTime] ?? ""),
    schoolEndTime: String(row[DeliveryCol.schoolEndTime] ?? ""),
    studentMentors: String(row[DeliveryCol.studentMentors] ?? ""),
    deliveryNotes: String(row[DeliveryCol.deliveryNotes] ?? ""),
    lastEditedBy: String(row[DeliveryCol.lastEditedBy] ?? ""),
    lastEditedAt: String(row[DeliveryCol.lastEditedAt] ?? ""),
    lastRequestId: String(row[DeliveryCol.lastRequestId] ?? ""),
  };
}

export function contactRecord(row: Row) {
  return {
    contactId: String(row[ContactCol.id] ?? ""),
    recordId: String(row[ContactCol.recordId] ?? ""),
    schoolName: String(row[ContactCol.schoolName] ?? ""),
    name: String(row[ContactCol.name] ?? ""),
    role: String(row[ContactCol.role] ?? ""),
    category: String(row[ContactCol.category] ?? ""),
    gradeRange: String(row[ContactCol.gradeRange] ?? ""),
    programGroup: String(row[ContactCol.programGroup] ?? ""),
    email: String(row[ContactCol.email] ?? ""),
    phone: String(row[ContactCol.phone] ?? ""),
    notes: String(row[ContactCol.notes] ?? ""),
    isPrimary: String(row[ContactCol.isPrimary] ?? "").trim().toUpperCase() === "TRUE",
    active: ["TRUE", ""].includes(String(row[ContactCol.active] ?? "").trim().toUpperCase()),
    updatedAt: String(row[ContactCol.updatedAt] ?? ""),
  };
}

export const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com",
  "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "aim.com",
  "proton.me", "protonmail.com", "zoho.com", "yandex.com", "gmx.com", "mail.com",
]);

export function assertStudentPrivacy(category: string, email: string, phone: string) {
  if (category !== "Student") return;
  if (phone.trim()) {
    throw new ApiError(422, "STUDENT_PHONE_FORBIDDEN", {
      message: "Personal phone numbers cannot be stored for student contacts under student privacy rules.",
    });
  }
  const trimmedEmail = email.trim().toLowerCase();
  if (trimmedEmail) {
    const at = trimmedEmail.lastIndexOf("@");
    const domain = at !== -1 ? trimmedEmail.slice(at + 1) : "";
    if (CONSUMER_EMAIL_DOMAINS.has(domain)) {
      throw new ApiError(422, "STUDENT_PERSONAL_EMAIL_FORBIDDEN", {
        message: "Consumer email addresses (such as Gmail, Yahoo, Hotmail, iCloud) cannot be stored for student contacts. Only school-affiliated email addresses are permitted.",
      });
    }
  }
}

export function assertMentorPrivacy(studentMentors: string) {
  if (!studentMentors.trim()) return;
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(studentMentors) || /\(\d{3}\)\s*\d{3}[-.\s]?\d{4}\b/.test(studentMentors)) {
    throw new ApiError(422, "STUDENT_PRIVACY_VIOLATION", {
      message: "Phone numbers cannot be stored in Student Mentors under student privacy rules.",
    });
  }
  const emailDomainMatches = studentMentors.toLowerCase().matchAll(/@([a-z0-9.-]+\.[a-z]{2,})\b/g);
  for (const match of emailDomainMatches) {
    if (CONSUMER_EMAIL_DOMAINS.has(match[1]!)) {
      throw new ApiError(422, "STUDENT_PRIVACY_VIOLATION", {
        message: "Consumer email addresses (such as Gmail, Yahoo, Hotmail, iCloud) cannot be stored in Student Mentors under student privacy rules.",
      });
    }
  }
}

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

export function deliveryWrites(rowNumber: number, row: Row): ValueRange[] {
  return [
    { range: `'Program Delivery'!A${rowNumber}:U${rowNumber}`, values: [row.slice(0, 21)] },
  ];
}

export function record(row: Row) {
  return {
    recordId: row[C.id], schoolName: row[C.name], ownerEmail: row[C.owner],
    lastRequestId: row[C.version], stage: row[C.stage], followUpCount: row[C.count],
    followUpDue: row[C.due], notes: row[C.notes], coldReason: row[C.coldReason] ?? "",
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
    outreachGoal: row[C.goal] ?? "", goal: row[C.goal] ?? "", nextAction: row[C.action] ?? "",
    coldReason: row[C.coldReason] ?? "",
  };
}

export const PROGRAM_TAGS = [
  "Board Partnership",
  "SHSM",
  "Dance Workshops",
  "Co-op Workshops",
  "Volunteer Workshops",
  "After-School Program",
  "Keynotes",
  "Leadership Programs",
  "B Thee Rise",
  "Cypher Program",
  "Competitive Arts",
  "Filipino Projects",
  "Misc",
] as const;

export type ProgramTag = (typeof PROGRAM_TAGS)[number];

export const VALID_STAGES = [
  "Not Contacted",
  "Contacted",
  "Interested",
  "Engaged",
  "Booked",
  "Completed",
  "Cold",
] as const;

export type Stage = (typeof VALID_STAGES)[number];

export const EXPLICIT_REJECTION_REASONS = [
  "Not Interested",
  "Explicit Rejection / Not Interested",
  "No Budget / Funding",
  "Timing / Scheduling Conflict",
  "Outside Program Scope / Ineligible",
  "Other (Declined)",
] as const;

export const DEFAULT_DECLINE_REASON = "Explicit Rejection / Not Interested";
export const UNRESPONSIVE_COLD_REASON = "Unresponsive (2+ follow-ups completed with no reply)";

export interface ColdEvaluationParams {
  currentStage: string;
  followUpCount: number;
  followUpDue: string | null;
  coldReason?: string;
  isExplicitRejection?: boolean;
  today?: string;
}

export function evaluateColdEligibility(params: ColdEvaluationParams): { allowed: boolean; reason: string } {
  const PROTECTED_STAGES = new Set(["Interested", "Engaged", "Booked", "Completed"]);

  if (PROTECTED_STAGES.has(params.currentStage)) {
    return {
      allowed: false,
      reason: `Schools in "${params.currentStage}" stage are protected. Change stage to Contacted first before marking Cold.`,
    };
  }

  const explicitRejectionReasons = [
    "Not Interested",
    "Explicit Rejection / Not Interested",
    "No Budget / Funding",
    "Timing / Scheduling Conflict",
    "Outside Program Scope / Ineligible",
    "Other (Declined)",
  ];

  if (
    params.isExplicitRejection ||
    (params.coldReason && explicitRejectionReasons.includes(params.coldReason))
  ) {
    return {
      allowed: true,
      reason: "Eligible for Cold status (Explicit rejection / declined by school).",
    };
  }

  // Unresponsive path
  if (params.followUpCount < 2) {
    return {
      allowed: false,
      reason: `Requires 2 unanswered follow-ups before marking Cold due to no response (currently ${params.followUpCount}/2), OR select an explicit decline reason.`,
    };
  }

  const today = params.today || new Date().toISOString().slice(0, 10);
  if (!params.followUpDue || today <= params.followUpDue) {
    return {
      allowed: false,
      reason: `Response deadline (${params.followUpDue || "not set"}) must pass before marking Cold due to no response.`,
    };
  }

  return {
    allowed: true,
    reason: "Eligible for Cold status (2 unanswered follow-ups completed & deadline passed).",
  };
}
