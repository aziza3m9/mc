# state/

Shared state for the cold-stack agent system. The orchestrator owns all
writes here (except `log.jsonl`, which Mobile may also append to).

## Files

### `queue.json`

Active leads, keyed by `lead_id`. Each lead carries its current stage
and all artifacts produced so far.

```json
{
  "ridgeway-logistics": {
    "lead_id": "ridgeway-logistics",
    "name": "Ridgeway Logistics",
    "vertical": "logistics",
    "stage": "diagnose",          // scout|diagnose|build|film|check|pitch|sent|replied|booked|dead
    "scout": { ... },              // Scout's record
    "diagnoser": { ... },          // Diagnoser's brief + cold message (after diagnose)
    "builder_spec_path": "...",    // path under clients/ (after build)
    "loom_url": "...",             // (after film)
    "checker": { "verdict": "pass", "scores": { ... } },
    "send": { "channel": "sms", "sent_at": "...", "message_id": "..." },
    "reply_sentiment": "positive", // for Mobile
    "booking_id": null
  }
}
```

### `leases.json`

Active leases. Prevents two sub-agents from touching one lead.

```json
{
  "ridgeway-logistics": {
    "agent": "diagnoser",
    "acquired_at": "2026-05-15T09:14:22Z",
    "ttl_minutes": 10
  }
}
```

### `log.jsonl`

Append-only. One JSON object per line. Both the orchestrator and Mobile
append here.

```json
{"ts": "2026-05-15T09:14:22Z", "agent": "scout", "action": "sweep_complete", "lead_id": null, "summary": "244 scanned, 32 qualified"}
{"ts": "2026-05-15T09:31:08Z", "agent": "diagnoser", "action": "brief_written", "lead_id": "ridgeway-logistics", "summary": "blunt operator tone, hero angle: SDR job posted 47d, no replies"}
```

## Stage transitions (orchestrator-owned)

```
scout → diagnose → build → film → check → pitch → sent → replied → booked
                                       └─ check:fail → diagnose (1 retry) → dead
```
