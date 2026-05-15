"""IMAP poll. Find replies, bounces, opt-outs; update queue accordingly."""
from __future__ import annotations

import email
import email.policy
import imaplib
import re
from datetime import datetime, timezone
from email.message import Message
from typing import Any

from .config import Config
from .queue import append_log, load_queue, save_queue

_OPT_OUT_RE = re.compile(
    r"\b(unsubscribe|remove me|stop emailing|take me off|opt[- ]?out)\b",
    re.IGNORECASE,
)
_BOUNCE_FROM_RE = re.compile(r"mailer-daemon|postmaster|no-?reply", re.IGNORECASE)
_BOUNCE_SUBJ_RE = re.compile(
    r"undeliverable|delivery (status notification|failure)|returned mail|"
    r"failure notice|mail delivery failed",
    re.IGNORECASE,
)
_OUR_MID_RE = re.compile(r"<([^.@>]+)\.(\d+)\.[^@>]+@[^>]+>")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _body_text(msg: Message) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                try:
                    return part.get_content()
                except Exception:
                    continue
        return ""
    try:
        return msg.get_content()
    except Exception:
        return ""


def _referenced_ids(msg: Message) -> list[str]:
    raw = []
    for h in ("In-Reply-To", "References"):
        v = msg.get(h)
        if v:
            raw.extend(re.findall(r"<[^>]+>", v))
    return raw


def _find_lead(queue: dict[str, Any], refs: list[str]) -> tuple[str, int] | None:
    """Match any referenced Message-ID to a lead's sent step."""
    for ref in refs:
        m = _OUR_MID_RE.match(ref)
        if m:
            lead_id, step_n = m.group(1), int(m.group(2))
            if lead_id in queue:
                return lead_id, step_n
        for lead_id, lead in queue.items():
            for step in (lead.get("send") or {}).get("sequence") or []:
                if step.get("message_id") == ref:
                    return lead_id, int(step.get("step", 0))
    return None


def _classify(msg: Message, body: str) -> str:
    sender = (msg.get("From") or "").lower()
    subject = (msg.get("Subject") or "")
    if _BOUNCE_FROM_RE.search(sender) or _BOUNCE_SUBJ_RE.search(subject):
        return "bounce"
    if _OPT_OUT_RE.search(body) or _OPT_OUT_RE.search(subject):
        return "opt_out"
    return "reply"


def poll_replies(cfg: Config, mailbox: str = "INBOX",
                 mark_seen: bool = True) -> dict[str, int]:
    """Walk UNSEEN messages, update queue. Returns counts by kind."""
    counts = {"reply": 0, "bounce": 0, "opt_out": 0, "unmatched": 0}
    queue = load_queue(cfg.state_dir)

    with imaplib.IMAP4_SSL(cfg.imap_host, cfg.imap_port, timeout=30) as imap:
        imap.login(cfg.user, cfg.password)
        imap.select(mailbox)
        typ, data = imap.search(None, "UNSEEN")
        if typ != "OK" or not data or not data[0]:
            return counts

        for num in data[0].split():
            typ, payload = imap.fetch(num, "(RFC822)")
            if typ != "OK":
                continue
            raw = payload[0][1]
            msg = email.message_from_bytes(raw, policy=email.policy.default)

            match = _find_lead(queue, _referenced_ids(msg))
            if match is None:
                counts["unmatched"] += 1
                if mark_seen:
                    imap.store(num, "+FLAGS", "\\Seen")
                continue

            lead_id, step_n = match
            body = _body_text(msg)
            kind = _classify(msg, body)
            counts[kind] += 1

            lead = queue[lead_id]
            send = lead.setdefault("send", {})
            send.setdefault("replies", [])
            send["replies"].append({
                "ts": _now(),
                "in_reply_to_step": step_n,
                "from": msg.get("From"),
                "subject": msg.get("Subject"),
                "kind": kind,
                "snippet": body[:500],
            })

            if kind == "reply":
                send["paused_for_reply"] = True
                lead["stage"] = "replied"
            elif kind == "bounce":
                send["bounced"] = True
                lead["stage"] = "dead"
            elif kind == "opt_out":
                send["opted_out"] = True
                lead["stage"] = "dead"

            append_log(cfg.state_dir, "inbox", f"{kind}_received", lead_id,
                       f"step {step_n} from {msg.get('From')!r}")

            if mark_seen:
                imap.store(num, "+FLAGS", "\\Seen")

    save_queue(cfg.state_dir, queue)
    return counts
