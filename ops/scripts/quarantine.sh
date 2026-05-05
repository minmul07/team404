#!/usr/bin/env bash
# quarantine.sh
# 감시 대상 디렉터리의 파일/폴더 권한을 잠근다.
# 사용법: ./quarantine.sh <rootPath>
# 예시: ./quarantine.sh /tmp/watch

set -euo pipefail

ROOT_PATH="${1:-}"

if [ -z "$ROOT_PATH" ]; then
  echo "[quarantine.sh] ERROR: rootPath 인자가 필요합니다." >&2
  exit 1
fi

if [ ! -d "$ROOT_PATH" ]; then
  echo "[quarantine.sh] ERROR: 디렉터리가 존재하지 않습니다: $ROOT_PATH" >&2
  exit 1
fi

echo "[quarantine.sh] 파일 권한 잠금 시작: $ROOT_PATH"

# 파일 -> 400 (읽기 전용, 소유자만)
find "$ROOT_PATH" -type f -exec chmod 400 {} \;

# 디렉터리 -> 500 (읽기+실행, 소유자만 / 쓰기 불가)
find "$ROOT_PATH" -type d -exec chmod 500 {} \;

echo "[quarantine.sh] 권한 잠금 완료: $ROOT_PATH"