# Team dashboard

Requested and approved October 16, 2026: all active CRM members can see the team's
claimed schools and outreach progress. This supersedes earlier milestone rules
that hid other students' assignment summaries. Private school details and editing
remain restricted to the owner and supervisors.

`GET /api/dashboard` verifies Google identity and fresh CRM Users membership before
reading selected Schools columns. Its explicit response includes school ID/name,
board, region, assigned display name, stage, priority, last-contact and follow-up
dates, and a server-computed `canEdit` flag. Owner emails, contacts, notes, social
handles and activity messages are never returned. No spreadsheet writes were added.

Team dashboard is a separate tab for students and supervisors. The pipeline shows
current stages, rather than cumulative conversion totals. Claimed schools whose
stage is Not Contacted appear as “Claimed / not contacted”; claiming is not a new
spreadsheet stage. Blank or unfamiliar stages remain visible under Other / not set.
All pipeline counts add up to total claimed schools. Unclaimed directory schools
remain in Browse directory.

Filters combine stage, assigned display name, school/board/region search and overdue
follow-ups. Overdue means a valid ISO due date before today in America/Toronto;
Booked and Cold schools are excluded. Non-ISO dates stay visible without guessing
their interpretation. Assignment groups use sheet display names, so supervisors
should keep student display names distinct.

Progress refreshes on demand and through the existing one-minute refresh when the
page is visible. Saves and claims invalidate the dashboard cache. Failed reads
hide stale results; sign-out/revocation clear team data and ignore late responses.
The dashboard displays on-screen metrics, rather than editing the Sheet Dashboard tab.
