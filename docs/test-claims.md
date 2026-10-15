# Local test-sheet claims

The user authorized enabling test-sheet claims on 2026-10-15. Production, push and
deployment remain out of scope. This supersedes older read-only milestone notes.

`npm run dev` now binds a real `TestSheetCoordinator` with a persistent SQLite
journal in ignored `.wrangler/local-coordinator`. It uses Google service-account
authentication and the pinned test spreadsheet. The local server has no FakeSheets
binding; synthetic demos remain available through the separate browser fixture.

The Google adapter requests the spreadsheets write scope, reads all existing claims,
validates the workbook headers (including verified directory aliases), and sends one
RAW batch containing Schools A:P, Schools S:AF and one Activity Log row. Q/R are
never in a write range. Existing identity, ownership, duplicate, retry and uncertain
write protection remain in use. Claim responses omit notes. Supervisor recovery is
available at `/api/operator/recovery` through verified Google sign-in.

Local `.dev.vars` enables claims; the checked-in example defaults to disabled.
The service-account JSON remains outside the repository. The user explicitly
approved Editor access and applied it to the test spreadsheet for
`h4-crm-read-only@h4-crm-prototype.iam.gserviceaccount.com`. A real browser claim of
St Columba Catholic School succeeded under the signed-in Supervisor account.
Readback confirmed one new school row and one matching activity, with Q/R unchanged.
The journal records only Schools!A3:P3, Schools!S3:AF3 and Activity Log!A4:O4.
Request ID: `7ff2d900-c597-40bf-9d63-22ef095f3fec`.

Sign in at http://localhost:8787, open School Directory,
and click Claim school. The school should appear under My Schools after confirmation.
While using app claims, avoid sorting, inserting, deleting or editing Schools and
Activity Log directly in Google Sheets. The coordinator serializes app requests;
it cannot lock out direct human spreadsheet edits.

Verification: all 72 automated tests passed, including two new mocked-Google adapter
tests for the actual HTTP write path, header aliases, atomic split batch, Q/R,
idempotent replay, role-gated recovery and duplicate checks beyond row 500.
TypeScript checking passed. A real read using the write adapter recognized the
workbook schema and all 1,563 directory schools. The subsequent real browser save
used Google sign-in and actual Google Sheets; automated tests use synthetic tokens.
A targeted frontend regression also checks that a definite permission rejection
discards the failed request ID so the user can retry after fixing access. Unknown
write outcomes retain their request ID.

## School editing

School cards now open a native dialog with contact name/role, email, phone, stage,
priority, outreach goal, follow-up due, next action and notes. The user requested
editing after confirming claims. Details are fetched only when opening a card;
the API checks Google identity and current CRM membership. Students can fetch and
update only owned records; Supervisors can edit all. Activity history is not exposed.

Updates use the same persistent coordinator and atomic three-range batch as claims.
The form sends only changed fields with the loaded version. Stale saves are rejected,
drafts remain in page memory, and uncertain saves reuse their original request ID.
Closing/reopening an unchanged form loads fresh server data; an older unsaved draft
cannot silently overwrite a newer saved version. Drafts clear on sign-out. The Cold
rule applies in both the form and the update API.

Real browser verification: opened St Columba, changed priority from blank to Medium,
and received Saved to the test spreadsheet. Readback verified Medium, a new version,
exactly one matching Updated activity and unchanged Q/R formulas. No dummy notes or
contacts were added. Screenshot: ../h4-editor-save-success.jpg (workspace output).

Checks: full 75-test suite passed after adding two editor API tests. A subsequent
draft-reopen regression passed with the complete five-test frontend file. TypeScript
and JS syntax checks passed. Real student sign-in and physical-device testing remain
outside this increment. Production is untouched; no push or deployment.

## Save feedback

The Save button now immediately changes to Saving. A confirmed update closes the
dialog and shows a five-second Saved tag. Clicking Save without changing values
also closes the dialog and shows No changes to save. Errors, uncertain outcomes,
and form-validation messages appear beside the button in the sticky footer; failed
saves keep the draft open and uncertain retries retain their request ID. Validation
is handled explicitly so browser validation cannot silently block the submit handler.
Seven focused frontend checks passed, including delayed success, uncertain retry,
visible validation and unchanged-form feedback. No backend write behavior changed.
