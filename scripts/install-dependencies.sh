#!/usr/bin/env bash
set -Eeuo pipefail

for attempt in 1 2; do
  if npm ci --no-audit --no-fund && [[ -x node_modules/.bin/prisma ]]; then
    exit 0
  fi

  if (( attempt < 2 )); then
    echo '[install] npm ci failed or left an incomplete dependency tree; retrying once.' >&2
    rm -rf -- node_modules
  fi
done

echo '[install] npm ci did not produce a complete dependency tree.' >&2
exit 1
