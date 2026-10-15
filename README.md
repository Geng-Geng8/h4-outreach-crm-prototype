# H4 Outreach CRM prototype

**Current local build:** real test-sheet claiming and school editing work. Click a
card under My schools to edit contact details, stage, follow-up and notes. See
[test claims](docs/test-claims.md). User-authorized writes are enabled in ignored
local configuration; the user granted Editor access and a real Google-authenticated
test claim succeeded. The historical read-only/synthetic milestones below
remain useful context. The hosted test screen is available at
https://geng-geng8.github.io/h4-outreach-crm-prototype/ with a Cloudflare API.
See [hosting setup](docs/hosting.md) for deployment details.

Google-authenticated H4 school outreach with test-sheet claiming and editing.
The SQLite-backed coordinator serializes saves and preserves retry safety.

## Open the preview

Install Node.js 24 or newer and run these commands from this repository:

```powershell
npm ci
npm run check
npm test
npm run dev
```

Open **http://localhost:8787**. Before Google is configured, the screen explains
that setup is needed. Writes require the explicit write flag and server-verified
CRM membership. Keep local writes disabled once the hosted API becomes the writer.

## Google setup: start here

Follow [docs/google-setup.md](docs/google-setup.md), one step at a time. The first
step is to create/select a dedicated test project in Google Cloud. No private key
is needed for that first step. The existing Drive connector is not an application
credential source; the server needs its own read-only connection.

Later, local config contains only a public OAuth client ID and a path to a
service-account JSON file **outside this repository**. The dev runner reads that
file into memory. Do not paste private keys into chat, use them as command-line
arguments, place them in source, or commit them.

## What users can see

- Active, listed Google users only; identity and role checked on the server.
- Student co-op users: their own assigned school summaries only.
- Supervisors: all school summaries in the test workbook.
- Fields: ID, school name, board, region, stage, priority, assigned display name.
- Details and notes: students can open their own records; supervisors can open
  all records. Summary and directory endpoints omit private details.
- User lists, social handles and activity history are not exposed in this screen.

This is a conservative interim policy. Broader student access and private-history
visibility remain undecided. Legacy blank Active cells retain the original active
behavior; FALSE/NO/REMOVED/unknown statuses are denied. See
[docs/read-only-milestone.md](docs/read-only-milestone.md) for details and evidence.

The app keeps the ID token and summaries only in page memory. Sign-out, expired
login and failed authorization clear records. It refreshes visible pages periodically
and on returning to the tab. No offline record cache or automatic demo fallback exists.

## Source map

| Location | Purpose |
| --- | --- |
| `src/read-only.ts` | App entry; read-only API, CORS, public config, static assets |
| `src/google-auth.ts` | Google RS256 signature/identity checks using jose |
| `src/google-sheets-read.ts` | Read-only service-account exchange and limited Sheets reads |
| `public/` | Mobile-first sign-in, summaries, search and sign-out |
| `scripts/` | Local server and outside-repository credential loading |
| `src/index.ts`, `src/sheets.ts` | Earlier synthetic coordinator; excluded from read-only bundle |
| `src/schema.ts` | Original schema and validation helpers |
| `test/save-safety.test.mjs` | Unchanged 25-case SQLite write proof |
| `test/read-only.test.mjs` | Signed-token, authorization, privacy and API tests |
| `test/frontend.test.mjs` | Frontend browser-state regressions (refresh, delayed responses, demo tab) |
| `test/operator-recovery.test.mjs` | Operator recovery proof for uncertain claims (6 scenarios) |
| `test/claim-workflow.test.mjs` | Claim-to-test-spreadsheet workflow proof with disabled-by-default write check |
| `test/browser-fixture.mjs` | Explicit synthetic browser test only |
| `docs/implementation-plan.md` | Consolidated specification and business decisions |
| `docs/verification.md` | Historical save-proof verification report |
| `docs/read-only-milestone.md` | Current implementation and verification report |

## Tests and limits

`npm test` uses Miniflare/workerd, invented records and temporary signing keys. It
never calls real Google endpoints. The write proof uses a real local SQLite DO;
the read-only API has no write coordinator binding. Tests need localhost connections,
so a restricted shell may need permission for loopback networking.

For manual synthetic UI testing, run `node test/browser-fixture.mjs` and open
http://localhost:8788. Its banner and fixture sign-in buttons distinguish it from
real sign-in. It substitutes a local GIS stub in memory, with actual server-side
JWT checks against mocked Google keys. No real accounts/records are used. This
fixture is not served by `npm run dev` or included in `public/`.

Real OAuth consent, the real Google popup, service-account access and credentialed
end-to-end reads remain unverified until Google setup is complete. Viewport checks
are not real iPhone/Safari testing. No live formulas, dropdowns or rows were modified.
The user deferred the full workbook audit.

## Dependencies and operating boundaries

The app uses pinned `jose` for JWT verification/signing instead of bespoke validation.
Development tools and resolved versions are in the lockfile. Scoped Miniflare
overrides pin patched `undici` 7.29.1 and `sharp` 0.35.5; retain passing runtime tests
when changing them. This app does not process images. Audit results are in the report.

The synthetic coordinator still blocks further writes when an external outcome is
uncertain. Its operator recovery workflow and direct-Sheet-edit policy remain
prerequisites to future real writes. This read-only phase does not connect it to
Google or the real workbook.
