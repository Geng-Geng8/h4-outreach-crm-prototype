# Hosted test CRM

The user requested a stable GitHub Pages test link on October 15, 2026.
This supersedes the earlier local-only deployment restriction for this prototype.
Production remains out of scope.

- Screen: https://geng-geng8.github.io/h4-outreach-crm-prototype/
- API: https://h4-outreach-crm-prototype-api.glen-004.workers.dev
- Data: the existing dedicated test workbook only.
- Keys: Cloudflare Worker secrets; the public repository and Pages artifact contain none.

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

Frontend changes on `main` publish automatically. API changes require
`npx wrangler deploy` from a signed-in development machine; credentials are not
copied into GitHub Actions. `npm run check` and `npm test` verify the prototype
before release. Hosted sign-in and saving require a separate browser check.

To pause writes, change `ENABLE_REAL_WRITES` to `"false"` in `wrangler.toml`
and deploy the API. The screen remains available for sign-in and summary browsing.
