"""Filter raw ATS job lists down to SDR/BDR roles in acceptable locations."""
from __future__ import annotations

import re

SDR_RE = re.compile(
    r"\b(sdr|bdr|sales\s+development|business\s+development\s+representative|"
    r"account\s+development\s+representative|sales\s+representative)\b",
    re.IGNORECASE,
)

# Words that disqualify even if the title matches (managers etc.)
DISQUALIFY_RE = re.compile(
    r"\b(manager|director|vp|head\s+of|lead|senior\s+manager)\b",
    re.IGNORECASE,
)


def is_sdr_role(job: dict) -> bool:
    title = job.get("title", "")
    return bool(SDR_RE.search(title)) and not DISQUALIFY_RE.search(title)


def location_ok(job: dict, *, remote_ok: bool = True,
                allowed_substrings: list[str] | None = None) -> bool:
    loc = (job.get("location") or "").lower()
    if not loc:
        return remote_ok  # ambiguous; allow if remote_ok
    if remote_ok and ("remote" in loc or "anywhere" in loc):
        return True
    if allowed_substrings:
        return any(sub.lower() in loc for sub in allowed_substrings)
    return True  # if no location filter given, accept all


def filter_jobs(jobs: list[dict], *, remote_ok: bool = True,
                allowed_locations: list[str] | None = None) -> list[dict]:
    return [
        j for j in jobs
        if is_sdr_role(j) and location_ok(j, remote_ok=remote_ok,
                                          allowed_substrings=allowed_locations)
    ]
