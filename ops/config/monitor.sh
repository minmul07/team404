#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 ]]; then
  echo "usage: monitor.sh <root> [<root> ...]" >&2
  exit 1
fi

exec inotifywait -m -r \
  -q \
  -e create -e modify -e delete -e moved_from -e moved_to \
  --timefmt '%s' \
  --format $'%T\t%w%f\t%e' \
  -- "$@"
