# cold-stack

A solo cold-email agency built as a Claude Code multi-agent system. One
orchestrator delegates read-only work to six sub-agents; a seventh agent
(Mobile) lives on the operator's phone and handles real-time replies.
Shared state is a flat file system — no database, no backend, no race
conditions on the writer side (orchestrator owns all writes).

## Layout

```
cold-stack/
├── CLAUDE.md             # orchestrator system prompt + operating rules
├── .claude/
│   └── agents/           # 7 sub-agent definitions
│       ├── scout.md
│       ├── diagnoser.md
│       ├── builder.md
│       ├── filmer.md
│       ├── pitcher.md
│       ├── checker.md
│       └── mobile.md
├── jobs/                 # job-application autopilot (Greenhouse/Lever/Ashby + writer)
├── inbox/                # internal Smartlead substitute (SMTP send + IMAP poll)
├── booking/              # internal Calendly substitute (.ics invites over SMTP)
├── .mcp.json             # MCP server config (only needed if you outgrow inbox/booking)
├── state/
│   ├── queue.json        # leads waiting for the next stage
│   ├── leases.json       # which agent currently holds which lead (prevents double-touch)
│   ├── availability.json # operator free-busy windows for booking/
│   ├── log.jsonl         # append-only event log
│   └── README.md         # state schema
└── clients/              # per-client artifacts (sample campaigns, looms, screenshots)
    └── <slug>/v<n>/      # versioned per client
```

## Operating rules

- **Orchestrator owns all writes.** Sub-agents read and return text. The
  orchestrator is the only thing that mutates `state/`, calls write-side
  MCP tools (Smartlead, Higgsfield, Calendly), or commits artifacts under
  `clients/`.
- **No two sub-agents touch one lead.** Before delegating, the
  orchestrator records a lease in `state/leases.json` keyed by lead id.
  If a lease already exists for that lead, the orchestrator waits or
  reroutes.
- **Human in the loop only when:** a deal exceeds $4,000, or the
  vertical's daily reply rate drops below 11%. Everything else runs
  unattended.
- **Mobile is the only sub-agent that writes** — and only to Calendly,
  via MCP. It is invoked from the iPhone instance and operates on
  positive replies in the queue.

## Running (autopilot)

You need two terminals. Both pointed at `cold-stack/`.

**Terminal 1 — send daemon.** Set Gmail creds (see `inbox/README.md`),
then start the loop. It runs forever; sends due steps and polls for
replies every 5 minutes.

```bash
bash scripts/init.sh                  # one-time
python -m inbox loop --interval 5     # leave this running
```

**Terminal 2 — Claude Code.** Tell the orchestrator to run a sweep.
As Checker passes each lead, the orchestrator auto-runs
`python -m inbox enqueue` — no human approval. The loop in Terminal 1
ships them on its next tick.

```
> run today's sweep on SaaS founders
```

Booking is the same pattern: when a positive reply lands, you (or the
Mobile agent) run `python -m booking propose --lead-id X
--prospect-tz Z`, paste the slots into a reply, and run `confirm` when
the prospect picks one.

**Optional**: configure MCP servers in `.mcp.json` (Smartlead,
Higgsfield, Calendly, Apollo, LinkedIn) when you outgrow `inbox/` +
`booking/`.

## Token budget

Target: ~3.4M tokens/day across all 7 agents. Cap soft-enforced by the
orchestrator: Scout sweeps cap at 240 companies/day, Builder caps at 4
sample campaigns/day, Pitcher caps at 32 outbound messages/day.
