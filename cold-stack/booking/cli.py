"""Booking CLI.

  python -m booking add-window --start ISO --end ISO
  python -m booking propose --lead-id ID --prospect-tz TZ [--count 3]
  python -m booking confirm --lead-id ID --slot ISO --to EMAIL --title T [--minutes 30]
  python -m booking release --lead-id ID
  python -m booking list
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from inbox.config import load as load_inbox_cfg
from inbox.queue import append_log, load_queue, save_queue

from . import availability as av_mod
from .ics import send_invite


def _state_dir() -> Path:
    return load_inbox_cfg().state_dir


def cmd_add_window(args: argparse.Namespace) -> int:
    state = _state_dir()
    av = av_mod.load_av(state)
    av.setdefault("windows", []).append({"start": args.start, "end": args.end})
    av_mod.save_av(state, av)
    print(f"window added: {args.start} → {args.end} ({av['tz']})")
    return 0


def cmd_propose(args: argparse.Namespace) -> int:
    state = _state_dir()
    av = av_mod.load_av(state)
    picks = av_mod.propose(av, lead_id=args.lead_id, count=args.count)
    if not picks:
        print("no free slots available — add more windows", file=sys.stderr)
        return 1
    av_mod.save_av(state, av)

    prospect_tz = ZoneInfo(args.prospect_tz)
    print(f"\nproposed {len(picks)} slot(s) for {args.lead_id}\n")
    print(f"  {'operator (' + av['tz'] + ')':<35}  prospect ({args.prospect_tz})")
    print(f"  {'-' * 35}  {'-' * 35}")
    for p in picks:
        op_local = p.strftime("%a %Y-%m-%d %H:%M %Z")
        prospect = p.astimezone(prospect_tz).strftime("%a %Y-%m-%d %H:%M %Z")
        slot_iso = p.replace(tzinfo=None).isoformat()
        print(f"  {op_local:<35}  {prospect}    [{slot_iso}]")
    print("\nreply text to paste:\n")
    print("Happy to jump on a 30-min Zoom. Which works?")
    for p in picks:
        prospect = p.astimezone(prospect_tz).strftime("%a %b %-d, %-I:%M %p %Z")
        print(f"  · {prospect}")
    append_log(state, "booking", "proposed", args.lead_id,
               f"{len(picks)} slots held")
    return 0


def cmd_confirm(args: argparse.Namespace) -> int:
    cfg = load_inbox_cfg()
    state = cfg.state_dir
    av = av_mod.load_av(state)

    tz = ZoneInfo(av["tz"])
    start_local = datetime.fromisoformat(args.slot).replace(tzinfo=tz)

    uid = f"{uuid.uuid4().hex}@{cfg.from_addr.split('@', 1)[-1]}"

    body = (args.body or
            f"Confirming our call: {start_local.strftime('%A %b %-d at %-I:%M %p %Z')}.\n\n"
            f"Zoom link will follow.")

    if args.dry_run:
        print(f"DRY would send invite to={args.to} title={args.title!r} "
              f"start={start_local.isoformat()} uid={uid}")
    else:
        uid = send_invite(
            cfg,
            to_email=args.to,
            title=args.title,
            body=body,
            start_utc=start_local,
            duration_minutes=args.minutes,
            uid=uid,
        )
        print(f"SENT invite to {args.to} uid={uid}")

    av_mod.book(av, lead_id=args.lead_id, slot_iso=args.slot,
                prospect_email=args.to, title=args.title, uid=uid)
    av_mod.save_av(state, av)

    # Mark the lead booked in the main queue.
    queue = load_queue(state)
    if args.lead_id in queue:
        queue[args.lead_id]["stage"] = "booked"
        queue[args.lead_id].setdefault("booking", {}).update({
            "uid": uid, "slot": args.slot, "title": args.title,
        })
        save_queue(state, queue)

    append_log(state, "booking", "confirmed", args.lead_id,
               f"{args.slot} with {args.to} uid={uid}")
    return 0


def cmd_release(args: argparse.Namespace) -> int:
    state = _state_dir()
    av = av_mod.load_av(state)
    n = av_mod.release(av, args.lead_id)
    av_mod.save_av(state, av)
    print(f"released {n} hold(s) for {args.lead_id}")
    append_log(state, "booking", "released", args.lead_id, f"{n} holds")
    return 0


def cmd_list(_: argparse.Namespace) -> int:
    state = _state_dir()
    av = av_mod.load_av(state)
    print(json.dumps({
        "tz": av["tz"],
        "windows": len(av.get("windows", [])),
        "free_slots": len(av_mod.free_slots(av)),
        "holds": av.get("holds", []),
        "bookings": av.get("bookings", []),
    }, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="booking")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add-window")
    a.add_argument("--start", required=True, help="ISO naive datetime in operator TZ")
    a.add_argument("--end", required=True)
    a.set_defaults(func=cmd_add_window)

    p1 = sub.add_parser("propose")
    p1.add_argument("--lead-id", required=True)
    p1.add_argument("--prospect-tz", required=True, help='e.g. "America/Los_Angeles"')
    p1.add_argument("--count", type=int, default=3)
    p1.set_defaults(func=cmd_propose)

    c = sub.add_parser("confirm")
    c.add_argument("--lead-id", required=True)
    c.add_argument("--slot", required=True, help="ISO naive datetime in operator TZ")
    c.add_argument("--to", required=True, help="prospect email")
    c.add_argument("--title", required=True)
    c.add_argument("--minutes", type=int, default=30)
    c.add_argument("--body", default=None)
    c.add_argument("--dry-run", action="store_true")
    c.set_defaults(func=cmd_confirm)

    r = sub.add_parser("release")
    r.add_argument("--lead-id", required=True)
    r.set_defaults(func=cmd_release)

    sub.add_parser("list").set_defaults(func=cmd_list)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
