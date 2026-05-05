#!/usr/bin/env bash
# restore.sh
# 격리된 디렉터리의 파일/폴더 권한을 기본값으로 복원한다.
# 사용법: ./restore.sh <rootPath>
# 예시: ./restore.sh /tmp/watch
#
# 주의: 이 스크립트는 원래 권한을 모를 때 쓰는 fallback용입니다.
# 실제 복원은 quarantine-service.js의 restore() 메서드가 저장한 권한을 사용합니다.

set -euo pipefail

ROOT_PATH="${1:-}"

if [ -z "$ROOT_PATH" ]; then
  echo "[restore.sh] ERROR: rootPath 인자가 필요합니다." >&2
  exit 1
fi

if [ ! -d "$ROOT_PATH" ]; then
  echo "[restore.sh] ERROR: 디렉터리가 존재하지 않습니다: $ROOT_PATH" >&2
  exit 1
fi

echo "[restore.sh] 권한 복원 시작: $ROOT_PATH"

# 파일 -> 644 (기본 파일 권한)
find "$ROOT_PATH" -type f -exec chmod 644 {} \;

# 디렉터리 -> 755 (기본 디렉터리 권한)
find "$ROOT_PATH" -type d -exec chmod 755 {} \;

echo "[restore.sh] 권한 복원 완료: $ROOT_PATH"