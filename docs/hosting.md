# Hosted test CRM

The user requested a stable GitHub Pages test link on October 15, 2026.
This supersedes the earlier local-only deployment restriction for this prototype.
Production remains out of scope.

- Screen: https://geng-geng8.github.io/h4-outreach-crm-prototype/
- API: https://h4-outreach-crm-prototype-api.glen-004.workers.dev
- Data: the existing dedicated test workbook only.
- Keys: Cloudflare Worker secrets; the public repository and Pages artifact contain none.

## Deployment verification (October 15, 2026)

GitHub Pages published successfully; its real browser screen loads the Cloudflare
configuration and Google button. The deployed API reports credentials configured
and writes enabled. Hosted POST preflight succeeds for the Pages origin (204);
unauthenticated bootstrap returns 401 and a different origin returns 403.
TypeScript checks and all 78 existing tests passed; the additional Pages API-origin
test passed with the eight frontend tests. The Pages artifact contains only the
allowlisted static files. Local writes were disabled and its server stopped.

Hosted Google-authenticated reads and saves still require the Google OAuth origin
setting and a browser acceptance check. Local live-sheet save evidence is recorded
separately in `test-claims.md`; it is not proof of a hosted save.

The public publishing history starts with a sanitized snapshot. Earlier local
development history remains on `codex/save-safety-proof`; use the dedicated
`codex/hosted-prototype` branch for continuing work against published `main`.

## First deployment

1. `npx wrangler login`, then `npx wrangler deploy` on the existing free Workers plan.
2. `node scripts/upload-worker-secrets.mjs` reads the key from the outside-repository
   path in ignored `.dev.vars` and sends the two secrets directly over stdin.
3. Set the GitHub repository variable `H4_API_ORIGIN` to the deployed HTTPS Worker
   origin, without a trailing slash. Enable Pages with GitHub Actions as its source.
4. Add `https://geng-geng8.github.io` to the OAuth web client's **Authorized JavaScript origins**.
   Do not add the repository path or remove the existing localhost origins.
5. Publish the sanitized prototype source on `main`. The Pages workflow uploads
   only the four allowlisted static files plus `.nojekyll`.

Use the hosted API as the only writer. Before enabling the hosted deployment,
stop the local write server and set local `ENABLE_REAL_WRITES="false"`.
The local and hosted coordinators have separate journals and must not write to
the same spreadsheet concurrently. Avoid direct Sheet sorting/row edits while saving.

## Later releases

Pages builds use content-versioned JavaScript/CSS filenames so new HTML loads its
matching release. Base filenames remain for previously cached HTML. Optional header
UI must never block sign-in when missing in an older page. The connection badge
reports app-server reachability, updates on API requests and browser online/offline
events, and checks visible signed-out pages once per minute. Its offline pulse
respects reduced-motion preferences. Online does not mean an unsaved form is saved.

Frontend changes on `main` publish automatically. API changes require
`npx wrangler deploy` from a signed-in development machine; credentials are not
copied into GitHub Actions. `npm run check` and `npm test` verify the prototype
before release. Hosted sign-in and saving require a separate browser check.

To pause writes, change `ENABLE_REAL_WRITES` to `"false"` in `wrangler.toml`
and deploy the API. The screen remains available for sign-in and summary browsing.
