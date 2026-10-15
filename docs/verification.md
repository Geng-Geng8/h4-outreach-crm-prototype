# Local verification report

Date: 2026-10-15 (America/Toronto).

## Result

The local save-safety milestone passes: **25 tests passed, 0 failed**.
The final suite took approximately 6.54 seconds on this machine. TypeScript
checking also passed. This is evidence for a local synthetic prototype, not
production readiness or a live Google Sheets integration test.

Repository: `Geng-Geng8/h4-outreach-crm-prototype`.
Local branch: `codex/save-safety-proof`.
Baseline: `aa9ab78` (`Initial commit`).
Changes are local and uncommitted. No push, deployment, live spreadsheet write,
production repository access, or production migration was performed.

## What actually ran

- Node.js `v24.19.0`, npm `11.17.0`, Windows.
- `npm run check`: passed (`tsc --noEmit`).
- `npm test`: passed all 25 Node test-runner cases.
- Miniflare `4.20260730.0` using local workerd and a real SQLite-backed Durable
  Object (`useSQLite: true`), compatibility date `2026-07-01`.
- An in-process, synthetic-only Sheets contract fake. It introduces async latency,
  validates split-range batch shape, and uses copy-on-write for atomic acceptance.
- Restart tests dispose/recreate the runtime and reopen the same temporary
  on-disk SQLite store; the fake workbook remains in the host process.
- External Worker fetches are rejected by the harness. The actual test Sheet ID
  is not configured as a runnable target. All identities/school records are fake.
- The restricted shell initially blocked localhost connections. The passing run
  used approved loopback access; it did not require Google/Cloudflare credentials.

## Coverage

| Scenario | Observed local result |
| --- | --- |
| Concurrent claims for different schools | Distinct safe rows, two records/logs; partial row untouched |
| Concurrent claims for one school | One success, one 409, one new record/log |
| Ten competing claims | One success, nine conflicts, one write batch |
| Two edits with the same version | One success; loser receives 409 plus saved server record |
| Concurrent follow-up increments | No lost increment; stale event rejected without logging |
| Identical simultaneous retries | One write/activity, repeated result recognized |
| Retry after newer edit and runtime restart | Original result replayed; newer Sheet state unchanged |
| Reused ID with different payload or actor | 409; no second mutation |
| School/activity write shape | One RAW batch containing exactly 16+14+15 cells |
| Q/R preservation | Existing formula strings unchanged on claim and activity save |
| Definite rejected batch | Neither school nor activity changed; later new work allowed |
| Ambiguous acknowledgement after commit | Exact committed batch recognized, no second write |
| Delayed commit and restart | New writes blocked; original retry confirms late commit and releases block |
| No observable commit | Remains uncertain and blocked after restart; never blindly resent |
| Ownership/revocation | Unauthorized/revoked actors denied, including old result replays |
| Supervisor edit | Allowed for a student-owned record |
| Header drift/duplicate stored IDs | Fail closed before writing |
| RAW text | Leading formula-like text transmitted literally, without added apostrophe |
| Forged owner field | Rejected |
| Cold guard/date validation | Warm/count/deadline violations and invalid dates rejected |
| Preformatted capacity exhausted | Explicit failure; no append beyond row 500 |
| Partial record with matching school name | Duplicate claim rejected even without record ID |
| Record moved before request | Current row found by record ID |
| Disabled proof/other Sheet ID | Mutation refused |

The atomicity test establishes that our code submits one correctly shaped request
and handles the fake's documented atomic success/rejection contract. It does not
independently establish how Google, real formula recalculation, protections,
strict dropdown validations, or a real network timeout behaves.

## Limits and required follow-up

1. **No real Google authentication or Sheet adapter.** The proof accepts a fixture
   identity header only inside its explicit synthetic environment; it must not be
   treated as a deployable authentication system.
2. **No live spreadsheet inspection.** Headers, date cell types, formulas, protected
   ranges, grid capacity, validation rules and directory count remain unverified.
3. **No cross-system transaction.** The journal and workbook are independent. An
   unresolved write deliberately blocks the workbook. Operator recovery when no
   marker ever appears must be designed/tested before a real-user release.
4. **No direct-editor race protection.** All application writers must use the same
   coordinator. An editor sorting/changing rows concurrently in Sheets can bypass
   it. Moving rows before a fresh read was tested; concurrent direct sorting was not.
5. **No full CRM or UI.** Bootstrap/user administration, Google login, CORS browser
   flow, quota management, live date conversion, Gmail compose, draft recovery,
   device testing, deployment and rollback remain future milestones.
6. **Provisional rules.** Follow-up meaning/count resets/caps, stage transitions,
   student read visibility and other decisions are listed in implementation-plan.md.
7. **No broad performance claim.** The ten-request fixture race passed, but real
   Sheets latency, runtime CPU/time bounds, quotas and classroom usage are unmeasured.

## Setup you need now

Nothing else is required to review or rerun this local proof on this machine.
For another computer, install Node.js 24 or newer, then run `npm ci`,
`npm run check`, and `npm test` from the repository folder. Allow the local runtime's
localhost connections if the shell sandbox blocks them.

For the next integration milestone, first settle the business-rule decisions,
then arrange a Google OAuth web client and dedicated test-only service account,
enable Sheets API, and share only the test workbook with that account. Keep keys
outside Git. The real adapter and operator recovery must be implemented before
credentialed end-to-end testing; credentials alone cannot turn this proof live.

The development dependency audit reported zero known vulnerabilities after applying
the scoped patched-version overrides documented in README.md. Package versions and
the lockfile are pinned; this point-in-time audit does not replace later checks.
