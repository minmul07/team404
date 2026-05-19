#!/usr/bin/env bash
# restore.sh
# 단일 파일/폴더의 권한을 원래 모드로 복원한다.
# 사용법: ./restore.sh <filePath> <mode>
# 예시:  ./restore.sh /tmp/demo-target/secret.txt 644
#
# stdout 출력 형식 (JS 파싱용):
#   RESTORED\t<path>\t<mode>\tsuccess
#   RESTORED\t<path>\t<mode>\tfailed

set -uo pipefail

FILE_PATH="${1:-}"
MODE="${2:-}"

if [ -z "$FILE_PATH" ] || [ -z "$MODE" ]; then
  echo "[restore.sh] ERROR: filePath와 mode 인자가 필요합니다." >&2
  echo "[restore.sh] 사용법: restore.sh <filePath> <mode>" >&2
  exit 1
fi

if [ ! -e "$FILE_PATH" ]; then
  printf 'RESTORED\t%s\t%s\tfailed\n' "$FILE_PATH" "$MODE"
  exit 1
fi

if chmod "$MODE" "$FILE_PATH" 2>/dev/null; then
  printf 'RESTORED\t%s\t%s\tsuccess\n' "$FILE_PATH" "$MODE"
else
  printf 'RESTORED\t%s\t%s\tfailed\n' "$FILE_PATH" "$MODE"
  exit 1
fi
