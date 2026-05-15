"""Guess hiring-contact emails for a company domain.

Strategy, from most to least likely:
1. Hunter.io's dominant pattern if HUNTER_API_KEY is set (free 25/mo)
2. Standard catch-all addresses: careers@, jobs@, recruiting@, talent@
3. Common name patterns if you know a person to address

No paid APIs required — Hunter is the only optional integration.
"""
from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request

CATCH_ALL_LOCAL = ["careers", "jobs", "recruiting", "talent", "hello"]


def patterns_for_name(full_name: str, domain: str) -> list[str]:
    """Generate likely email addresses for a person at a domain."""
    parts = [p for p in re.split(r"\s+", full_name.strip().lower()) if p]
    if not parts:
        return []
    if len(parts) == 1:
        first = parts[0]
        return [f"{first}@{domain}"]
    first, last = parts[0], parts[-1]
    fi, li = first[0], last[0]
    # dict.fromkeys preserves order, dedupes
    return list(dict.fromkeys([
        f"{first}.{last}@{domain}",
        f"{first}@{domain}",
        f"{fi}{last}@{domain}",
        f"{first}{li}@{domain}",
        f"{first}{last}@{domain}",
        f"{first}_{last}@{domain}",
        f"{last}.{first}@{domain}",
        f"{last}@{domain}",
    ]))


def catch_all(domain: str) -> list[str]:
    return [f"{p}@{domain}" for p in CATCH_ALL_LOCAL]


def hunter_pattern(domain: str) -> str | None:
    """Return the company's dominant email pattern, e.g. '{first}.{last}'.

    Costs 1 Hunter credit per call. Free tier = 25/month.
    """
    key = os.environ.get("HUNTER_API_KEY")
    if not key:
        return None
    url = (f"https://api.hunter.io/v2/domain-search?"
           f"domain={urllib.parse.quote(domain)}&api_key={key}")
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"  hunter error: {e}")
        return None
    return ((data or {}).get("data") or {}).get("pattern")


def apply_pattern(pattern: str, full_name: str, domain: str) -> str | None:
    """Apply a Hunter-style pattern ('{first}.{last}') to a name."""
    parts = [p for p in re.split(r"\s+", full_name.strip().lower()) if p]
    if not parts:
        return None
    first = parts[0]
    last = parts[-1] if len(parts) > 1 else ""
    fi = first[0]
    li = last[0] if last else ""
    try:
        local = (pattern
                 .replace("{first}", first)
                 .replace("{last}", last)
                 .replace("{f}", fi)
                 .replace("{l}", li))
    except Exception:
        return None
    return f"{local}@{domain}"


def guess_for_job(domain: str, hiring_manager_name: str | None = None) -> dict[str, list[str]]:
    """Return ranked dict {tier: [emails]} from best to worst guess."""
    out: dict[str, list[str]] = {}
    if hiring_manager_name:
        pat = hunter_pattern(domain)
        if pat:
            email = apply_pattern(pat, hiring_manager_name, domain)
            if email:
                out["hunter_verified_pattern"] = [email]
        out["name_patterns"] = patterns_for_name(hiring_manager_name, domain)
    out["catch_all"] = catch_all(domain)
    return out


def best_guess(domain: str, hiring_manager_name: str | None = None) -> str:
    """The single best address to actually send to."""
    tiers = guess_for_job(domain, hiring_manager_name)
    for tier in ("hunter_verified_pattern", "name_patterns", "catch_all"):
        if tier in tiers and tiers[tier]:
            return tiers[tier][0]
    return f"careers@{domain}"
