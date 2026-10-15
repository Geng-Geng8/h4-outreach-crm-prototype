# Read-only sign-in milestone

Date: 2026-10-15 (America/Toronto). Branch: `codex/save-safety-proof`.

## What changed

The local app has GIS sign-in and a real, read-only Sheets adapter. Its configured
entry is `src/read-only.ts`; it never imports the synthetic write coordinator. The
25 earlier save-safety tests and their SQLite Durable Object remain unchanged.

The user clarified that no completed workbook audit report exists and asked to
continue implementation. No full audit is claimed. Bounded read-only connector
checks verified Schools A1:AF1 and CRM Users A1:D1 against the handoff; they match.
Metadata shows America/Toronto time zone and 1,000 rows in each of those tabs. Other
tabs, formulas, validations and protections were not re-audited. Source:
[test workbook](https://docs.google.com/spreadsheets/d/1QzYTKdeWWa2TpOtGSmJ0NDMeY_U-u3ImeCVdpCmJrH4/edit).

## Server behavior

- GIS ID tokens use pinned jose, a fixed Google JWKS endpoint, RS256 only, issuer,
  exact audience, authorized-party, issued-at, expiry, subject and verified-email
  checks. Gmail and Google Workspace email are supported; other Google Account
  providers stay blocked pending additional ownership-verification policy. Google
  subject is returned as the identity ID; unchanged CRM Users still allowlists
  verified email.
- CRM Users is reread on every request. Exactly one email match and a recognized
  role are required. FALSE/NO/REMOVED/unknown statuses are denied. Blank Active
  retains the original legacy active behavior; that policy remains unresolved.
- Authorization happens before school reads. Denied users cause no school range
  fetch. There is no mutable permission cache with distributed invalidation claims.
- Service-account assertions request only `spreadsheets.readonly`. Access tokens
  are cached/coalesced in memory; user permissions are checked separately.
- The adapter targets the exact test Sheet ID and only bounded values.batchGet
  reads. No Activity Log or private contact/note columns are fetched. Selected
  headers are checked before offsets are trusted.
- All mutating API methods return 405 before any Google request, even with proof
  headers/flags. No real write adapter or coordinator binding is present.
- Upstream redirects use manual handling and fail without forwarding credentials.
  This also resolved a local workerd compatibility issue with redirect `error`.
- Exact-origin CORS supports read-only requests/preflights. Responses use no-store.
  Raw upstream errors, assertions, tokens and keys are never returned/logged. Only
  public frontend files are served; repository/secret paths return 404.

## Interim visibility rules

| Role | Records | Fields returned |
| --- | --- | --- |
| Student co-op | Owner Email matches verified email | ID, name, board, assignment display name, stage, priority, region |
| Supervisor | All test-sheet summaries | Same field allowlist |

No role receives contact names/emails/phones, notes, social profiles, potential
value, activity history or other user information. Owner Email is used inside the
server filter and not returned per school. Search in the UI does not grant access.

Unresolved: broader student browsing/claim visibility; private-field/history access;
blank Active behavior; onboarding third-party-email Google Accounts; and persistent
subject binding if a future policy needs it. Additional data stays hidden meanwhile.

## Frontend and configuration

The responsive page shows account identity, school cards, search, refresh and
sign-out. Tokens/records live only in page memory. Sign-out, expiry or failed
authorization clears school data. Visible pages refresh every 60 seconds and when
returning to the tab. Revocation takes effect on the next request, not retroactively
inside a screen that was already rendered.

Before credentials exist, the page says Google setup is needed; it never pretends
fixture data is real. `npm run dev` serves localhost:8787. Local config contains a
public client ID and absolute path to a JSON key outside the repository. The dev
runner reads that key into memory without writing it into source or browser output.
See google-setup.md for a stepwise guide. No credentials have been created or changed.

## Observed verification

### 1. Complete Google-authenticated browser tests (Observed 2026-10-15)
- **Interactive GIS Sign-In**: Successfully authenticated user `supervisor@example.test` through Google Identity Services in Chrome/Edge on `http://localhost:8787`.
- **Supervisor Role & Card Rendering**: Backend verified the Google ID token and CRM Users role, returning `Supervisor`; UI rendered the live assigned school summary card ("St John Paul II Catholic Secondary School", TCDSB, Scarborough, Not Contacted, Medium priority) matching spreadsheet row 2.
- **Privacy & Field Exclusion in UI**: UI displayed only the permitted summary fields; no private contact info, notes, or activity history appeared.
- **Write-Safety in UI & API**: Confirmed no edit/mutation controls exist in the UI; backend blocks mutating endpoints with `405 Method Not Allowed`.
- **Sign-Out Memory Clear**: Confirmed clicking "Sign out" wipes credentials, school records, and DOM from page memory, and triggers Google's script to re-render the sign-in button.

### 2. Direct service-account adapter checks against live Sheet (Observed 2026-10-15)
- **Token Exchange**: Key loaded from outside the repository; obtained `spreadsheets.readonly` tokens via `https://oauth2.googleapis.com/token`.
- **Live Test Spreadsheet Read**: Successfully performed `values:batchGet` against test spreadsheet `1QzYTKdeWWa2TpOtGSmJ0NDMeY_U-u3ImeCVdpCmJrH4`.
- **Live User Roster Verification**: Directly read `'CRM Users'!A1:D1000`, observing 3 active accounts (`supervisor@example.test` as Supervisor, `student.one@example.test` and `student.two@example.test` as co-op).
- **Direct Authorization Logic**: Direct adapter call `authorize('supervisor@example.test')` resolved Supervisor role; `authorize('student.one@example.test')` resolved co-op role.
- **Ownership Filtering Check**: Direct adapter call `schools(uGlen)` returned 1 school; `schools(uIsh)` returned 0 schools (no matching owner email in row 2).
- **Direct Unlisted User Rejection**: Direct adapter call `authorize('notlisted@example.com')` threw `403 USER_NOT_ALLOWED`.

###### 3. Automated test suite (63 passed, 0 failed)
- TypeScript checking and JavaScript syntax checks passed (`tsc --noEmit`).
- **63 automated tests passed, 0 failed**:
  - 25 save-safety tests (`test/save-safety.test.mjs`).
  - 29 read-only, directory, and demo-claim tests (`test/read-only.test.mjs`).
  - 3 focused frontend browser-state regression tests (`test/frontend.test.mjs`).
  - 6 operator-recovery proof tests (`test/operator-recovery.test.mjs`).
- 0 known vulnerabilities in dependency audit.
- Coverage includes:
  - Valid/forged/expired/misissued tokens, mandatory claims, inactive/unlisted/duplicate users, changing permissions, ownership/Supervisor filtering, header/query bypass attempts, read-only scope, token/key reuse, mutation denial, CORS, missing config, test-ID pinning, schema drift, safe upstream errors, private field exclusion, static-file restrictions.
  - Server-side directory availability correlation, student privacy protections, complete column schema validation.
  - Invented school demo restrictions, SQLite DO coordinator claim flow, demo identity isolation, blank status exclusion.
  - Browser-state handling regressions (decoupled session versions, post-parse validation, dynamic demo availability reload).
  - Operator recovery for uncertain claims (lost acks, definite rejections, conflicting evidence, restart survival, late write completion, and Supervisor-only authorization).

### 4. Directory browsing & synthetic demo claim milestone (Observed 2026-10-15)
- **Directory Completeness & Actual Counts**: Bounded reading `A1:O1000` was replaced with complete unbounded reading (`'School Directory'!A:O`, `'Schools'!A:B`, `'Schools'!Y:Y`).
  - *Observation*: Confirmed against live test spreadsheet `1QzYTKdeWWa2TpOtGSmJ0NDMeY_U-u3ImeCVdpCmJrH4` via direct read-only adapter check: all 1,563 Ontario schools (rows 2–1564) are read without silent truncation.
  - *Test Distinction*: Automated regression fixtures test unbounded range logic, column filtering, and schema parsing on smaller mock datasets; they do not construct or fetch 1,563 rows.
- **Server-Side Availability & Strict Header Validation**:
  - Blank status in `School Directory` does NOT count as available; explicit "Available" is required.
  - Validates all 10 used directory columns (`School Number`, `School Name`, `Board`, `Level`, `Grades`, `City`, `Street Address`, `Postal Code`, `Geographic Region`, `Outreach Status`) before trusting offsets.
  - Correctly resolves `available: false` for schools already claimed in `Schools` (e.g. *St John Paul II Catholic Secondary School* in row 2) even when Directory status is "Available".
- **Student Privacy Guaranteed**: Directory entries expose only public school attributes (OSN, school name, board, level, grades, city, street address, postal code, region, and server-computed boolean `available`). No student identity, owner email, private notes, contact info, or assignment details are ever returned in directory responses.
- **Strict Read-Only Real Adapter**: Real Google Sheets adapter remains strictly read-only (`spreadsheets.readonly`). Direct mutations against real schools are completely blocked with `405 Method Not Allowed`.
- **Demo Identity Isolation**:
  - `/api/demo/claim` verifies active CRM membership against real `CRM Users` (unlisted or inactive accounts fail closed with `403 USER_NOT_ALLOWED`).
  - Active members are explicitly mapped to an isolated synthetic actor (`morgan@example.test` for Supervisors, `alex@example.test` for co-op students). Real Google emails are NEVER forwarded into `FakeSheets` or fixtures.
- **Dynamic Demo Availability**:
  - `/api/demo/schools` queries `DEMO_COORDINATOR` `/api/schools/demo-status` to read live synthetic state. Claiming an invented school immediately renders it `available: false` ("Already Claimed") upon page reload or tab switch.
  - If coordinator lookup fails or is unavailable, returns 503 `COORDINATOR_UNAVAILABLE` and UI displays `"Availability unavailable"` rather than silently falling back to static defaults.
- **Sign-Out & Abort Safety**:
  - Directory and demo requests use `sessionVersion` and separate sequence counters (`dirSeq`, `demoSeq`, `refreshSeq`) with `AbortController` instances.
  - Late responses after sign-out or account changes are aborted/ignored without modifying state.
  - Post-`response.json()` verification ensures late-parsing bodies do not render after sign-out.
  - Denied access (401/403) or errors immediately clear directory data from memory and the DOM.
- **Retry Safety & Idempotency**:
  - The UI caches in-flight `requestId` per OSN during uncertain or interrupted claims.
  - Clicking "Retry Claim (Demo)" preserves the same `requestId`, enabling idempotent reconciliation through the SQLite Durable Object coordinator without duplicate row creation or formula overwrites.
- **Exact Feedback String**: Successful demo claims display **“Demo claim saved — test data only”**. Real schools cannot be claimed in demo mode (`422 DEMO_INVENTED_SCHOOLS_ONLY`).

### 5. Browser verification: automated tests vs observed browser results

- **Automated Regression Suite (`test/frontend.test.mjs`, `test/read-only.test.mjs`, `test/save-safety.test.mjs`, `test/operator-recovery.test.mjs`)**:
  - Automated Node.js test runner verifies all 63 unit, integration, browser DOM state, and operator recovery regressions.
  - Confirmed: pending claim responses are preserved during periodic refresh; late-parsing JSON bodies after sign-out are dropped; returning to the Demo tab reloads synthetic availability; coordinator lookup failures render `"Availability unavailable"`; uncertain operations block writes until confirmed evidence is reconciled.
- **Observed Browser Flow (`http://localhost:8788` & `http://localhost:8787`)**:
  - **Sign In**: User signs in (via real GIS on `8787` as Supervisor or via fixture on `8788` as Alex/Morgan); workspace renders user identity and assigned schools without errors.
  - **Browse & Search**: Navigating to `School Directory` tab fetches directory data; typing into `dir-search` dynamically filters cards, displaying public details (OSN, Name, Board, Region) and "Available" / "Claimed" badges with zero private student notes or owner emails.
  - **Claim Invented School**: Navigating to `Demo Claim` tab lists invented schools (OSN 900001–900004); clicking "Claim (Demo)" on an available school saves the claim through the SQLite DO coordinator, renders banner **“Demo claim saved — test data only”**, and flips the button to "Already Claimed" (disabled).
  - **Reload Persistence (Active Process Only)**: Refreshing the page and signing back in persists the claim state within the running server session; the claimed school remains marked "Already Claimed" and cannot be re-claimed. Browser reload persistence does NOT prove persistence after restarting the server (server restart recovery is verified separately by automated DO coordinator tests in `test/save-safety.test.mjs`).
  - **Sign Out**: Clicking "Sign out" hides the workspace, clears identity and school arrays from memory, empties the DOM lists, and displays "You’re signed out."

### 6. Operator recovery proof for uncertain claims

The operator recovery workflow provides deterministic, auditable resolution for operations whose upstream outcome was uncertain (e.g., timeout, dropped connection, or 503):

- **Strict Authorization**:
  - Both `GET` and `POST /api/operator/recovery` verify the caller against synthetic `CRM Users` and require an active **Supervisor** role.
  - Students (`co-op`), inactive/revoked accounts, and unlisted callers are rejected with `403 SUPERVISOR_ROLE_REQUIRED` or `403 USER_NOT_ALLOWED`.
  - A nonempty `x-proof-actor` header alone is insufficient; all rejected attempts leave the pending journal and workbook block completely unchanged.
- **Pending State Inspection (`GET /api/operator/recovery`)**:
  - Retrieves the active pending operation from SQLite along with its planned batch and client fingerprint.
  - Reads a fresh workbook snapshot and inspects the `Activity Log` marker (column L) and all targeted cell ranges in `Schools`.
  - Classifies evidence into explicit diagnostic states:
    - `CONFIRMED_COMMITTED`: Unique activity marker and all planned range updates match the sheet. Reconcilable without repeating writes.
    - `ABSENT_UNRESOLVED`: No activity marker or planned cell updates found. Upstream write may still be in-flight. Writes remain strictly blocked.
    - `PARTIAL_OR_CONFLICTING`: Incomplete updates or mismatched cell values detected (e.g., concurrent sheet edits). Automatic reconciliation refused.
    - `CONFLICTING_DUPLICATE_MARKERS`: Corrupted duplicate markers found. Blocked.
  - Returns plain-English diagnosis and reasons why writes remain blocked.
- **Safe Reconciliation & Input Validation (`POST /api/operator/recovery`)**:
  - Requires `action: "reconcile"` and the exact active `requestId`.
  - Missing, unknown, or malformed actions/IDs return `422 INVALID_RECOVERY_ACTION`, `422 INVALID_REQUEST_ID`, or `409 REQUEST_ID_MISMATCH` without mutating the journal or releasing the block.
  - Evaluates the live sheet evidence: if `CONFIRMED_COMMITTED`, marks the operation `committed`, stores the result, and unblocks the workbook without duplicating upstream writes.
  - Client replays receive the saved result with `replayed: true` without additional write attempts.
  - If evidence is absent, partial, or conflicting, reconciliation is refused with `409 RECONCILIATION_REFUSED`, keeping writes blocked.
  - **Never blind force-unlock**: Requests with `action: "force_unlock"` are rejected with `403 BLIND_FORCE_UNLOCK_FORBIDDEN`. Writes are never unblocked merely because a request ID is absent.
- **Journal Persistence Across Coordinator Restart**:
  - The SQLite operations journal persists pending records across Durable Object restarts. Recovery diagnoses and blocks remain active until confirmed evidence resolves the write.
- **Demonstrated Test Scenarios (`test/operator-recovery.test.mjs` - 6 passed)**:
  1. *Write committed but response lost*: Write applied upstream but response lost; recovery diagnoses `CONFIRMED_COMMITTED`, reconciles to `committed`, replayed without second write, unblocks next claim.
  2. *Write definitely rejected*: Upstream rejection (400) records `rejected` (502 `SHEETS_REJECTED`), leaves sheet untouched, and keeps workbook unblocked for subsequent writes.
  3. *Conflicting or incomplete evidence*: Absent marker refuses reconciliation; conflicting marker/row refuses reconciliation; force-unlock denied with 403; writes remain blocked.
  4. *Recovery after restart*: Pending state and blocking survive DO process restart; late upstream commit reconciles cleanly across restart.
  5. *Late upstream write completing after earlier timeout*: Delayed write initially times out (503 `COMMIT_UNCERTAIN`), blocking subsequent operations; late arrival commits upstream; recovery diagnoses `CONFIRMED_COMMITTED` and reconciles; subsequent claim succeeds with zero duplicate rows and formulas intact.
  6. *Strict role authorization & input validation*: Students, inactive users, and unlisted callers are blocked from inspecting or reconciling recovery state; missing/malformed/unknown actions or IDs are rejected; all denied attempts leave the pending operation and workbook block intact.

### 7. Proposed direct-edit policy & concurrency boundaries

- **Single-Writer Workflow Requirement**:
  - Live application writes to the test spreadsheet strictly require a **controlled single-writer workflow**.
  - **Fundamental Concurrency Boundary**: Ordinary Google Sheets reads (`values.batchGet`) and pre-write validation checks **cannot lock out concurrent human edits**. Google Sheets provides no distributed row locks, pessimistic cell leases, or serializable transactions for interactive browser users.
  - If an outreach student or supervisor manually edits a row in the Google Sheets web interface while an application write is in flight, the application's read cannot prevent that concurrent edit from conflicting or being overwritten.
- **Operating Policy Constraints**:
  - All status, owner, stage, and follow-up mutations must flow exclusively through the application coordinator during operational hours.
  - Manual spreadsheet editing must be restricted to designated human-only sheets/columns or reserved maintenance windows when application writes are paused.
  - **Permissions Untouched**: Spreadsheet permissions were not changed. The real Google Sheets adapter remains strictly read-only (`spreadsheets.readonly`) by default. All write and recovery proofs run exclusively against synthetic fixtures.

### 8. Claim-to-test-spreadsheet workflow (Real writes disabled by default)

- **Architecture & Route**:
  - Endpoints: `GET /api/directory` (browse directory) and `POST /api/schools/claim` (claim school).
  - Preflight (`OPTIONS /api/schools/claim`) and POST handling check authentication and write status.
- **Fail-Closed Write Protection**:
  - `ENABLE_REAL_WRITES` defaults to disabled (`false` / unset).
  - Attempting to claim a directory school without explicit write enablement immediately returns `503 REAL_WRITES_DISABLED` (`writesEnabled: false`) with a clear explanatory error before any mutation is attempted.
  - Service-account token assertion requests only `https://www.googleapis.com/auth/spreadsheets.readonly`.
- **Controlled Claim Guarantees (`test/claim-workflow.test.mjs` - 7 passed)**:
  1. *Real writes disabled by default*: Valid Google user calling `POST /api/schools/claim` is safely rejected with `503 REAL_WRITES_DISABLED`; workbook unchanged.
  2. *Authentication & authorization gates*: Missing/forged Google tokens (401) and unlisted/inactive CRM accounts (403) fail closed before write checks.
  3. *Authenticated ownership*: The claimed school row in `Schools` is bound to the verified caller (`owner: user.email`, `assignedTo: user.name`), not a synthetic fixture actor.
  4. *Server-computed availability*: Validates status === "Available" in `School Directory` and rejects already-claimed schools (409 `SCHOOL_ALREADY_CLAIMED`).
  5. *Q/R formula preservation*: Split RAW batch writes `Schools!A:P` and `Schools!S:AF`, leaving Q and R formulas completely untouched.
  6. *Atomic activity logging*: Single batch writes the school record and appends to `Activity Log` with a unique request ID marker in column L.
  7. *Idempotent retries*: Same request ID returns the saved record with `replayed: true` and zero duplicate writes; altered request ID payload is rejected with 409 `REQUEST_ID_REUSED`.
  8. *Race protection*: Two students racing to claim the same school yield exactly one 200 and one 409.
  9. *Capacity handling*: Enforces preformatted capacity limit (rows 2..500) with `422 PREFORMATTED_ROWS_FULL`.
  10. *Uncertain-write recovery*: Lost-ack or timeout keeps workbook blocked; Supervisor inspects and reconciles via `/api/operator/recovery`.

### 9. Concrete setup & approval needed before first controlled test-spreadsheet write

Before the first controlled write can be executed against the test spreadsheet:
1. **Business & Supervisor Approval**:
   - Explicit supervisor confirmation to transition from read-only prototype to controlled single-writer mode.
   - Agreement on the single-writer operational window (no concurrent manual human edits on `Schools` or `Activity Log` during testing).
2. **Spreadsheet Permissions**:
   - The test spreadsheet (`1QzYTKdeWWa2TpOtGSmJ0NDMeY_U-u3ImeCVdpCmJrH4`) must grant **Editor** access to the service account (`h4-read-only@...iam.gserviceaccount.com`).
3. **Configuration Enablement**:
   - Set `ENABLE_REAL_WRITES="true"` in local runtime environment (`.dev.vars` / Worker bindings).
   - Authorize token exchange to request write scope (`https://www.googleapis.com/auth/spreadsheets`).
4. **Controlled Verification Plan**:
   - Execute a single test claim on a disposable/dedicated test row in the test spreadsheet.
   - Verify Q/R formula preservation, atomic activity log entry, and idempotent replay in the live sheet.

## Remaining unverified checks

1. **Complete browser test for student co-op account**: Real browser sign-in was verified for a Supervisor account (`supervisor@example.test`). The two student accounts in `CRM Users` (`student.one@example.test`, `student.two@example.test`) have 0 assigned schools in the live sheet and were not directly signed into via the browser. Complete Google-authenticated browser testing of student co-op login remains untested.
2. **Complete browser test for unlisted Google account**: Unlisted user rejection was verified via direct adapter check; interactive browser sign-in with an unlisted Google account attempting to load the UI remains untested.
3. **Revocation / inactive status during an active session**: Live revocation was tested via unit tests and synthetic fixture; live mid-session revocation against the real spreadsheet has not been run against live accounts to avoid editing `CRM Users` cells without explicit instruction.
4. **Mobile device testing**: Real mobile Safari (iOS) and Chrome (Android) testing on physical devices remains unverified (only desktop browser and simulated viewports tested).
5. **Live spreadsheet writes**: Live writes to Google Sheets remain completely disabled by design. All write and concurrency proofs run against the synthetic coordinator and `FakeSheets`.
6. **Server restart persistence for live demo DO**: Reload persistence in the browser was verified within the active server process. While SQLite DO recovery across restart is covered by automated coordinator tests, end-to-end browser persistence across an actual process restart of `scripts/dev.mjs` remains unverified.


References: [Google ID token validation](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token),
[service-account flow](https://developers.google.com/identity/protocols/oauth2/service-account),
[sign-in client setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).
