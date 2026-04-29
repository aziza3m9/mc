# Application Dashboard

Standalone job application tracker with clock in/out and status tracking
(Applied / Interview Request / Assessment / Offer / Rejected).

This folder is **completely independent** from anything else in the repo.
No shared files, no shared dependencies, no shared storage.

## How to run

Just open `index.html` in any modern browser:

- **Double-click** `application-dashboard/index.html`, **or**
- In your browser: `File → Open File…` → pick `application-dashboard/index.html`

The URL bar should look like:
`file:///.../application-dashboard/index.html`

That's it. No server, no install, no build step.

## Data

Everything is saved in your browser's `localStorage` under the key
`application-dashboard-v1`. Use the **Export JSON** button regularly to back up.

## Hosting on GitHub Pages (optional)

If you'd rather open it from a URL:

1. Push this branch to GitHub.
2. Repo → Settings → Pages → set Branch to `claude/dashboard-clock-tracking-Wd1xA` and folder to `/ (root)`.
3. Visit `https://<your-username>.github.io/<repo>/application-dashboard/`.
