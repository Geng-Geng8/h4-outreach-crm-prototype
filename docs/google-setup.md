# Google setup: one step at a time

The code is ready for local testing. Real Google sign-in and workbook reads need
your Google configuration. Do the current step, then return for the next.

## Current step: select a test Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Open the project selector at the top.
3. Select a dedicated H4 prototype/test project if one exists, or create one named
   **H4 CRM Prototype**.
4. Select that project and return to this chat when it is ready.

This project is a container for Google sign-in and the read-only service account.
You do not need to create a private key or enable billing for this step. Production
credentials remain unchanged.

## Later steps (reference; we will walk through them in order)

### Enable Google Sheets API

Enable **Google Sheets API** in the selected test project. Drive API and domain-wide
delegation are not needed: the adapter reads the known workbook through Sheets API.

### Create the sign-in client

Configure Google Auth Platform branding/audience for **H4 CRM Prototype**. The current
allowlist includes Gmail accounts, so an internal-Workspace-only client would not
cover all intended testers. Keep the test configuration and add your own account
as a tester if Google asks for test users.

Create an OAuth client of type **Web application** with these Authorized JavaScript
origins exactly:

```text
http://localhost
http://localhost:8787
```

The app uses the GIS JavaScript popup callback, so it does not need a redirect
receiver URL. Do not choose Desktop type or put a client secret in the browser.
Authentication needs standard identity scopes, not the user's Drive/Sheets access.
See [Google client/origin setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

The **Client ID** ending in `.apps.googleusercontent.com` is public configuration.
The service-account private key is not.

### Create the read-only service account

Create a dedicated account, for example **h4-crm-read-only**. It needs no project-wide
IAM role to read a workbook explicitly shared with its email. Do not enable
domain-wide delegation or give broad Drive access.

Share ONLY the test spreadsheet with its service-account email as **Viewer**:

`1QzYTKdeWWa2TpOtGSmJ0NDMeY_U-u3ImeCVdpCmJrH4`

Do not publish the workbook or share it with students. The server requests only
`https://www.googleapis.com/auth/spreadsheets.readonly`; the Viewer grant supplies
a second restriction. [Google service-account guidance](https://developers.google.com/identity/protocols/oauth2/service-account).

### Keep the JSON key outside the repository

When we reach this step, download its JSON key directly from Google into a private
local folder outside this repository, for example:

```text
C:/Users/your-name/Documents/H4-secrets/h4-read-only-key.json
```

Never upload that JSON to chat, copy the private-key contents, commit it or put it
in `public/`. The local runner refuses paths inside the repository, including links
resolving inside it. If an organization policy prohibits JSON keys, report that
restriction without bypassing it; a different credential method would be needed.

### Connect the local configuration

Copy `.dev.vars.example` to `.dev.vars` in the repository. Edit only these settings;
the examples contain no private key:

```dotenv
GOOGLE_CLIENT_ID="your-public-web-client-id.apps.googleusercontent.com"
GOOGLE_APPLICATION_CREDENTIALS="C:/Users/your-name/Documents/H4-secrets/h4-read-only-key.json"
```

Use your actual client ID. The runner reads email/key from the JSON into runtime
memory; it never writes the key into source or the browser. `.dev.vars` is ignored
by Git. The runner fixes the test Sheet ID and localhost origin; changing local
environment configuration cannot target production.

Run `npm run dev`, then open http://localhost:8787. Restart after configuration
changes. Sign in with an active account already in CRM Users. The screen will show
your identity and authorized school summaries, with no editing controls.

If Google rejects an embedded-browser sign-in, open the same localhost URL in your
normal Chrome/Edge browser. Do not weaken Google's restrictions or transfer tokens
between browsers.

### Read-only acceptance check

- Active listed accounts see the expected summaries; inactive/unlisted users are denied.
- Students see only matching Owner Email rows; Supervisors see all summaries.
- Private fields/history remain excluded for both roles.
- Refresh after revocation clears previously displayed schools.
- No school/log/user write endpoint is available and no activity entry is appended.
- Sign-out clears page identity/records; reload requires signing in again.

Do not edit users/records just to test this unless that separate test edit is
authorized. Existing suitable accounts can be used. This guide does not authorize
deployment, production migration or live spreadsheet writes.
