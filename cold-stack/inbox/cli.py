"""Entry point.

  python -m inbox send-due [--dry-run]
  python -m inbox poll-replies [--leave-unread]
  python -m inbox loop [--interval 5]
  python -m inbox enqueue --lead-id ID --to addr --from-spec path.json
  python -m inbox inbox-add --id X --user U --password P --from-name N --from-addr A [...]
  python -m inbox inbox-list
  python -m inbox status
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .pool import InboxConfig, add_inbox, load_pool
from .poll import poll_replies
from .queue import append_log, load_queue, save_queue
from .send import send_due


def _state_dir() -> Path:
    return Path(os.environ.get(
        "COLD_STACK_STATE",
        Path(__file__).resolve().parent.parent / "state",
    ))


def cmd_send_due(args: argparse.Namespace) -> int:
    n = send_due(_state_dir(), dry_run=args.dry_run)
    print(f"{'dry-' if args.dry_run else ''}sent {n}")
    return 0


def cmd_poll(args: argparse.Namespace) -> int:
    counts = poll_replies(_state_dir(), mark_seen=not args.leave_unread)
    print(json.dumps(counts))
    return 0


def cmd_loop(args: argparse.Namespace) -> int:
    state_dir = _state_dir()
    interval = max(60, args.interval * 60)
    print(f"loop: tick every {args.interval}m. Ctrl-C to stop.", flush=True)
    while True:
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        try:
            n = send_due(state_dir)
        except Exception as e:
            print(f"[{ts}] send error: {e}", file=sys.stderr, flush=True)
            n = -1
        try:
            counts = poll_replies(state_dir)
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
    state_dir = _state_dir()
    spec = json.loads(Path(args.from_spec).read_text())
    if "sequence" not in spec:
        print("spec missing 'sequence'", file=sys.stderr)
        return 2
    queue = load_queue(state_dir)
    lead = queue.setdefault(args.lead_id, {"lead_id": args.lead_id})
    lead["stage"] = "pitch"
    lead.setdefault("checker", {"verdict": "pass"})
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
    save_queue(state_dir, queue)
    append_log(state_dir, "inbox", "enqueued", args.lead_id,
               f"{len(lead['send']['sequence'])} steps to {args.to}")
    print(f"enqueued {args.lead_id}: {len(lead['send']['sequence'])} steps")
    return 0


def cmd_inbox_add(args: argparse.Namespace) -> int:
    state_dir = _state_dir()
    password = args.password or os.environ.get("INBOX_PASSWORD") or getpass.getpass("password: ")
    cfg = InboxConfig(
        id=args.id,
        user=args.user,
        password=password,
        from_name=args.from_name,
        from_addr=args.from_addr,
        smtp_host=args.smtp_host,
        smtp_port=args.smtp_port,
        imap_host=args.imap_host,
        imap_port=args.imap_port,
        daily_cap=args.daily_cap,
        min_seconds_between_sends=args.min_seconds,
        active_start_hour=args.active_start_hour,
        active_end_hour=args.active_end_hour,
        active_tz=args.active_tz,
        unsubscribe_mailto=args.unsub_mailto or args.from_addr,
    )
    add_inbox(state_dir, cfg)
    print(f"added inbox {cfg.id} (cap {cfg.daily_cap}/day, "
          f"{cfg.active_start_hour:02d}:00-{cfg.active_end_hour:02d}:00 {cfg.active_tz})")
    return 0


def cmd_inbox_list(_: argparse.Namespace) -> int:
    pool = load_pool(_state_dir())
    if not pool:
        print("no inboxes configured")
        return 0
    print(f"{'id':<28} {'sent today':>11} {'cap':>5} {'lifetime':>9}  status")
    print("-" * 75)
    for c, r in pool:
        flag = " " if c.enabled else "X"
        print(f"{flag} {c.id:<26} {r.sent_today:>11} {c.daily_cap:>5} "
              f"{r.lifetime_sent:>9}  {c.active_start_hour:02d}-{c.active_end_hour:02d} {c.active_tz}")
    total_cap = sum(c.daily_cap for c, _ in pool if c.enabled)
    total_sent = sum(r.sent_today for _, r in pool)
    print("-" * 75)
    print(f"  TOTAL daily capacity: {total_cap}  | sent today: {total_sent}")
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    state_dir = _state_dir()
    queue = load_queue(state_dir)
    stages: dict[str, int] = {}
    sent_total = 0
    replied = bounced = opted = 0
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

    sl = sub.add_parser("loop", help="run send + poll forever")
    sl.add_argument("--interval", type=int, default=5)
    sl.set_defaults(func=cmd_loop)

    s3 = sub.add_parser("enqueue")
    s3.add_argument("--lead-id", required=True)
    s3.add_argument("--to", required=True)
    s3.add_argument("--from-spec", required=True)
    s3.set_defaults(func=cmd_enqueue)

    a = sub.add_parser("inbox-add")
    a.add_argument("--id", required=True, help="short label e.g. 'alex-primary'")
    a.add_argument("--user", required=True, help="SMTP/IMAP username")
    a.add_argument("--password", default=None, help="omit to prompt")
    a.add_argument("--from-name", required=True)
    a.add_argument("--from-addr", required=True)
    a.add_argument("--smtp-host", default="smtp.gmail.com")
    a.add_argument("--smtp-port", type=int, default=587)
    a.add_argument("--imap-host", default="imap.gmail.com")
    a.add_argument("--imap-port", type=int, default=993)
    a.add_argument("--daily-cap", type=int, default=25)
    a.add_argument("--min-seconds", type=int, default=90)
    a.add_argument("--active-start-hour", type=int, default=9)
    a.add_argument("--active-end-hour", type=int, default=17)
    a.add_argument("--active-tz", default="America/New_York")
    a.add_argument("--unsub-mailto", default=None)
    a.set_defaults(func=cmd_inbox_add)

    sub.add_parser("inbox-list").set_defaults(func=cmd_inbox_list)
    sub.add_parser("status").set_defaults(func=cmd_status)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
