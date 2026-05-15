# inbox

Single-inbox cold-email engine. Replaces the send/reply-detection layer
of Smartlead with ~400 lines of stdlib Python. SMTP send, IMAP poll,
sequence stepping, reply / bounce / opt-out detection.

## Setup

### 1. Get a Gmail app password (or use any SMTP/IMAP host)

For Gmail: enable 2FA, then generate an app password at
https://myaccount.google.com/apppasswords. (Or use any SMTP/IMAP host
— Fastmail, Proton Bridge, your own mail server.)

### 2. Export credentials

```bash
export INBOX_USER='you@example.com'
export INBOX_PASSWORD='app-password-here'
export INBOX_FROM_NAME='Your Name'
export INBOX_FROM_ADDR='you@example.com'
# Optional — defaults are Gmail
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export IMAP_HOST=imap.gmail.com
export IMAP_PORT=993
```

### 3. Run the autopilot (recommended)

Open one terminal and start the loop. It sends and polls forever; you
can walk away. No cron needed.

```bash
cd cold-stack
python -m inbox loop --interval 5
# loop: tick every 5m. Ctrl-C to stop.
# [2026-05-15T19:45:00Z] sent=0 poll={'reply': 0, 'bounce': 0, 'opt_out': 0, 'unmatched': 0}
```

Now in another terminal, ask the orchestrator (in Claude Code) to run a
sweep. As Checker passes each lead, the orchestrator runs `enqueue`
automatically. The loop picks them up on its next tick and sends.

```bash
# Manual commands (also available; the loop runs these internally)
python -m inbox enqueue --lead-id ridgeway --to ops@ridgeway.example \
    --from-spec clients/ridgeway/v1/spec.json
python -m inbox send-due     # one-shot send
python -m inbox poll-replies # one-shot poll
python -m inbox status       # how many sent / replied / bounced
```

## How it stays threaded

Each outbound message gets a Message-ID of the form
`<lead_id.step.uuid@from-domain>`. Follow-ups in the same sequence set
`In-Reply-To` and `References` to the previous step's Message-ID, so
Gmail threads the entire drip. When the prospect replies, their reply
carries our Message-ID in `In-Reply-To` — we decode the lead and step
straight from it.

## What pauses a sequence

- **Reply** (any human reply on the thread) → `paused_for_reply: true`,
  stage `replied`. Mobile / human takes it from there.
- **Bounce** (sender matches `mailer-daemon|postmaster|no-reply`, or
  subject matches `undeliverable|delivery failure|...`) →
  `bounced: true`, stage `dead`.
- **Opt-out** (body or subject contains `unsubscribe|remove me|stop
  emailing|...`) → `opted_out: true`, stage `dead`.

Every send and every detection appends one line to `state/log.jsonl`.

## Cron (alternative to `loop`)

If you prefer cron over the built-in loop, both forms work:

```cron
*/15 * * * * cd /path/to/cold-stack && /usr/bin/python3 -m inbox send-due >> ../inbox.log 2>&1
*/5  * * * * cd /path/to/cold-stack && /usr/bin/python3 -m inbox poll-replies >> ../inbox.log 2>&1
```

Most people just run `python -m inbox loop` in `tmux` or `screen` and
call it done.

## What this is NOT

- No mailbox rotation, no warmup. One inbox, sent slowly.
- No open/click tracking. (Pixels kill deliverability.)
- No HTML. Plain text only.
- No daemon. Cron it.

If you outgrow this — > 30 sends/day from one address — buy Smartlead.
The MCP entry in `.mcp.json` is still there for that day.
