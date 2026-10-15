# Log outreach

Each claimed-school card has a Log outreach button. Students can log only their
own schools; supervisors can log any school. The API verifies Google identity,
active CRM membership and current ownership before the single coordinator saves.

The form captures channel (Email, Phone, Social, Meeting), contact type,
required outcome and summary, stage, follow-up date and next action. Not Contacted
defaults to Contacted for a new log; other stages stay as saved. The server applies
the existing Cold rule. Logging records a user's report of an actual contact;
the app does not send email or infer delivery.

One RAW split-range batch writes the school and its activity row together.
Last Contacted uses the server's Toronto date. Only explicit Follow-up events
increment Follow-Up Count, once per saved request. Other outreach does not change
or reset the count. Minimum spacing, future reset policies and reassignment remain
outside this feature. The activity summary stays in Activity Log and never replaces
school Notes / Reply. No history-list endpoint or broader visibility is added.

Save outreach locks against double taps, closes the form and shows
"✓ Outreach saved" only after server confirmation. Uncertain requests keep the
same payload and retry ID, including after closing/reopening the form in that page.
Conflicts keep the message; reloading gets the latest school values for review.
Drafts stay in page memory and are cleared on sign-out; reload/tab closure can lose
unsaved text.

Verification: TypeScript and all 82 automated tests passed. Added coverage checks
ownership/revocation, required fields, atomic writes, Q/R and existing-note
preservation, counter behavior, retries, stale versions, double taps and sign-out.
A synthetic browser test saved an invented Phone/Follow-up event, closed the
dialog and displayed the success tag. These tests use mocked Google services;
they did not add a fake outreach event to a real school's test-sheet history.
