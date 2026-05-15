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
├── .mcp.json             # MCP server config (Smartlead, Higgsfield, Calendly, Apollo, LinkedIn)
├── state/
│   ├── queue.json        # leads waiting for the next stage
│   ├── leases.json       # which agent currently holds which lead (prevents double-touch)
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

## Running

1. Configure MCP servers in `.mcp.json` (Smartlead, Higgsfield, Calendly,
   Apollo, LinkedIn). Placeholders are provided.
2. `cd cold-stack` and start Claude Code. The orchestrator reads
   `CLAUDE.md` and discovers sub-agents from `.claude/agents/`.
3. Seed state: `bash scripts/init.sh` creates empty queue/leases/log if
   missing.
4. Kick off a daily run: ask the orchestrator to "run today's sweep".

## Token budget

Target: ~3.4M tokens/day across all 7 agents. Cap soft-enforced by the
orchestrator: Scout sweeps cap at 240 companies/day, Builder caps at 4
sample campaigns/day, Pitcher caps at 32 outbound messages/day.
