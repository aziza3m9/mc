"""Generate a personalized application email from a JD + your applicant profile.

The personalization is grounded in keyword matches between the JD and
your profile (verticals, tools, certs). No model call required, but if
HOOK_LLM=1 and ANTHROPIC_API_KEY are set, hooks/opener can be improved
by Claude — that integration is left as a stub.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def _strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = re.sub(r"&[a-z]+;", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def extract_matches(job: dict, applicant: dict) -> dict[str, list[str]]:
    """Find specific JD phrases that overlap with the applicant's profile."""
    desc = _strip_html(job.get("content_html", "")).lower()
    title = (job.get("title") or "").lower()
    haystack = f"{title} {desc}"

    matches: dict[str, list[str]] = {
        "verticals": [],
        "tools": [],
        "certifications": [],
        "skills": [],
    }
    for v in applicant.get("verticals_active", []):
        if v.lower() in haystack:
            matches["verticals"].append(v)
    for t in applicant.get("tools", []):
        if t.lower() in haystack:
            matches["tools"].append(t)
    for c in applicant.get("certifications", []):
        if c.lower() in haystack:
            matches["certifications"].append(c)
    for s in applicant.get("skills", []):
        if s.lower() in haystack:
            matches["skills"].append(s)
    return matches


def _company_display_name(slug: str) -> str:
    # crude but readable: "cb-insights" -> "CB Insights"
    return " ".join(p.capitalize() for p in re.split(r"[-_]", slug)) if slug else ""


def _article(word: str) -> str:
    return "an" if word and word[0].lower() in "aeiou" else "a"


def _opener(job: dict, matches: dict[str, list[str]], company: str) -> str:
    """One-line opener that earns the email."""
    role = job.get("title", "the SDR role")
    art = _article(role)
    if matches["tools"]:
        tool = matches["tools"][0]
        return (f"Saw {company}'s {role} posting lists {tool} in the stack — "
                f"that's already in my daily rhythm.")
    if matches["verticals"]:
        v = matches["verticals"][0]
        return (f"Saw {company} is hiring {art} {role} into {v}. "
                f"That vertical is in my coverage.")
    if matches["certifications"]:
        c = matches["certifications"][0]
        return (f"Saw the {role} role at {company} flags {c} as a plus. "
                f"Holding it; happy I'm in the small SDR pool that does.")
    return (f"Applying for the {role} role at {company} — "
            f"want to make the case for an interview in 130 words.")


def _bridge(applicant: dict, matches: dict[str, list[str]]) -> str:
    """One sentence connecting your stats to the job, leaning on matches."""
    current = applicant.get("current_stats",
                            "currently doing daily B2B outbound to C-level")
    matched_phrase = ""
    if matches["verticals"]:
        matched_phrase = f" Active verticals overlap: {', '.join(matches['verticals'])}."
    elif matches["tools"]:
        matched_phrase = f" Stack overlap: {', '.join(matches['tools'][:3])}."
    return f"Right now: {current}.{matched_phrase}"


def _differentiator(applicant: dict, matches: dict[str, list[str]]) -> str:
    """The one weird thing about your profile worth surfacing."""
    if matches["certifications"]:
        return (f"Background: BS in IT plus {', '.join(matches['certifications'])} "
                f"— rare combo in the SDR pool, useful for the technical sale.")
    diffs = applicant.get("differentiators") or []
    return diffs[0] if diffs else ""


def write_email(job: dict, applicant: dict) -> dict[str, str]:
    company = _company_display_name(job.get("company_slug", ""))
    role = job.get("title", "SDR")
    matches = extract_matches(job, applicant)
    opener = _opener(job, matches, company)
    bridge = _bridge(applicant, matches)
    differentiator = _differentiator(applicant, matches)

    paragraphs = [opener, bridge]
    if differentiator and differentiator not in bridge:
        paragraphs.append(differentiator)
    paragraphs.append("15-min conversation this week or next?")

    body = "Hi,\n\n" + "\n\n".join(paragraphs) + (
        f"\n\n{applicant['name']}\n"
        f"{applicant.get('phone','')} | {applicant.get('email','')} | "
        f"{applicant.get('linkedin','')}\n"
    )
    subject = f"{role} — {applicant.get('headline', applicant['name'])}"

    return {
        "subject": subject,
        "body": body,
        "matches": matches,
        "word_count": len(body.split()),
    }


def load_applicant(path: Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text())
