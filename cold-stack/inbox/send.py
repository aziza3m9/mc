"""SMTP send. One step per lead per pass."""
from __future__ import annotations

import email.utils
import smtplib
import ssl
import uuid
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any

from .config import Config
from .queue import append_log, load_queue, save_queue
from .sequence import due_step


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _message_id(cfg: Config, lead_id: str, step_n: int) -> str:
    """Stable, decodable Message-ID: lead and step are recoverable from it.

    Format: <lead_id.step.uuid@from-domain>
    """
    domain = cfg.from_addr.split("@", 1)[-1]
    return f"<{lead_id}.{step_n}.{uuid.uuid4().hex}@{domain}>"


def _build_message(cfg: Config, lead: dict[str, Any], step: dict[str, Any],
                   message_id: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = cfg.from_header
    msg["To"] = lead["send"]["to"]
    msg["Subject"] = step["subject"]
    msg["Message-ID"] = message_id
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["List-Unsubscribe"] = f"<mailto:{cfg.unsubscribe_mailto}?subject=unsubscribe>"
    msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"

    # Thread follow-ups to the first message.
    sequence = lead["send"]["sequence"]
    prior_ids = [s.get("message_id") for s in sequence if s.get("message_id")]
    if prior_ids:
        msg["In-Reply-To"] = prior_ids[-1]
        msg["References"] = " ".join(prior_ids)

    msg.set_content(step["body"])
    return msg


def send_due(cfg: Config, dry_run: bool = False) -> int:
    """Send the next due step for every eligible lead. Returns count sent."""
    queue = load_queue(cfg.state_dir)
    sent = 0

    smtp = None
    try:
        for lead_id, lead in queue.items():
            if lead.get("stage") != "pitch":
                continue
            if (lead.get("send") or {}).get("channel") != "email":
                continue
            if (lead.get("checker") or {}).get("verdict") != "pass":
                continue

            step = due_step(lead)
            if step is None:
                continue

            mid = _message_id(cfg, lead_id, step["step"])
            msg = _build_message(cfg, lead, step, mid)

            if dry_run:
                print(f"DRY {lead_id} step={step['step']} to={lead['send']['to']} "
                      f"subj={step['subject']!r}")
            else:
                if smtp is None:
                    smtp = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=30)
                    smtp.starttls(context=ssl.create_default_context())
                    smtp.login(cfg.user, cfg.password)
                smtp.send_message(msg)
                print(f"SENT {lead_id} step={step['step']} mid={mid}")

            step["sent_at"] = _now()
            step["message_id"] = mid
            if not lead["send"].get("first_send_at"):
                lead["send"]["first_send_at"] = _now()
            append_log(cfg.state_dir, "inbox", "step_sent", lead_id,
                       f"step {step['step']} {'(dry)' if dry_run else ''}".strip())
            sent += 1
    finally:
        if smtp is not None:
            try:
                smtp.quit()
            except Exception:
                pass

    if not dry_run:
        save_queue(cfg.state_dir, queue)
    return sent
