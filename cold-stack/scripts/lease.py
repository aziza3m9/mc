#!/usr/bin/env python3
"""Lease helper for the orchestrator.

Prevents two sub-agents from touching the same lead. The orchestrator
calls this before delegating; the lease auto-expires after ttl_minutes.

Usage:
  lease.py acquire <lead_id> <agent> [--ttl 10]
  lease.py release <lead_id>
  lease.py list
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

STATE = Path(__file__).resolve().parent.parent / "state" / "leases.json"


def _load() -> dict:
    return json.loads(STATE.read_text() or "{}")


def _save(leases: dict) -> None:
    STATE.write_text(json.dumps(leases, indent=2, sort_keys=True) + "\n")


def _prune(leases: dict) -> dict:
    now = datetime.now(timezone.utc)
    alive = {}
    for lead_id, lease in leases.items():
        acquired = datetime.fromisoformat(lease["acquired_at"].replace("Z", "+00:00"))
        if acquired + timedelta(minutes=lease["ttl_minutes"]) > now:
            alive[lead_id] = lease
    return alive


def acquire(lead_id: str, agent: str, ttl: int) -> int:
    leases = _prune(_load())
    if lead_id in leases:
        print(f"BUSY {lead_id} held by {leases[lead_id]['agent']}", file=sys.stderr)
        return 1
    leases[lead_id] = {
        "agent": agent,
        "acquired_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "ttl_minutes": ttl,
    }
    _save(leases)
    print(f"OK {lead_id} leased to {agent} for {ttl}m")
    return 0


def release(lead_id: str) -> int:
    leases = _prune(_load())
    leases.pop(lead_id, None)
    _save(leases)
    print(f"OK released {lead_id}")
    return 0


def list_leases() -> int:
    leases = _prune(_load())
    print(json.dumps(leases, indent=2, sort_keys=True))
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("acquire")
    a.add_argument("lead_id")
    a.add_argument("agent")
    a.add_argument("--ttl", type=int, default=10)

    r = sub.add_parser("release")
    r.add_argument("lead_id")

    sub.add_parser("list")

    args = p.parse_args()
    if args.cmd == "acquire":
        return acquire(args.lead_id, args.agent, args.ttl)
    if args.cmd == "release":
        return release(args.lead_id)
    if args.cmd == "list":
        return list_leases()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
