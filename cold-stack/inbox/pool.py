"""Multi-inbox pool: rotate sends across N inboxes, enforce per-inbox caps.

Why: a single Gmail-class inbox tops out around 30 cold sends/day before
deliverability degrades. To hit 50-150/day cleanly you spread the load.

Configuration lives in state/inboxes.json (operator-edited). Runtime
counters live in state/inbox_runtime.json (loop-managed). Counters reset
at the start of each day in the inbox's active_tz.

Backwards compat: if state/inboxes.json is empty AND env vars
(INBOX_USER etc.) are set, a single inbox is synthesized from env.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


@dataclass
class InboxConfig:
    id: str
    user: str
    password: str
    from_name: str
    from_addr: str
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    imap_host: str = "imap.gmail.com"
    imap_port: int = 993
    daily_cap: int = 25
    min_seconds_between_sends: int = 90
    active_start_hour: int = 9
    active_end_hour: int = 17
    active_days: list[int] = field(default_factory=lambda: [0, 1, 2, 3, 4])
    active_tz: str = "America/New_York"
    unsubscribe_mailto: str = ""
    enabled: bool = True

    @property
    def from_header(self) -> str:
        return f"{self.from_name} <{self.from_addr}>"


@dataclass
class InboxRuntime:
    sent_today: int = 0
    sent_today_date: str = ""
    last_send_at: str = ""
    lifetime_sent: int = 0
    lifetime_bounces: int = 0


def _today_in_tz(tz: str) -> str:
    return datetime.now(ZoneInfo(tz)).date().isoformat()


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _load_configs(state_dir: Path) -> list[InboxConfig]:
    p = state_dir / "inboxes.json"
    if p.exists():
        raw = json.loads(p.read_text() or "[]")
        if raw:
            return [InboxConfig(**r) for r in raw]
    user = os.environ.get("INBOX_USER")
    if not user:
        return []
    return [InboxConfig(
        id=user,
        user=user,
        password=os.environ.get("INBOX_PASSWORD", ""),
        from_name=os.environ.get("INBOX_FROM_NAME", user),
        from_addr=os.environ.get("INBOX_FROM_ADDR", user),
        smtp_host=os.environ.get("SMTP_HOST", "smtp.gmail.com"),
        smtp_port=int(os.environ.get("SMTP_PORT", "587")),
        imap_host=os.environ.get("IMAP_HOST", "imap.gmail.com"),
        imap_port=int(os.environ.get("IMAP_PORT", "993")),
        unsubscribe_mailto=os.environ.get("INBOX_UNSUB_MAILTO", user),
        daily_cap=int(os.environ.get("INBOX_DAILY_CAP", "25")),
    )]


def _load_runtime(state_dir: Path) -> dict[str, InboxRuntime]:
    p = state_dir / "inbox_runtime.json"
    if not p.exists():
        return {}
    raw = json.loads(p.read_text() or "{}")
    return {k: InboxRuntime(**v) for k, v in raw.items()}


def save_runtime(state_dir: Path, pool: list[tuple[InboxConfig, InboxRuntime]]) -> None:
    out = {c.id: asdict(r) for c, r in pool}
    (state_dir / "inbox_runtime.json").write_text(
        json.dumps(out, indent=2, sort_keys=True) + "\n"
    )


def load_pool(state_dir: Path) -> list[tuple[InboxConfig, InboxRuntime]]:
    configs = _load_configs(state_dir)
    runtimes = _load_runtime(state_dir)
    out: list[tuple[InboxConfig, InboxRuntime]] = []
    for c in configs:
        r = runtimes.get(c.id, InboxRuntime())
        today = _today_in_tz(c.active_tz)
        if r.sent_today_date != today:
            r.sent_today = 0
            r.sent_today_date = today
        out.append((c, r))
    return out


def add_inbox(state_dir: Path, cfg: InboxConfig) -> None:
    p = state_dir / "inboxes.json"
    raw = json.loads(p.read_text() or "[]") if p.exists() else []
    raw = [r for r in raw if r.get("id") != cfg.id]  # replace if exists
    raw.append(asdict(cfg))
    p.write_text(json.dumps(raw, indent=2, sort_keys=True) + "\n")


def _eligible(c: InboxConfig, r: InboxRuntime, now_utc: datetime) -> bool:
    if not c.enabled:
        return False
    now_local = now_utc.astimezone(ZoneInfo(c.active_tz))
    if now_local.weekday() not in c.active_days:
        return False
    if not (c.active_start_hour <= now_local.hour < c.active_end_hour):
        return False
    if r.sent_today >= c.daily_cap:
        return False
    if r.last_send_at:
        try:
            last = datetime.fromisoformat(r.last_send_at.replace("Z", "+00:00"))
            if (now_utc - last).total_seconds() < c.min_seconds_between_sends:
                return False
        except ValueError:
            pass
    return True


def pick_next(pool: list[tuple[InboxConfig, InboxRuntime]],
              now_utc: datetime | None = None) -> tuple[InboxConfig, InboxRuntime] | None:
    """Return least-loaded eligible inbox, or None if all are maxed/inactive."""
    now_utc = now_utc or datetime.now(timezone.utc)
    candidates = [(c, r) for c, r in pool if _eligible(c, r, now_utc)]
    if not candidates:
        return None
    candidates.sort(key=lambda x: (x[1].sent_today, x[1].last_send_at))
    return candidates[0]


def mark_sent(r: InboxRuntime) -> None:
    r.sent_today += 1
    r.last_send_at = _now_utc_iso()
    r.lifetime_sent += 1
