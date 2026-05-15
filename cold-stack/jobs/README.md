# jobs

Job-application autopilot. Pulls SDR/BDR roles from public ATS APIs
(Greenhouse, Lever, Ashby), drafts a personalized cold email per
posting using your resume, lets you review, then sends through the
existing `inbox/` engine.

stdlib only. No paid APIs. Hunter.io is optional (free tier: 25/mo).

## Why this exists

Job-application portals are graveyards. The hiring manager's inbox is
where decisions get made. This tool automates the search-and-draft part
so you can spend your time on the part that matters — picking the right
companies and writing the right opener.

## Setup

1. Your resume goes in `state/applicant.json` (already created). Edit
   to taste — verticals, tools, certs, differentiators.

2. The seed list of companies to scan is `jobs/companies.json`, grouped
   by ATS. Add slugs:
   - **Greenhouse** slug = `<x>` in `boards.greenhouse.io/<x>`
   - **Lever** slug = `<x>` in `jobs.lever.co/<x>`
   - **Ashby** slug = `<x>` in `jobs.ashbyhq.com/<x>`

3. Optional: `export HUNTER_API_KEY=<your-key>` if you have one. Without
   it, the email guesser falls back to common patterns + catch-alls.

## Run it

```bash
cd cold-stack

# 1. Find open SDR/BDR jobs across every configured ATS
python -m jobs find --allowed-loc detroit michigan remote
# fetches → filters → writes state/jobs_open.json
# prints a table of matches

# 2. Draft a personalized application email for each
python -m jobs draft --limit 10
# writes state/applications/<slug>__<job_id>/draft.md per match
# email body grounded in keyword matches between JD and your profile

# 3. Read drafts. Edit the .md files for any you want to tweak.

# 4. Push to send queue
python -m jobs enqueue --slug vanta          # one company
python -m jobs enqueue                       # all drafts

# 5. Send (uses the inbox engine)
python -m inbox loop --interval 5            # sends + polls replies
```

## How the email gets personalized

The writer looks at each JD and extracts keyword matches against your
applicant profile:

- **Verticals** (FinTech, AI/ML, LegalTech, construction, etc.) — your
  current Glen Coco book
- **Tools** (Salesforce, HubSpot, Salesloft, Apollo, Orum, etc.)
- **Certifications** (CompTIA Security+, AWS) — flagged when the JD
  prefers them

If any match, the opener references that specific overlap. If nothing
matches, the email falls back to a generic-but-honest opener. You
should not send the generic ones; either edit them or skip.

## How the hiring contact gets found

The email guesser (in order of confidence):

1. If `HUNTER_API_KEY` set: query Hunter for the company's dominant
   pattern, apply it to the hiring manager's name if known.
2. Catch-all addresses: `careers@`, `jobs@`, `recruiting@`, `talent@`,
   `hello@`.
3. Common name patterns if you provide a hiring manager name.

The `draft.md` for each job lists the **best guess** in the `To`
header. Override it before enqueueing if you know better.

## Sending volume

For job applications, send 5-15/day MAX. Even a single Gmail will keep
you out of spam at that pace. There's no point in volume here — each
email is a hand-fitted message to a specific company. Quality wins.

If a hiring manager replies, the existing `inbox loop` catches it via
IMAP, marks the lead `paused_for_reply: true`, stage `replied`. From
there you respond manually (a job interview is not something you want
to automate the human side of).
