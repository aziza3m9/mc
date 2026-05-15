#!/usr/bin/env bash
set -euo pipefail

# Initialize empty state files if missing. Safe to re-run.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

mkdir -p state clients

[ -f state/queue.json ]  || echo '{}' > state/queue.json
[ -f state/leases.json ] || echo '{}' > state/leases.json
[ -f state/log.jsonl ]   || : > state/log.jsonl

echo "cold-stack initialized at $here"
