# booking

Minimal Calendly substitute. Operator declares free windows in
`state/availability.json`; CLI proposes slots in the prospect's
timezone, holds them, then confirms one by sending a real RFC 5545
.ics calendar invite over SMTP. Reuses the inbox engine's SMTP creds.

## Setup

Reuses the same env vars as `inbox/`. Nothing extra to install — stdlib
only (`zoneinfo` requires Python ≥ 3.9; on minimal installs you may
need `pip install tzdata`).

Edit the timezone in `state/availability.json` to your own:

```json
{
  "tz": "America/New_York",
  "slot_minutes": 30,
  "buffer_minutes": 15,
  "windows": [],
  "holds": [],
  "bookings": []
}
```

## Workflow

```bash
cd cold-stack

# 1. Declare your free windows (operator TZ, naive ISO):
python -m booking add-window --start 2026-05-16T09:00:00 --end 2026-05-16T11:30:00
python -m booking add-window --start 2026-05-16T14:00:00 --end 2026-05-16T16:30:00

# 2. A positive reply comes in. Propose slots in their timezone:
python -m booking propose --lead-id ridgeway-logistics --prospect-tz America/Los_Angeles
# → prints 3 slots, holds them, and gives you reply text to paste

# 3. They pick one. Confirm and send the calendar invite:
python -m booking confirm \
  --lead-id ridgeway-logistics \
  --slot 2026-05-16T10:00:00 \
  --to ops@ridgeway.example \
  --title "Ridgeway · 30-min intro" \
  --minutes 30
# → sends an email with an .ics METHOD:REQUEST attachment
# → marks the lead's stage as "booked" in state/queue.json

# Any other proposed slots for that lead are released automatically.

# Cancel or release stale holds:
python -m booking release --lead-id ridgeway-logistics

# What's the state of the calendar?
python -m booking list
```

## What this does NOT do

- Doesn't host a public web page where prospects self-serve a slot.
  Operator (or the Mobile agent) runs `propose` and emails the slots
  manually, then runs `confirm` when one is picked.
- Doesn't sync to Google Calendar. The .ics invite Gmail receives WILL
  land in the prospect's calendar (and yours, since you're the
  organizer) but there is no two-way sync.
- Doesn't detect double-booking against your real calendar. The
  authoritative source is `state/availability.json`. Keep your windows
  honest.
- Doesn't generate Zoom links. Paste the link into the `--body` arg or
  the reply text yourself, or extend `ics.py` to call your Zoom API.

If you outgrow this — > 5 booked calls/week or you want self-serve —
buy Calendly. The MCP entry in `.mcp.json` is still there.
