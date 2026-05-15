"""Free-busy logic: slice operator-declared windows into slots, manage holds + bookings.

All times stored in operator TZ as naive ISO strings; converted to other
zones on demand. The shape of state/availability.json:

{
  "tz": "America/New_York",
  "slot_minutes": 30,
  "buffer_minutes": 15,
  "windows": [{"start": "2026-05-16T09:00:00", "end": "2026-05-16T11:30:00"}],
  "holds":   [{"slot": "...", "lead_id": "...", "kind": "proposed", "ts": "..."}],
  "bookings":[{"slot": "...", "lead_id": "...", "prospect_email": "...", "title": "...",
               "uid": "...", "ts": "..."}]
}
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_av(state_dir: Path) -> dict[str, Any]:
    p = state_dir / "availability.json"
    if not p.exists():
        return {"tz": "UTC", "slot_minutes": 30, "buffer_minutes": 15,
                "windows": [], "holds": [], "bookings": []}
    return json.loads(p.read_text())


def save_av(state_dir: Path, av: dict[str, Any]) -> None:
    (state_dir / "availability.json").write_text(
        json.dumps(av, indent=2, sort_keys=True) + "\n"
    )


def _parse(naive_iso: str, tz: ZoneInfo) -> datetime:
    return datetime.fromisoformat(naive_iso).replace(tzinfo=tz)


def candidate_slots(av: dict[str, Any]) -> list[datetime]:
    """All slot starts across all windows, in operator TZ."""
    tz = ZoneInfo(av["tz"])
    step = timedelta(minutes=av["slot_minutes"])
    out: list[datetime] = []
    for w in av.get("windows", []):
        cur = _parse(w["start"], tz)
        end = _parse(w["end"], tz)
        while cur + step <= end:
            out.append(cur)
            cur = cur + step
    return sorted(out)


def _taken_slots(av: dict[str, Any]) -> set[str]:
    """Slots that are held or booked — by operator-TZ ISO string."""
    taken: set[str] = set()
    for h in av.get("holds", []):
        taken.add(h["slot"])
    for b in av.get("bookings", []):
        taken.add(b["slot"])
    return taken


def free_slots(av: dict[str, Any], not_before_utc: datetime | None = None) -> list[datetime]:
    not_before_utc = not_before_utc or datetime.now(timezone.utc)
    taken = _taken_slots(av)
    out = []
    for s in candidate_slots(av):
        if s.isoformat(timespec="minutes") in taken or s.replace(tzinfo=None).isoformat() in taken:
            continue
        if s.astimezone(timezone.utc) < not_before_utc:
            continue
        out.append(s)
    return out


def propose(av: dict[str, Any], lead_id: str, count: int = 3) -> list[datetime]:
    """Pick the next `count` free slots and hold them as proposed."""
    picks = free_slots(av)[:count]
    av.setdefault("holds", [])
    for s in picks:
        av["holds"].append({
            "slot": s.replace(tzinfo=None).isoformat(),
            "lead_id": lead_id,
            "kind": "proposed",
            "ts": _now_utc_iso(),
        })
    return picks


def release(av: dict[str, Any], lead_id: str) -> int:
    """Drop all proposed holds for a lead. Returns count dropped."""
    holds = av.get("holds", [])
    keep = [h for h in holds if not (h["lead_id"] == lead_id and h["kind"] == "proposed")]
    n = len(holds) - len(keep)
    av["holds"] = keep
    return n


def book(av: dict[str, Any], lead_id: str, slot_iso: str, prospect_email: str,
         title: str, uid: str) -> dict[str, Any]:
    """Confirm a slot. Releases other proposed holds for this lead."""
    release(av, lead_id)
    record = {
        "slot": slot_iso,
        "lead_id": lead_id,
        "prospect_email": prospect_email,
        "title": title,
        "uid": uid,
        "ts": _now_utc_iso(),
    }
    av.setdefault("bookings", []).append(record)
    return record


def in_prospect_tz(slot_naive: datetime, op_tz: str, prospect_tz: str) -> datetime:
    return slot_naive.replace(tzinfo=ZoneInfo(op_tz)).astimezone(ZoneInfo(prospect_tz))
