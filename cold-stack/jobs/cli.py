"""Job-application autopilot CLI.

  python -m jobs find [--remote-only] [--allowed-loc detroit michigan]
  python -m jobs draft [--limit N]
  python -m jobs enqueue --lead-id ID
  python -m jobs status

Flow:
  1. `find` pulls jobs from every ATS in jobs/companies.json, filters to
     SDR/BDR/sales-dev titles in your acceptable locations, and writes
     them to state/jobs_open.json.
  2. `draft` reads jobs_open.json + state/applicant.json, writes a
     personalized application email per job to
     state/applications/<slug>__<job_id>/draft.md.
  3. You read the drafts, edit any you want to change.
  4. `enqueue` pushes one (or all) into state/queue.json as a single-step
     send. The existing `inbox loop` ships them.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from .email_guesser import best_guess
from .filter import filter_jobs
from .sources import fetch_all
from .writer import load_applicant, write_email


def _state_dir() -> Path:
    return Path(os.environ.get(
        "COLD_STACK_STATE",
        Path(__file__).resolve().parent.parent / "state",
    ))


def _load_companies() -> dict[str, list[str]]:
    p = Path(__file__).resolve().parent / "companies.json"
    raw = json.loads(p.read_text())
    return {k: v for k, v in raw.items() if not k.startswith("_")}


def cmd_find(args: argparse.Namespace) -> int:
    print("fetching open jobs from configured ATSes...")
    jobs = fetch_all(_load_companies())
    print(f"\n{len(jobs)} total jobs fetched")
    sdr = filter_jobs(
        jobs,
        remote_ok=not args.no_remote,
        allowed_locations=args.allowed_loc or None,
    )
    print(f"{len(sdr)} match SDR/BDR + location filters\n")
    for j in sdr[:30]:
        print(f"  [{j['ats']:<10}] {j['company_slug']:<20} "
              f"{j['title']:<60} {j['location'][:30]}")
    state = _state_dir()
    state.mkdir(parents=True, exist_ok=True)
    (state / "jobs_open.json").write_text(json.dumps(sdr, indent=2) + "\n")
    print(f"\nwrote {len(sdr)} jobs → {state / 'jobs_open.json'}")
    return 0


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:60]


def cmd_draft(args: argparse.Namespace) -> int:
    state = _state_dir()
    jobs_path = state / "jobs_open.json"
    if not jobs_path.exists():
        print("no jobs_open.json — run `python -m jobs find` first", file=sys.stderr)
        return 1
    applicant = load_applicant(state / "applicant.json")
    jobs = json.loads(jobs_path.read_text())
    if args.limit:
        jobs = jobs[: args.limit]
    out_dir = state / "applications"
    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for job in jobs:
        email = write_email(job, applicant)
        slug = job["company_slug"]
        domain = args.domain_map.get(slug) if args.domain_map else None
        # default heuristic: <slug>.com (works for ~70% of companies)
        domain = domain or f"{slug}.com"
        to_address = best_guess(domain)
        d = out_dir / f"{_slug(slug)}__{_slug(job['id'])}"
        d.mkdir(parents=True, exist_ok=True)
        (d / "draft.md").write_text(
            f"# {job['title']} @ {slug}\n\n"
            f"**Apply URL:** {job.get('apply_url', '')}\n"
            f"**Location:** {job.get('location', '')}\n"
            f"**To (best guess):** `{to_address}`\n"
            f"**Subject:** {email['subject']}\n"
            f"**Word count:** {email['word_count']}\n"
            f"**JD matches:** {json.dumps(email['matches'])}\n\n"
            f"---\n\n{email['body']}\n"
        )
        (d / "meta.json").write_text(json.dumps({
            "company_slug": slug,
            "job_id": job["id"],
            "to": to_address,
            "subject": email["subject"],
            "apply_url": job.get("apply_url", ""),
        }, indent=2) + "\n")
        written += 1
        print(f"  drafted {slug} :: {job['title']}  →  {d.name}")
    print(f"\nwrote {written} drafts → {out_dir}/")
    print("\nNext: open the draft.md files. Edit any you want. Then:")
    print(f"  python -m jobs enqueue --slug <company-slug>")
    return 0


def cmd_enqueue(args: argparse.Namespace) -> int:
    """Push a drafted application into the inbox send queue."""
    state = _state_dir()
    matching = []
    for d in (state / "applications").iterdir() if (state / "applications").exists() else []:
        if not (d / "meta.json").exists() or not (d / "draft.md").exists():
            continue
        meta = json.loads((d / "meta.json").read_text())
        if args.slug and meta["company_slug"] != args.slug:
            continue
        matching.append((d, meta))
    if not matching:
        print(f"no draft found for slug={args.slug!r}", file=sys.stderr)
        return 1

    from inbox.queue import append_log, load_queue, save_queue

    queue = load_queue(state)
    for d, meta in matching:
        # The draft.md body sits after the '---' marker.
        body_text = (d / "draft.md").read_text().split("\n---\n\n", 1)[-1]
        lead_id = f"job-{meta['company_slug']}-{meta['job_id']}"
        queue[lead_id] = {
            "lead_id": lead_id,
            "stage": "pitch",
            "checker": {"verdict": "pass"},
            "send": {
                "channel": "email",
                "to": meta["to"],
                "first_send_at": None,
                "paused_for_reply": False,
                "bounced": False,
                "opted_out": False,
                "sequence": [{
                    "step": 1,
                    "delay_days": 0,
                    "subject": meta["subject"],
                    "body": body_text.strip(),
                    "sent_at": None,
                    "message_id": None,
                }],
                "replies": [],
            },
            "job": meta,
        }
        append_log(state, "jobs", "enqueued", lead_id,
                   f"{meta['subject']} to {meta['to']}")
        print(f"  enqueued {lead_id} → {meta['to']}")
    save_queue(state, queue)
    print(f"\n{len(matching)} application(s) in send queue. "
          f"Start `python -m inbox loop` and they'll ship on the next tick.")
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    state = _state_dir()
    out: dict = {"jobs_open": 0, "drafts": 0, "enqueued": 0}
    p = state / "jobs_open.json"
    if p.exists():
        out["jobs_open"] = len(json.loads(p.read_text()))
    apps = state / "applications"
    if apps.exists():
        out["drafts"] = sum(1 for d in apps.iterdir() if (d / "draft.md").exists())
    q = state / "queue.json"
    if q.exists():
        out["enqueued"] = sum(
            1 for v in json.loads(q.read_text()).values()
            if v.get("lead_id", "").startswith("job-")
        )
    print(json.dumps(out, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="jobs")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("find")
    f.add_argument("--no-remote", action="store_true",
                   help="exclude remote-only roles")
    f.add_argument("--allowed-loc", nargs="*", default=None,
                   help="location substrings to allow (e.g. detroit michigan)")
    f.set_defaults(func=cmd_find)

    d = sub.add_parser("draft")
    d.add_argument("--limit", type=int, default=None)
    d.add_argument("--domain-map", type=lambda s: json.loads(s), default={},
                   help='JSON map of slug→domain, e.g. \'{"cbinsights":"cbinsights.com"}\'')
    d.set_defaults(func=cmd_draft)

    e = sub.add_parser("enqueue")
    e.add_argument("--slug", default=None,
                   help="enqueue only drafts for this company slug; omit to enqueue all")
    e.set_defaults(func=cmd_enqueue)

    sub.add_parser("status").set_defaults(func=cmd_status)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
