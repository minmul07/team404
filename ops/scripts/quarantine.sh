#!/usr/bin/env bash
# quarantine.sh
# 감시 대상 디렉터리의 파일/폴더 권한을 잠근다.
# 사용법: ./quarantine.sh <rootPath>
# 예시:  ./quarantine.sh /tmp/demo-target
#
# stdout 출력 형식 (JS 파싱용, 탭 구분):
#   PROGRESS\t<file|dir>\t<path>\t<success|failed>

set -uo pipefail

ROOT_PATH="${1:-}"

if [ -z "$ROOT_PATH" ]; then
  echo "[quarantine.sh] ERROR: rootPath 인자가 필요합니다." >&2
  exit 1
fi

if [ ! -d "$ROOT_PATH" ]; then
  echo "[quarantine.sh] ERROR: 디렉터리가 존재하지 않습니다: $ROOT_PATH" >&2
  exit 1
fi

# 파일 -> 000 (권한 제거)
while IFS= read -r -d '' file; do
  if chmod 000 "$file" 2>/dev/null; then
    printf 'PROGRESS\tfile\t%s\tsuccess\n' "$file"
  else
    printf 'PROGRESS\tfile\t%s\tfailed\n' "$file"
  fi
done < <(find "$ROOT_PATH" -type f -print0)

# 디렉터리 -> 000 (권한 제거)
while IFS= read -r -d '' dir; do
  if chmod 000 "$dir" 2>/dev/null; then
    printf 'PROGRESS\tdir\t%s\tsuccess\n' "$dir"
  else
    printf 'PROGRESS\tdir\t%s\tfailed\n' "$dir"
  fi
done < <(find "$ROOT_PATH" -type d -print0)
