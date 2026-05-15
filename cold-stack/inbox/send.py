"""SMTP send across a pool of inboxes. One step per lead per pass; the
pool layer rotates which inbox sends each step."""
from __future__ import annotations

import email.utils
import smtplib
import ssl
import uuid
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from .pool import InboxConfig, InboxRuntime, load_pool, mark_sent, pick_next, save_runtime
from .queue import append_log, load_queue, save_queue
from .sequence import due_step


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _message_id(inbox: InboxConfig, lead_id: str, step_n: int) -> str:
    domain = inbox.from_addr.split("@", 1)[-1]
    return f"<{lead_id}.{step_n}.{uuid.uuid4().hex}@{domain}>"


def _build_message(inbox: InboxConfig, lead: dict[str, Any],
                   step: dict[str, Any], message_id: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = inbox.from_header
    msg["To"] = lead["send"]["to"]
    msg["Subject"] = step["subject"]
    msg["Message-ID"] = message_id
    msg["Date"] = email.utils.formatdate(localtime=True)
    unsub = inbox.unsubscribe_mailto or inbox.from_addr
    msg["List-Unsubscribe"] = f"<mailto:{unsub}?subject=unsubscribe>"
    msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"

    sequence = lead["send"]["sequence"]
    prior_ids = [s.get("message_id") for s in sequence if s.get("message_id")]
    if prior_ids:
        msg["In-Reply-To"] = prior_ids[-1]
        msg["References"] = " ".join(prior_ids)

    msg.set_content(step["body"])
    return msg


def _smtp_connect(inbox: InboxConfig) -> smtplib.SMTP:
    s = smtplib.SMTP(inbox.smtp_host, inbox.smtp_port, timeout=30)
    s.starttls(context=ssl.create_default_context())
    s.login(inbox.user, inbox.password)
    return s


def send_due(state_dir: Path, dry_run: bool = False) -> int:
    """Send the next due step for every eligible lead, rotating inboxes.

    Returns count sent. Stops when no inbox has capacity (caps hit, off
    hours, or spacing not elapsed) — those leads will be picked up on
    the next tick.
    """
    pool = load_pool(state_dir)
    if not pool:
        print("no inboxes configured — set env vars or fill state/inboxes.json")
        return 0

    queue = load_queue(state_dir)
    sent = 0
    smtp_conns: dict[str, smtplib.SMTP] = {}

    try:
        for lead_id, lead in queue.items():
            if lead.get("stage") != "pitch":
                continue
            send_meta = lead.get("send") or {}
            if send_meta.get("channel") != "email":
                continue
            if (lead.get("checker") or {}).get("verdict") != "pass":
                continue

            step = due_step(lead)
            if step is None:
                continue

            pick = pick_next(pool)
            if pick is None:
                # No inbox available right now; bail — try again next tick.
                break
            inbox, runtime = pick

            mid = _message_id(inbox, lead_id, step["step"])
            msg = _build_message(inbox, lead, step, mid)

            if dry_run:
                print(f"DRY {lead_id} via {inbox.id} step={step['step']} "
                      f"to={lead['send']['to']}")
            else:
                try:
                    if inbox.id not in smtp_conns:
                        smtp_conns[inbox.id] = _smtp_connect(inbox)
                    smtp_conns[inbox.id].send_message(msg)
                except Exception as e:
                    print(f"SEND FAIL {lead_id} via {inbox.id}: {e}")
                    # Don't mark sent; skip this lead this tick.
                    continue
                print(f"SENT {lead_id} via {inbox.id} mid={mid}")

            step["sent_at"] = _now()
            step["message_id"] = mid
            step["sent_from"] = inbox.id
            if not lead["send"].get("first_send_at"):
                lead["send"]["first_send_at"] = _now()
            mark_sent(runtime)
            append_log(state_dir, "inbox", "step_sent", lead_id,
                       f"step {step['step']} via {inbox.id}")
            sent += 1
    finally:
        for s in smtp_conns.values():
            try:
                s.quit()
            except Exception:
                pass

    if not dry_run:
        save_queue(state_dir, queue)
        save_runtime(state_dir, pool)
    return sent
