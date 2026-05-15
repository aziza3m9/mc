"""Sequence stepping: decide which step (if any) is due for each lead."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any


def _parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def due_step(lead: dict[str, Any], now: datetime | None = None) -> dict[str, Any] | None:
    """Return the first step whose delay has elapsed and which hasn't been sent.

    Returns None if the lead is paused (reply/bounce/opt-out) or no step is due.
    """
    now = now or datetime.now(timezone.utc)
    send = lead.get("send") or {}

    if send.get("paused_for_reply") or send.get("bounced") or send.get("opted_out"):
        return None

    sequence = send.get("sequence") or []
    if not sequence:
        return None

    first = send.get("first_send_at")
    anchor = _parse_ts(first) if first else now

    for step in sequence:
        if step.get("sent_at"):
            continue
        delay = timedelta(days=int(step.get("delay_days", 0)))
        if anchor + delay <= now:
            return step
        return None
    return None
