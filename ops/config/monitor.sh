#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 ]]; then
  echo "usage: monitor.sh <root> [<root> ...]" >&2
  exit 1
fi

inotifywait -m -r \
  -q \
  -e create -e modify -e delete -e moved_from -e moved_to \
  --format $'%w%f\t%e' \
  -- "$@" |
  while IFS= read -r line; do
    printf '%s\t%s\n' "$(date +%s%3N)" "$line"
  done
