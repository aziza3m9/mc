# inbox

Multi-inbox cold-email engine. Replaces the send/reply-detection layer
of Smartlead with stdlib Python. SMTP send across a pool of inboxes
with rotation, daily caps, send spacing, and active-hour gating; IMAP
poll across all inboxes; reply / bounce / opt-out detection.

## Capacity planning

Single-inbox cold sending tops out around 25-30/day before Gmail starts
flagging messages as spam. To sustain higher volume, spread the load:

| Target          | Inboxes needed (~25/day each) | Domains  |
|-----------------|-------------------------------|----------|
| 25/day          | 1                             | 1        |
| 50-75/day       | 2-3                           | 1-2      |
| 150/day         | 6-7                           | 2-3      |
| **500/day**     | **20**                        | **4-6**  |
| 1000/day        | 40                            | 8-10     |

Multiple inboxes per domain is fine. Multiple domains protects you when
one gets reputation-flagged. Use **secondary domains** (`yourbiz-team.com`,
`yourbiz-mail.com`) so your primary domain's deliverability is never at
risk.

## Setup

### Quick start (one inbox via env vars)

```bash
export INBOX_USER='you@example.com'
export INBOX_PASSWORD='app-password'
export INBOX_FROM_NAME='You'
export INBOX_FROM_ADDR='you@example.com'
```

### Pool setup (N inboxes via state/inboxes.json)

```bash
cd cold-stack

python -m inbox inbox-add \
    --id alex-primary \
    --user alex@biz-team.com \
    --from-name "Alex" \
    --from-addr alex@biz-team.com \
    --daily-cap 25 \
    --min-seconds 90 \
    --active-start-hour 9 --active-end-hour 17 \
    --active-tz America/New_York
# (you'll be prompted for the password)

python -m inbox inbox-add --id alex-secondary --user alex@biz-mail.com ...
python -m inbox inbox-add --id sarah-primary  --user sarah@biz-team.com ...

python -m inbox inbox-list
#  id                          sent today   cap  lifetime  status
#  ---------------------------------------------------------------------------
#    alex-primary                       0    25         0  09-17 America/New_York
#    alex-secondary                     0    25         0  09-17 America/New_York
#    sarah-primary                      0    25         0  09-17 America/New_York
#  ---------------------------------------------------------------------------
#    TOTAL daily capacity: 75  | sent today: 0
```

Configs live in `state/inboxes.json` (edit by hand or use `inbox-add`).
Per-inbox runtime counters (sent today, last send, lifetime) live in
`state/inbox_runtime.json` and reset at midnight in the inbox's
`active_tz`.

## Per-inbox settings

| Field                      | Meaning                                                  |
|----------------------------|----------------------------------------------------------|
| `daily_cap`                | Max sends per UTC day                                    |
| `min_seconds_between_sends`| Throttle between consecutive sends from this inbox       |
| `active_start_hour` / `_end_hour` | Send only between these hours (local to `active_tz`) |
| `active_days`              | `[0,1,2,3,4]` = Mon-Fri (default); add 5,6 for weekends  |
| `active_tz`                | IANA timezone (e.g. `America/New_York`)                  |
| `enabled`                  | Set to `false` to pause an inbox without deleting it     |

## Run the autopilot

```bash
python -m inbox loop --interval 5
# loop: tick every 5m. Ctrl-C to stop.
```

Each tick the loop:
1. Walks every lead in `state/queue.json` with stage `pitch` and a due step
2. Picks the least-loaded eligible inbox from the pool (cap not hit,
   inside active hours, spacing elapsed)
3. Connects SMTP to that inbox (lazily, reusing per inbox during a tick)
4. Sends, stamps `sent_at` / `message_id` / `sent_from` on the step
5. Increments that inbox's `sent_today`
6. After the send pass, polls IMAP on EVERY inbox for unread replies

If no inbox has capacity (all maxed for the day, or off-hours), the loop
sleeps and tries again next tick.

## How it stays threaded

Each outbound message gets `Message-ID: <lead_id.step.uuid@from-domain>`.
Follow-up steps set `In-Reply-To` and `References` to the previous step's
ID. When a prospect replies, their `In-Reply-To` carries our ID — the
poller decodes the lead and step right out of it. Replies are detected
no matter which inbox in the pool the prospect happened to reply to.

## What pauses a sequence

- **Reply** (any human reply) → `paused_for_reply: true`, stage `replied`.
- **Bounce** (`mailer-daemon` / `postmaster` / `undeliverable`) →
  `bounced: true`, stage `dead`, and the bounce is counted against the
  sending inbox's `lifetime_bounces`.
- **Opt-out** (`unsubscribe` / `remove me` / `stop emailing`) →
  `opted_out: true`, stage `dead`.

## Deliverability practice (read this before scaling)

Code can route 500 emails a day across 20 inboxes. Whether those 500
reach inboxes depends on things that have nothing to do with code:

1. **SPF, DKIM, DMARC**. Every sending domain needs them. Without
   DMARC alignment, Gmail will treat your mail as suspicious.
2. **Domain age**. New domains have zero reputation. Either buy aged
   domains, or send slowly for 4-6 weeks before ramping.
3. **Warmup**. Brand-new inboxes shouldn't send 25 cold emails on day
   1 — start at 2, double every 3 days. This module does not run a
   warmup network; for that buy Warmup Inbox (~$15/mo) or
   `lemwarm`, or send only to warm leads for 2 weeks first.
4. **Bounce rate**. Above 5% kills your inbox. Verify emails before
   sending (Hunter, NeverBounce, or Apollo's enrichment).
5. **Spam complaints**. Above 0.1% kills your domain. Ruthless
   relevance is the only fix — don't blast.
6. **Volume ramp**. Even with warmup, don't go 0 → cap. Increase
   `daily_cap` by 20% per week per inbox.

At 500/day, the bottleneck is never the sending code — it's whether
you have 20 inboxes across 5 domains that are individually healthy.
If you don't want to manage that, that's exactly what Smartlead's
$39/mo gets you.

## CLI reference

```bash
# Inbox management
python -m inbox inbox-add ...     # add or replace an inbox
python -m inbox inbox-list        # see counts, caps, status

# Send pipeline
python -m inbox enqueue --lead-id ID --to addr --from-spec spec.json
python -m inbox send-due [--dry-run]
python -m inbox poll-replies [--leave-unread]
python -m inbox loop [--interval 5]    # send + poll forever

# Queue inspection
python -m inbox status
```
