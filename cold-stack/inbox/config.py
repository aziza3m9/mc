"""Env-driven config. Fail fast if anything required is missing."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    smtp_host: str
    smtp_port: int
    imap_host: str
    imap_port: int
    user: str
    password: str
    from_name: str
    from_addr: str
    unsubscribe_mailto: str
    state_dir: Path

    @property
    def from_header(self) -> str:
        return f"{self.from_name} <{self.from_addr}>"


def _require(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"missing required env var: {name}")
    return v


def load() -> Config:
    state_dir = Path(os.environ.get("COLD_STACK_STATE",
                                     Path(__file__).resolve().parent.parent / "state"))
    return Config(
        smtp_host=os.environ.get("SMTP_HOST", "smtp.gmail.com"),
        smtp_port=int(os.environ.get("SMTP_PORT", "587")),
        imap_host=os.environ.get("IMAP_HOST", "imap.gmail.com"),
        imap_port=int(os.environ.get("IMAP_PORT", "993")),
        user=_require("INBOX_USER"),
        password=_require("INBOX_PASSWORD"),
        from_name=os.environ.get("INBOX_FROM_NAME", _require("INBOX_USER")),
        from_addr=os.environ.get("INBOX_FROM_ADDR", _require("INBOX_USER")),
        unsubscribe_mailto=os.environ.get("INBOX_UNSUB_MAILTO",
                                          _require("INBOX_USER")),
        state_dir=Path(state_dir),
    )
