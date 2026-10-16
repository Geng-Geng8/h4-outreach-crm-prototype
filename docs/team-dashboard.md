# Role-based dashboards

One application, existing Google authentication, and the dedicated test workbook.
No schema changes, new dependencies, or changes to the save coordinator.

## Views and data

- **My Outreach:** student landing page. Own school totals, due/overdue follow-ups,
  Interested/Engaged schools, bookings and priority action cards. Cards show the
  actual Next Action, or a clearly marked suggestion when none is recorded.
  Log outreach, contact info and reminder buttons reuse the current editor.
  A reminder is a saved Follow-Up Due date, not a notification service.
- **H4 Overview:** supervisor landing page. Whole-program metrics, current-stage
  pipeline, individual student breakdowns, student drill-down and attention cards.
  Zero-assignment students remain visible; inactive owners are flagged. Accounts
  are joined by a stable server-generated ID derived from email, not display name.
- **Team Progress:** authenticated shared school list with assignee, stage,
  last contact and next follow-up. Filter by school/board/region, member, stage
  and overdue follow-ups. No student performance cards or student roster.
- **My Schools / Schools** and **Find School** retain existing workflows.

`GET /api/bootstrap` still verifies Google identity and fresh CRM membership,
then reads school data in one batch. It now includes role-scoped Next Action and
follow-up dates. A supervisor's batch also reads CRM Users for the overview roster;
only supervisors receive the `overview`, `studentId` and `assignmentIssue` fields.
Students receive their own school records only.

`GET /api/dashboard` retains the limited shared projection and never reads Next
Action, notes, contacts or activities. `GET /api/dashboard?view=overview` requires
Supervisor before any school read. Both entry points enforce the same server role
policy. Team visibility does not grant access to another owner's detail/edit APIs.
No contacts, owner emails, phones, social handles, notes or activity messages are
included in dashboard responses. The existing detail API remains owner/supervisor.

## Metric definitions

- Claimed/assigned: school rows with a record ID.
- Schools contacted: school records with a nonblank Last Contacted date. Never
  inferred from stage, and never presented as a number of outreach events.
- Interested/Engaged and Booked: counts of school records in those exact stages.
  A booked school is not a count of individual workshops.
- Pipeline: current mutually exclusive stages, including an Other / not set bucket.
  “Claimed / not contacted” labels Not Contacted; it is not a new spreadsheet stage.
- Today/overdue: valid ISO dates compared with the America/Toronto calendar.
  Booked/Cold schools are excluded from follow-up queues. Other date formats remain
  visible without guessing their interpretation.
- Supervisor attention: inactive/missing/unlisted owners, overdue follow-ups,
  missing next actions on active schools, or missing/invalid follow-up dates on
  Contacted/Interested/Engaged schools. This is a support queue, not an activity score.

## Loading, privacy and refresh

No extra API call is needed for either role's landing page. Team data loads lazily.
The existing minute/visibility refresh and confirmed saves update the home view and
invalidate shared data. Filter predicates follow fresh assignments after refresh.
Sign-out/revocation clear dashboard data, and session/sequence checks ignore late
responses. Downgrades remove overview data. A temporary bootstrap failure keeps the
current workspace and unsaved draft, with a visible warning that records are stale.
An initial failed read exposes no records and offers a retry. Shared dashboard
read failures continue to hide that view's content.

Browser reloads use a tab-scoped navigation hint to attempt Google automatic
sign-in / One Tap, then fetch freshly authorized records before showing the
workspace. Only the selected tab name is stored in sessionStorage; credentials,
accounts, records and drafts remain in memory. Explicit sign-out removes the hint,
cancels One Tap and disables Google auto-selection. Browser privacy settings or
Google cooldown may require confirmation using the normal sign-in button. This
does not promise silent sign-in in every browser, and unsaved drafts do not survive
a full browser reload. Real token expiry and revoked membership still require login.

## Verification and release

Automated tests use synthetic Google identities and Sheets fixtures. Manual browser
verification uses `test/browser-fixture.mjs` and never real accounts or live writes.
Viewport tests do not establish physical iOS Safari or Android Chrome compatibility.

This change is prepared for PR review only. Do not deploy it as part of this task.
For an eventual approved release, deploy the Worker API before merging: the existing
main-branch GitHub Pages workflow publishes static files automatically on merge.
