"""Read/write the shared queue + append to the shared log.

The orchestrator owns the schema. This module only reads/writes JSON;
it does not invent fields the orchestrator doesn't know about.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_queue(state_dir: Path) -> dict[str, Any]:
    p = state_dir / "queue.json"
    return json.loads(p.read_text() or "{}")


def save_queue(state_dir: Path, queue: dict[str, Any]) -> None:
    p = state_dir / "queue.json"
    p.write_text(json.dumps(queue, indent=2, sort_keys=True) + "\n")


def append_log(state_dir: Path, agent: str, action: str,
               lead_id: str | None, summary: str) -> None:
    line = json.dumps({
        "ts": _now(),
        "agent": agent,
        "action": action,
        "lead_id": lead_id,
        "summary": summary,
    })
    with (state_dir / "log.jsonl").open("a") as f:
        f.write(line + "\n")
