"""Fetch open jobs from public ATS APIs. Free, no keys.

All three ATSes (Greenhouse, Lever, Ashby) expose their job boards as
JSON if you know the URL pattern. Run from a host with normal outbound
network — most sandboxes block these hosts.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


def _fetch_json(url: str, timeout: int = 10) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "cold-stack/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} on {url}")
    except urllib.error.URLError as e:
        print(f"  network error on {url}: {e}")
    except json.JSONDecodeError:
        print(f"  invalid JSON from {url}")
    return None


def fetch_greenhouse(slug: str) -> list[dict]:
    """Jobs for boards.greenhouse.io/{slug}.

    `content=true` returns the full HTML JD so we don't need a second
    round-trip per posting.
    """
    data = _fetch_json(
        f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
    )
    if not data:
        return []
    return [
        {
            "company_slug": slug,
            "ats": "greenhouse",
            "id": str(j.get("id")),
            "title": j.get("title", ""),
            "location": (j.get("location") or {}).get("name", ""),
            "apply_url": j.get("absolute_url", ""),
            "content_html": j.get("content", ""),
            "departments": [d.get("name", "") for d in j.get("departments", [])],
            "updated_at": j.get("updated_at", ""),
            "metadata": j.get("metadata", []),
        }
        for j in (data.get("jobs") or [])
    ]


def fetch_lever(slug: str) -> list[dict]:
    """Jobs for jobs.lever.co/{slug}."""
    data = _fetch_json(f"https://api.lever.co/v0/postings/{slug}?mode=json")
    if not data:
        return []
    out = []
    for j in data:
        out.append({
            "company_slug": slug,
            "ats": "lever",
            "id": j.get("id", ""),
            "title": j.get("text", ""),
            "location": ((j.get("categories") or {}).get("location") or ""),
            "apply_url": j.get("hostedUrl", ""),
            "content_html": j.get("descriptionPlain", "") or j.get("description", ""),
            "departments": [(j.get("categories") or {}).get("department", "")],
            "updated_at": j.get("createdAt", ""),
        })
    return out


def fetch_ashby(slug: str) -> list[dict]:
    """Jobs for jobs.ashbyhq.com/{slug} via the public posting API."""
    data = _fetch_json(
        f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true"
    )
    if not data:
        return []
    out = []
    for j in (data.get("jobs") or []):
        out.append({
            "company_slug": slug,
            "ats": "ashby",
            "id": j.get("id", ""),
            "title": j.get("title", ""),
            "location": j.get("locationName", ""),
            "apply_url": j.get("jobUrl", ""),
            "content_html": j.get("descriptionHtml", ""),
            "departments": [j.get("departmentName", "")],
            "updated_at": j.get("publishedDate", ""),
        })
    return out


_FETCHERS = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
}


def fetch_all(companies: dict[str, list[str]]) -> list[dict]:
    """Walk every configured (ats, slug) pair and return the flat job list."""
    out: list[dict] = []
    for ats, slugs in companies.items():
        fetcher = _FETCHERS.get(ats)
        if not fetcher:
            print(f"  unknown ATS: {ats}")
            continue
        for slug in slugs:
            jobs = fetcher(slug)
            print(f"  {ats}:{slug} -> {len(jobs)} jobs")
            out.extend(jobs)
    return out
