"""Generate a minimal RFC 5545 VCALENDAR + send the invite over SMTP."""
from __future__ import annotations

import smtplib
import ssl
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formatdate

from inbox.config import Config


def _utc_str(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def build_ics(uid: str, organizer_email: str, organizer_name: str,
              attendee_email: str, title: str, description: str,
              start_utc: datetime, duration_minutes: int) -> str:
    end_utc = start_utc + timedelta(minutes=duration_minutes)
    dtstamp = _utc_str(datetime.now(timezone.utc))
    desc = description.replace("\n", "\\n")
    return (
        "BEGIN:VCALENDAR\r\n"
        "PRODID:-//cold-stack//booking//EN\r\n"
        "VERSION:2.0\r\n"
        "CALSCALE:GREGORIAN\r\n"
        "METHOD:REQUEST\r\n"
        "BEGIN:VEVENT\r\n"
        f"UID:{uid}\r\n"
        f"DTSTAMP:{dtstamp}\r\n"
        f"DTSTART:{_utc_str(start_utc)}\r\n"
        f"DTEND:{_utc_str(end_utc)}\r\n"
        f"SUMMARY:{title}\r\n"
        f"DESCRIPTION:{desc}\r\n"
        f"ORGANIZER;CN={organizer_name}:mailto:{organizer_email}\r\n"
        f"ATTENDEE;CN={attendee_email};RSVP=TRUE;PARTSTAT=NEEDS-ACTION:"
        f"mailto:{attendee_email}\r\n"
        "STATUS:CONFIRMED\r\n"
        "SEQUENCE:0\r\n"
        "END:VEVENT\r\n"
        "END:VCALENDAR\r\n"
    )


def send_invite(cfg: Config, *, to_email: str, title: str, body: str,
                start_utc: datetime, duration_minutes: int = 30,
                uid: str | None = None) -> str:
    """Send a calendar invite. Returns the UID."""
    uid = uid or f"{uuid.uuid4().hex}@{cfg.from_addr.split('@', 1)[-1]}"
    ics = build_ics(
        uid=uid,
        organizer_email=cfg.from_addr,
        organizer_name=cfg.from_name,
        attendee_email=to_email,
        title=title,
        description=body,
        start_utc=start_utc,
        duration_minutes=duration_minutes,
    )

    msg = EmailMessage()
    msg["From"] = cfg.from_header
    msg["To"] = to_email
    msg["Subject"] = title
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(body)
    msg.add_alternative(ics, subtype="calendar")
    # Hint to mail clients that this part is an invite.
    cal_part = msg.get_payload()[-1]
    cal_part.replace_header("Content-Type",
                            'text/calendar; charset="UTF-8"; method=REQUEST; name="invite.ics"')
    cal_part.add_header("Content-Disposition", 'attachment; filename="invite.ics"')

    with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=30) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        smtp.login(cfg.user, cfg.password)
        smtp.send_message(msg)

    return uid
