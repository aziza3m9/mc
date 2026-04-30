# Gmail Sync — One-Time Setup

The Gmail Sync feature reads your inbox to auto-detect application,
interview, assessment, offer, and rejection emails. It runs entirely in
your browser — your access token never leaves your device.

To make this work, you need to create a free Google Cloud OAuth Client
ID and paste it into the dashboard. This takes about 5 minutes.

---

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com>.
2. In the top bar, click the project dropdown → **New Project**.
3. Name it something like **"Application Dashboard"** and click **Create**.
4. Once created, make sure it's the active project (top bar).

## 2. Enable the Gmail API

1. In the search bar, type **Gmail API** and open it.
2. Click **Enable**.

## 3. Configure the OAuth consent screen

1. In the sidebar: **APIs & Services → OAuth consent screen**.
2. User Type: **External** → Create.
3. Fill in:
   - App name: `Application Dashboard`
   - User support email: your email
   - Developer contact: your email
4. **Scopes** — click **Add or Remove Scopes**, search for
   `https://www.googleapis.com/auth/gmail.readonly`, check it, click
   **Update**, then **Save and Continue**.
5. **Test users** — click **Add Users** and add your own Gmail address.
   (You can add up to 100 test users; only those users can sign in.)
6. **Save and Continue** through the rest. You can skip the demo video
   and CASA assessment as long as the app stays in **Testing** mode.

## 4. Create the OAuth Client ID

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Name: `Application Dashboard – Web`.
4. **Authorized JavaScript origins** — add the origin you'll open the
   dashboard from. For GitHub Pages this is:
   ```
   https://aziza3m9.github.io
   ```
   You can also add `http://localhost:8000` if you want to try it from
   a local server. **`file://` URLs are not supported** by Google for
   OAuth — you need to host the dashboard at an `http://` or
   `https://` origin.
5. **Authorized redirect URIs** — leave empty. (We use the implicit
   token flow, no redirect needed.)
6. Click **Create**. Copy the **Client ID** — it looks like
   `123456789-abc123.apps.googleusercontent.com`.

## 5. Paste it into the dashboard

1. Open the dashboard (must be from one of the authorized origins).
2. Click **Gmail Sync** in the left nav.
3. Paste the Client ID into the field.
4. Click **Sign in with Google**.
5. You'll see a warning that the app is **unverified** — click
   **Advanced → Go to Application Dashboard (unsafe)**. This warning
   exists because the app hasn't been through Google's verification
   process. For your personal use this is fine; the app only runs in
   your own browser.
6. Approve the **Read your email** permission.

---

## Using it

1. Pick a time window (default: last 90 days).
2. Click **Scan Inbox**. The app will fetch up to 200 emails matching
   keywords like *"thank you for applying"*, *"interview"*,
   *"unfortunately"*, *"offer"*, etc.
3. Each thread is grouped, classified (status + source + company +
   role), and shown in a review list.
4. By default only **new** items (and status upgrades on existing
   imports) are pre-selected.
5. Click **Apply N selected** to import.

Re-running a scan won't create duplicates — each Gmail thread is
linked to one application via its thread ID. If a later email upgrades
the status (e.g., Applied → Interview → Offer), the existing
application is updated in place.

### Auto-scan on dashboard open

Once you've signed in once, you can tick **"Auto-scan when I open the
dashboard"** in the Setup panel. From then on, every time you load the
dashboard the app will silently re-issue a token (no popup, as long as
you're still signed into Google in that browser) and scan in the
background. Findings appear with a count badge on the **Gmail Sync**
nav link, ready for you to review. The auto-scan has a 5-minute
cooldown so navigating around won't spam Gmail.

This is **page-load** sync, not background sync — your laptop has to
be on and the dashboard tab has to load. For true background sync
(runs while you're not using the computer), you'd need a server-side
component, e.g. Google Apps Script on a time trigger.

## Privacy

- Your access token is held in JS memory only. It's never written to
  disk or sent to any server.
- The Client ID is saved in `localStorage` for convenience, but it's
  not a secret on its own — it's a public identifier.
- Your imported thread IDs are stored in `localStorage` so duplicate
  detection works across sessions.
- To revoke access at any time: dashboard's **Sign out** button, or
  go to <https://myaccount.google.com/permissions>.

## Troubleshooting

- **"redirect_uri_mismatch" / "origin_mismatch"** — the page you're
  on isn't in the **Authorized JavaScript origins** list. Open the
  page from one of the allowed origins, or add the current origin to
  the list in Google Cloud Console.
- **"unverified app" warning** — expected. Click Advanced → Go to.
- **"access_denied"** — you weren't added as a test user. Add your
  Gmail address under **OAuth consent screen → Test users**.
- **"Could not load Google API"** — your browser blocked the
  `apis.google.com` or `accounts.google.com` script. Disable the
  blocker on this page and refresh.
