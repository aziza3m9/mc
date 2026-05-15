"""Entry point.

  python -m inbox send-due [--dry-run]
  python -m inbox poll-replies [--leave-unread]
  python -m inbox loop [--interval 5]
  python -m inbox enqueue --lead-id ID --to addr --from-spec path.json
  python -m inbox status
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .config import load
from .poll import poll_replies
from .queue import append_log, load_queue, save_queue
from .send import send_due


def cmd_send_due(args: argparse.Namespace) -> int:
    cfg = load()
    n = send_due(cfg, dry_run=args.dry_run)
    print(f"{'dry-' if args.dry_run else ''}sent {n}")
    return 0


def cmd_poll(args: argparse.Namespace) -> int:
    cfg = load()
    counts = poll_replies(cfg, mark_seen=not args.leave_unread)
    print(json.dumps(counts))
    return 0


def cmd_loop(args: argparse.Namespace) -> int:
    """Run send-due + poll-replies forever. Use this instead of cron."""
    cfg = load()
    interval = max(60, args.interval * 60)
    print(f"loop: tick every {args.interval}m. Ctrl-C to stop.", flush=True)
    while True:
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        try:
            n = send_due(cfg)
        except Exception as e:
            print(f"[{ts}] send error: {e}", file=sys.stderr, flush=True)
            n = -1
        try:
            counts = poll_replies(cfg)
        except Exception as e:
            print(f"[{ts}] poll error: {e}", file=sys.stderr, flush=True)
            counts = {}
        print(f"[{ts}] sent={n} poll={counts}", flush=True)
        try:
            time.sleep(interval)
        except KeyboardInterrupt:
            print("\nstopped", flush=True)
            return 0


def cmd_enqueue(args: argparse.Namespace) -> int:
    cfg = load()
    spec = json.loads(Path(args.from_spec).read_text())
    if "sequence" not in spec:
        print("spec missing 'sequence'", file=sys.stderr)
        return 2

    queue = load_queue(cfg.state_dir)
    lead = queue.setdefault(args.lead_id, {"lead_id": args.lead_id})
    lead["stage"] = "pitch"
    lead.setdefault("checker", {"verdict": "pass"})  # assume orchestrator already ran it
    lead["send"] = {
        "channel": "email",
        "to": args.to,
        "sequence": [
            {**step, "sent_at": None, "message_id": None}
            for step in spec["sequence"]
            if step.get("channel", "email") == "email"
        ],
        "first_send_at": None,
        "paused_for_reply": False,
        "bounced": False,
        "opted_out": False,
        "replies": [],
    }
    save_queue(cfg.state_dir, queue)
    append_log(cfg.state_dir, "inbox", "enqueued", args.lead_id,
               f"{len(lead['send']['sequence'])} steps to {args.to}")
    print(f"enqueued {args.lead_id}: {len(lead['send']['sequence'])} steps")
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    cfg = load()
    queue = load_queue(cfg.state_dir)
    stages: dict[str, int] = {}
    sent_total = 0
    replied = 0
    bounced = 0
    opted = 0
    for lead in queue.values():
        stages[lead.get("stage", "?")] = stages.get(lead.get("stage", "?"), 0) + 1
        send = lead.get("send") or {}
        sent_total += sum(1 for s in send.get("sequence") or [] if s.get("sent_at"))
        if send.get("paused_for_reply"):
            replied += 1
        if send.get("bounced"):
            bounced += 1
        if send.get("opted_out"):
            opted += 1
    print(json.dumps({
        "leads": len(queue),
        "by_stage": stages,
        "steps_sent": sent_total,
        "replied": replied,
        "bounced": bounced,
        "opted_out": opted,
    }, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="inbox")
    sub = p.add_subparsers(dest="cmd", required=True)

    s1 = sub.add_parser("send-due")
    s1.add_argument("--dry-run", action="store_true")
    s1.set_defaults(func=cmd_send_due)

    s2 = sub.add_parser("poll-replies")
    s2.add_argument("--leave-unread", action="store_true")
    s2.set_defaults(func=cmd_poll)

    sl = sub.add_parser("loop", help="run send + poll forever (no cron needed)")
    sl.add_argument("--interval", type=int, default=5, help="minutes between ticks")
    sl.set_defaults(func=cmd_loop)

    s3 = sub.add_parser("enqueue")
    s3.add_argument("--lead-id", required=True)
    s3.add_argument("--to", required=True)
    s3.add_argument("--from-spec", required=True,
                    help="path to a Builder spec JSON containing 'sequence'")
    s3.set_defaults(func=cmd_enqueue)

    s4 = sub.add_parser("status")
    s4.set_defaults(func=cmd_status)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
