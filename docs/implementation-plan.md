# H4 Outreach CRM prototype: corrected implementation plan

**Current scope supersedes the historical milestones below:** real test-sheet
claims and editing are implemented. The user subsequently authorized hosting
this prototype using GitHub Pages plus a Cloudflare API. See `hosting.md` and
`test-claims.md`. Production remains untouched.

Status: local read-only Google sign-in implementation plus the preserved synthetic
save-safety proof. Updated 2026-10-15. See `read-only-milestone.md` for current scope,
interim visibility rules, evidence and user-controlled Google setup.

The user confirmed no completed audit report exists and asked to proceed. Only
the Schools/CRM Users headers and metadata needed for this step were checked
against the connected test workbook. No full workbook audit is claimed. The
application now uses `src/read-only.ts`; real mutations are disabled. The earlier
coordinator remains a separate synthetic test proof.

## 1. Goal and boundaries

H4 Community (How Hip Hop Helps) delivers educational dance workshops to Ontario
schools. The eventual mobile-first CRM supports roughly ten concurrent student
co-op workers and staff supervisors, with no monthly hosting spend within free
tier limits. The critical loop is find school -> inspect -> claim/contact -> log
outreach -> see a confirmed save.

- Prototype repository: https://github.com/Geng-Geng8/h4-outreach-crm-prototype
- Production boundary: https://github.com/Geng-Geng8/h4-outreach-crm must remain
  untouched. No legacy code, deployment, or records are modified in this phase.
- Future test spreadsheet: `Copy of H4 | School Outreach CRM (2026-2027) - Test`.
- Future test Sheet ID: `1QzYTKdeWWa2TpOtGSmJ0NDMeY_U-u3ImeCVdpCmJrH4`.
- The supplied schema, 1,563-school directory count, existing example record, and
  row formatting are handoff assertions, not independently verified Sheet facts.
- Do not embed supplied real names, personal emails, notes, or copied test records
  in public sandbox fixtures. Use invented `example.test` identities.

Authorized now: local development on the existing branch, real Google sign-in,
a read-only test spreadsheet connection, a minimal authorized-school screen, and
preserved save tests. No push, deployment or live cell mutation is authorized.
Production is untouched. Credentialed end-to-end verification depends on the
user's Google setup; no private keys are requested in chat.

## 2. Corrected architecture

Eventual architecture:

```text
GitHub Pages frontend
  -> Worker: Google token verification, response filtering, HTTP/CORS
  -> one SQLite-backed Durable Object coordinator per spreadsheet
  -> Google Sheets API v4 / existing spreadsheet
```

SQLite in the coordinator stores the operation journal, not a second authoritative
CRM database. Sheets remains the record store. All application mutations, including
claims and user administration, must use the same server-chosen object name for
the spreadsheet. Clients cannot choose workbook IDs or coordinator names.

The original stateless-only restriction is superseded. Separate read/check/write
requests plus a post-write re-read are not compare-and-set: two clients can each
receive success while one overwrites the other. Frontend button locks prevent
some duplicate taps, not concurrent users or network retries. SQLite-backed
Durable Objects are available on Workers Free; keep usage within its limits.
See [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

The local proof runs the actual DO class in Miniflare/workerd with SQLite enabled.
Its Sheets service is a contract fake, with no credentials or Google network calls.
`PROOF_MODE=synthetic`, `GOOGLE_SHEET_ID=synthetic-h4`, and a synthetic service
binding are all required. The checked-in Wrangler configuration disables proof
mutations. Header-based fixture identity is never a production authentication path.

## 3. Data integrity protocol

Each client mutation supplies a UUIDv4 `requestId`. Updates/activities also supply
`recordId` and the previous `expectedRequestId`. These serve different purposes:

- `recordId`: stable record identity, never a browser-supplied row number.
- `expectedRequestId`: the version the user edited; mismatch -> HTTP 409 and the
  current authorized record, while the UI preserves the draft.
- `requestId`: identity of this operation; retries reuse it and the same payload.
  A new edit uses a new ID. Payload or actor changes under an existing ID -> 409.

Serialize the entire fresh-read/authorization/version-check/row-selection/journal/
write sequence. A normal async `fetch()` yields, so being in a DO alone is not
enough. This proof uses `blockConcurrencyWhile` around that sequence, catches
errors inside the callback, and bounds upstream calls to five seconds. Cloudflare
has a 30-second callback reset limit; live latency and abort behavior need separate
verification. [Concurrency API](https://developers.cloudflare.com/durable-objects/api/state/).

Before dispatch, persist the request fingerprint and exact intended batch/result
in SQLite as pending. Keep historical committed results so an old retry cannot
become a new mutation after a later save. Verify current permissions before a replay.
Keep coordinator namespace identity and durable state stable across releases.

For every mutation in this proof, allocate a log row and perform exactly ONE
`spreadsheets.values.batchUpdate`-shaped call with `valueInputOption: RAW`:

1. `'Schools'!A{schoolRow}:P{schoolRow}`: 16 cells.
2. `'Schools'!S{schoolRow}:AF{schoolRow}`: 14 cells.
3. `'Activity Log'!A{activityRow}:O{activityRow}`: 15 cells, including request ID L.

Never submit `Schools!A:AF` as a contiguous write or touch Q/R. This replaces the
original two-step activity-first append/update protocol. Google documents atomic
application of a single Sheets request; no partial school/log success should be
presented. The fake models that contract; only live integration can verify the
real adapter and workbook. [Google limits/atomicity](https://developers.google.com/workspace/sheets/api/limits),
[values.batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate).

A 200 write acknowledgement commits the journal result. A definite upstream
rejection records a failure. A transport failure or ambiguous upstream response
does not prove failure. Reconcile only if the exact intended school ranges and
exact log row/unique request marker are visible. If not, retain pending state,
return 503 `COMMIT_UNCERTAIN`, and block new mutations with `WORKBOOK_BLOCKED`.
Do not blindly resend an append or assume an absent marker means rollback.

The DO journal and Google Sheets do NOT share a transaction. This protocol chooses
safe blocking for unresolved outcomes. Automatic/operator recovery when no commit
ever becomes visible remains a prerequisite to real use. Direct Sheet edits,
sorting, deleting/reordering rows, parallel legacy writers, and changing namespace
identity can violate assumptions; an operating policy must be agreed first.

## 4. Exact supplied schema (no tab/column changes)

Validate headers before using these fixed coordinates. Extra existing columns
must be preserved. Resolve/validate against header names, not unverified offsets.

### Schools: A:AF, 32 columns

| Column | Index | Header / meaning |
| --- | ---: | --- |
| A | 0 | Record ID; UUIDv4 |
| B | 1 | School / Organization |
| C | 2 | School Board |
| D | 3 | Assigned To; display name |
| E | 4 | Contact Name |
| F | 5 | Contact Role |
| G | 6 | Email |
| H | 7 | Outreach Goal |
| I | 8 | Stage |
| J | 9 | Last Contacted |
| K | 10 | Follow-Up Due |
| L | 11 | Next Action |
| M | 12 | Priority |
| N | 13 | Notes / Reply |
| O | 14 | Phone (Optional) |
| P | 15 | Potential Value (CAD) |
| Q | 16 | Follow-Up Flag; protected formula, NEVER WRITE |
| R | 17 | Duplicate Flag; protected formula, NEVER WRITE |
| S | 18 | Geographic Region |
| T | 19 | Neighbourhood |
| U | 20 | Board Area / Learning Centre |
| V | 21 | School Group / Ward |
| W | 22 | School Address |
| X | 23 | Zone Source / Verification Link |
| Y | 24 | Ontario School Number; preserve string/leading zeros |
| Z | 25 | Owner Email; lowercase |
| AA | 26 | Follow-Up Count; integer |
| AB | 27 | Last Request ID; latest operation/version UUID |
| AC | 28 | Cold Reason |
| AD | 29 | Phone Ext |
| AE | 30 | Social Profile |
| AF | 31 | Engagement Status |

Stage values: `Not Contacted`, `Contacted`, `Interested`, `Engaged`, `Booked`, `Cold`.
Priority values: `High`, `Medium`, `Low`. The proof permits clearing priority;
the final permitted blank/default policy remains subject to validation rules.

### CRM Users: A:D

| Column | Index | Header |
| --- | ---: | --- |
| A | 0 | Email |
| B | 1 | Name |
| C | 2 | Role (`Supervisor` or `co-op`) |
| D | 3 | Active |

Original legacy rule: TRUE or blank is active; FALSE, NO, REMOVED is revoked.
The proof accepts only TRUE/blank as active, rejects unknown roles/status values,
and denies duplicate matching user emails. It rereads permissions on every call,
including replays, without a distributed in-memory permission cache.

### Activity Log: A:O

| Column | Index | Header |
| --- | ---: | --- |
| A | 0 | Activity ID; UUIDv4 |
| B | 1 | Date |
| C | 2 | School / Organization |
| D | 3 | Assigned To |
| E | 4 | Channel |
| F | 5 | Outcome |
| G | 6 | Contacted Person |
| H | 7 | Message Summary |
| I | 8 | Next Action |
| J | 9 | Follow-Up Due |
| K | 10 | Related Record ID |
| L | 11 | Request ID |
| M | 12 | Actor Email |
| N | 13 | Activity Type |
| O | 14 | Platform |

Allowed handoff channels: Email, Phone, Follow-Up, Social, Meeting, Reply, App.
The proof uses types Claimed, Updated, Outreach, FollowUp and platform
`Local synthetic proof`. Final type/outcome vocabulary needs agreement. Every proof
mutation has an audit entry, including contact/note updates.

### School Directory: A:O

| Column | Index | Header |
| --- | ---: | --- |
| A | 0 | Ontario School Number |
| B | 1 | School Name |
| C | 2 | School Board |
| D | 3 | School Level |
| E | 4 | Grade Range |
| F | 5 | City / Municipality |
| G | 6 | Street Address |
| H | 7 | Postal Code |
| I | 8 | Email |
| J | 9 | Phone |
| K | 10 | Website |
| L | 11 | Geographic Region |
| M | 12 | Board Area |
| N | 13 | Zone Source Link |
| O | 14 | Status (`Available`) |

### Row selection, formulas, dates, and input handling

- Never use `values.append` for school claims. Select the first safe slot in rows
  2-500 under serialization. The handoff says rows 3-500 are preformatted; row 2
  holds an existing record. Verify this in the real workbook before integration.
- A/B empty is insufficient. Skip a slot containing any writable cell data;
  Q/R formulas are allowed. Check OSN and normalized name across all existing rows,
  including partial rows. Do not overwrite orphaned notes or partially filled rows.
- If no safe slot exists, fail explicitly with `PREFORMATTED_ROWS_FULL`; do not
  append beyond validated capacity. Live log-grid expansion is not implemented.
- Dropdown formatting alone is not a universal explanation of append behavior;
  append placement follows detected table data. [Google append reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append).
- RAW strings are not parsed as formulas; do not add literal apostrophes under RAW.
  Escape separately if a later CSV/export feature can reinterpret formulas.
- RAW ISO date strings are not numeric Sheet date cells. Verify existing TODAY,
  dashboard, sorting, and duplicate/follow-up formulas against the actual types.
  If serial dates are required, use typed numeric cells and preserve date format.
  Do not enable USER_ENTERED for arbitrary text. [ValueInputOption](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption).
- The fake stores formula text without evaluating it. Writable columns are assumed
  to be ordinary values; verify that assumption before rewriting split ranges.
- Business dates use America/Toronto, not the client's clock or server UTC date.
  The harness fixes today to 2026-10-15 for deterministic tests.

## 5. Business rules and authorization

Claims derive school data from the directory and owner/display name from the
authenticated actor. Updates/activities require current ownership or Supervisor
role. Clients cannot set owner, actor, row number, count, or version arbitrarily.
Use explicit editable-field allowlists. Roles and record ownership are rechecked
inside the serialized mutation, not just when drawing the UI.

Original Cold guard: reject a transition to Cold if current stage is Interested,
Engaged, or Booked; current follow-up count is below 2; or current due date is blank
or not strictly earlier than Toronto today. Return 422 with a clear explanation.
The proof implements that direct check. Its FollowUp event increments count once;
other events do not. It does not claim this resolves the final business workflow.

### Unresolved business and operating decisions

| Decision | Proof behavior | Must settle before real users |
| --- | --- | --- |
| What is a follow-up? | Explicit FollowUp type, independent of channel | Which actions qualify, minimum spacing, same-day attempts |
| Count cap/reset | Increment, no reset/cap | Does count stop at 2? Reset on reply, reassignment, or new campaign? |
| Warm-stage protection | Checks current stage only | Can warm schools be downgraded, then Cold? Transition matrix/override policy |
| Cold details | Guard enforced; no cold-reason editor | Required reasons, supervisor exceptions, reopen behavior |
| Student read visibility | No bootstrap/list endpoint yet | All school cards vs only own records; notes/history/contact privacy |
| Duplicate names | Conservative normalized-name OR OSN match | Same-name schools in different boards, missing OSNs, community organizations |
| Reassignment/release | Not implemented | Who may transfer/release; effect on history and counts |
| Blank Active values | Legacy active behavior retained | Keep compatibility or require explicit TRUE? |
| User administration | Future Supervisor-only operation | Duplicate names/emails, last-supervisor protection, self-revocation |
| Outreach evidence | Logging is user-reported | What confirms an email was actually sent? Never infer from compose opening |
| Field policies | Narrow editable proof fields | Required fields, dropdown values/defaults, URL/email limits, notes replace/append |
| Direct Sheet changes | Assumed absent during writes | Staff edit/sort policy, protected grids, other writers and recovery |
| Uncertain outcomes | Block and reconcile; no blind resend | Operator recovery when no commit is observable; namespace/journal recovery |
| Retention | Full local journal, per-test cleanup | Production journal/activity/draft retention, backup/restore, size limits |
| Workbook behavior | Coordinates from handoff only | Actual formulas, date types, protections, validation, grid capacity |

## 6. Eventual frontend and API

Frontend: vanilla HTML/JS, mobile-first accessible UI, local search/filtering across
the directory, explicit draft/sending/confirmed/conflict/error states. Plain or
generated CSS is preferable to Tailwind Play CDN for release; that CDN is for
development. [Tailwind guidance](https://tailwindcss.com/docs/installation/play-cdn).

Draft storage must be keyed by environment, authenticated user, and record. Preserve
drafts through conflicts/token expiry, clear appropriately on logout/account switch,
handle unavailable storage, and state limits honestly. Session storage survives
ordinary reloads, not guaranteed tab closure or all iOS lifecycle events. No durable
offline write queue is planned. [sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage).

Demo mode is explicit and synthetic, with separate storage and clear labeling. A
failed live save must never silently fall back to a successful sandbox save.
Compose links may open Gmail or mailto; backend email sending remains out of scope.

| Endpoint | Eventual behavior | Current proof |
| --- | --- | --- |
| GET /api/health | Public health response | Implemented; read-only mode labeled |
| GET /api/config | Public client ID/setup readiness, no credentials | Implemented |
| GET /api/bootstrap | Auth, role-filtered data | Implemented for current user and limited summaries; other datasets deferred |
| POST /api/schools/claim | Serialized claim + atomic audit | Synthetic only |
| POST /api/schools/update | Owner/Supervisor, version check + audit | Synthetic narrow fields |
| POST /api/activities | Owner/Supervisor, version/rules check, atomic activity + school | Synthetic only |
| POST /api/users | Supervisor-only mutation through same coordinator, fresh permission checks | Deferred |

All non-health live endpoints require `Authorization: Bearer <Google ID token>`.
Return 401 for invalid/expired identity, 403 for authorization failure, 409 for
stale version/duplicate claim/request reuse, 422 for invalid business input, and
appropriate 429/503 for throttling/unavailable or uncertain operations. Preserve
drafts on failure. The proof additionally returns 502 for a definite fake upstream
batch rejection. An identical replay returns the original result with `replayed`;
the UI must refresh current state before presenting it as the latest version.

Verify Google signatures locally using rotated/cached Google keys and explicit
algorithm, issuer, audience, and expiry checks. Define verified-email/domain
policy and stable sub identity handling. `tokeninfo` is for debugging. A maintained
JWT library is allowed if safer than bespoke verification; zero runtime dependencies
is not more important than correctness. [Google verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

Allow only the intended frontend origins and implement unauthenticated OPTIONS
preflight for Authorization/JSON POSTs. Do not confuse CORS with authorization.
`https://geng-geng8.github.io` is the origin; the repository subpath is not part of
an origin. Current proof implements no cross-origin browser flow.

## 7. Credentials, quotas, and future deployment

Future public config: test GOOGLE_SHEET_ID, GOOGLE_CLIENT_ID, ALLOWED_ORIGIN.
Service-account email may be configured server-side; GOOGLE_PRIVATE_KEY is secret.
CLOUDFLARE_API_TOKEN belongs in the future deploy environment; account ID is an
identifier, not a credential. Never place private keys/tokens in frontend code,
logs, fixtures, Git history, or browser storage. No secrets are required now.

Before credentialed integration: create a dedicated service account, enable Sheets
API, share only the test spreadsheet with it, and configure its key outside Git.
Students get no direct Sheet/Drive permissions. Supervisors' access must follow
the agreed direct-edit policy. Document ownership, revocation, and backups.

Cache service-account access tokens and directory data sensibly. Avoid returning
unbounded historical activity logs on every bootstrap. Default Sheets quotas are
60 reads and 60 writes per minute per user/project, with the service account
counting as one user; project limits also apply. Use bounded backoff for appropriate
failures, not blind retries of ambiguous mutations. [Google quotas](https://developers.google.com/workspace/sheets/api/limits).

Free-tier availability does not guarantee unlimited throughput or future pricing.
Keep free-plan limits explicit, measure the actual request budget, and avoid paid
upgrades/overages. No paid infrastructure or billing configuration is introduced.

The four-core-file-only constraint is superseded. Focused source modules, pinned
development tools, tests, lockfile, and docs are necessary for reviewability.
The eventual frontend and deploy.yml remain deferred. Before authorized deployment,
add typecheck/tests, scoped credentials, explicit Pages artifact allowlisting
(frontend assets only; not source/tests/fixtures/docs), deployment verification,
and rollback instructions. No automatic deployment exists in this phase.

## 8. Milestones and acceptance criteria

1. **Local proof (current):** real local Worker/SQLite runtime with fake Sheets;
   distinct rows for concurrent different claims; one success for a duplicate
   claim; stale edits cannot mutate; retries cannot duplicate activity; one atomic
   batch for school/log; Q/R unchanged; restart persistence; ambiguous outcomes
   block and later reconcile. Document evidence and limitations.
2. **Test integration:** settle business decisions; implement real authentication,
   actual Sheets adapter and operator recovery; inspect real workbook read-only
   first. Then explicitly authorized synthetic test writes validate dates,
   protections, formulas, retries and permission revocation. Do not reuse local
   fixture identity in this build.
3. **Student UI:** build find/claim/contact/log workflows and explicit sandbox;
   test accessibility, mobile Safari/Android, account switching, drafts, expired
   login, poor connections, and conflict recovery.
4. **Review/release:** review actual diff and test evidence, then separately
   authorize push/deploy and evaluate prototype results. Production migration is
   a distinct future decision.

Local test results cannot prove Google behavior, real device usability, OAuth
configuration, quota performance, or production readiness. See verification.md.
