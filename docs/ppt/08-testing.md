# 08. 테스트 커버리지

## 테스트 프레임워크

Team 404의 랜섬웨어 감시 시스템은 외부 테스트 프레임워크 없이 Node.js 내장 테스트 러너만을 사용합니다.

- **테스트 러너**: `node:test` (Node.js 20+ 내장)
- **어서션**: `node:assert/strict`
- **실행 명령**: `node --test test/*.test.js`
- **외부 의존성**: 테스트 관련 npm 패키지 없음 (Jest, Vitest, Mocha 등 미사용)

이 방식은 프로젝트의 "제로 외부 의존성" 철학과 일치하며, 별도 설치 없이 `npm test`로 즉시 실행할 수 있습니다.

---

## 테스트 파일 목록

총 12개 테스트 파일, 약 3,200여 줄의 테스트 코드가 `test/` 디렉터리에 있습니다.

### 1. `test/runtime.test.js`

Runtime 전체 생명주기와 정책 관리를 검증합니다.

- 데모 모드 진입 시 `activeMode='demo'` 및 데모 타겟 경로 설정
- 기본 응답 정책이 "디렉터리 권한 잠금만"으로 설정됨
- 응답 정책 업데이트 (killSuspectProcesses, shutdownSystem 단계별 누적)
- 격리 범위(`quarantineScope`)를 `incident-target`에서 `all-watch-targets`로 변경
- 데모 파일 개수 설정 변경 및 스냅샷 반영
- `resetDemo` 시 누적 rule weight 초기화
- 데모 리셋 중 모니터링 일시 중지 및 재개
- 이미 중지된 상태에서 데모 리셋 시 모니터링 재시작 안 함
- 탐지 정책 업데이트 및 `app-config.json` 영속화
- 탐지 정책 기본값 복원 및 영속화
- 스냅샷 내 재귀적 파일 개수 계산 (단일/다중 타겟)
- `setTargetPaths`로 모니터 타겟 변경 및 설정 파일 저장
- 데모 워커 시작, FS_EVENT 재발행, 차단/종료/중단 메시지 처리
- 데모 진행 중 격리 상태 보존

### 2. `test/create-api-server.test.js`

REST API 서버와 WebSocket 브로드캐스트를 검증합니다.

- `POST /api/demo/start`로 데모 시작
- `GET /api/health`로 런타임 상태 조회
- `POST /api/demo/stop`로 데모 중단
- `GET /api/settings/demo`로 데모 설정 조회
- `PUT /api/settings/demo`로 데모 파일 개수 변경
- `PUT /api/settings/monitor`로 백엔드 모드 변경 (`auto`/`auditd`/`inotify`)
- 잘못된 백엔드 모드(`fanotify`) 요청 거부
- `POST /api/watch/target`으로 단일/다중 감시 경로 변경
- 기본 감시 경로 복원 (`restoreDefault`)
- 중복 감시 경로 요청 거부
- `GET /api/settings/response-policy` 및 `PUT /api/settings/response-policy` 응답 정책 조회/변경
- shutdown 정책의 누적 단계 정규화
- 격리 범위 변경
- 잘못된 응답 정책(불리언 아닌 값) 거부
- `GET /api/settings/detection-policy` 및 `PUT /api/settings/detection-policy` 탐지 정책 조회/변경
- `POST /api/settings/detection-policy/reset` 탐지 정책 초기화
- 잘못된 탐지 정책(음수 가중치) 거부
- WebSocket 업그레이드 및 런타임 이벤트 브로드캐스트 (FS_EVENT, QUARANTINE_STARTED, QUARANTINE_FAILED, RULE_WEIGHT_UPDATED, DEMO_LOG)

### 3. `test/quarantine-service.test.js`

격리 서비스의 동작과 안전 범위를 검증합니다.

- `fuser -m` 같은 마운트 전체 정리 명령 미사용 확인 (소스 코드 정적 검사)
- 격리 작업 시작 전 시스템 종료 요청이 의심 프로세스 킬 이전에 실행되는 순서 확인
- 1단계(earlyKill)가 권한 잠금 이전에 시작되고, 2단계(suspectKill)가 PID 스캔 이후에 실행되는 순서 확인
- 의심 프로세스 메타데이터 기반 안전한 킬 (현재 서버 프로세스는 제외)
- 데모 타겟(`demo-target`) 외 경로에 대한 의심 프로세스 킬 무시 (안전 범위 제한)

### 4. `test/monitor-service.test.js`

모니터 서비스의 백엔드 선택과 모드 전환을 검증합니다.

- 설정된 모든 타겟을 기본으로 사용
- 데모 모드 전환 (`demo` 플래그)
- 단일/다중 명시적 타겟 경로 전환
- 데모 모드 토글 (켜기/끄기)
- 타겟 경로 변경 후 기본 설정 복원
- `auto` 모드에서 `auditd` 백엔드 자동 선택
- `auto` 모드에서 `auditd` 실패 시 `inotify`로 폴백
- `auditd` 모드에서 실패 시 폴백 없이 `degraded` 상태 유지
- 백엔드 모드 변경 시 기존 백엔드 중지 및 새 백엔드 시작

### 5. `test/monitor-event-parser.test.js`

이벤트 파서와 정규화를 검증합니다.

- `parseMonitorLine`이 밀리초/초 단위 타임스탬프를 모두 정규화
- `MonitorEventNormalizer`가 `MOVED_FROM` + `MOVED_TO`를 `rename`으로 페어링
- 동일 타겟 내 디렉터리 간 이동도 `rename`으로 페어링
- `AuditdEventNormalizer`가 PID, ppid, uid, comm, exe, cwd 등 메타데이터 추출
- 불완전한 auditd 이벤트는 `flushAll` 시 폐기
- auditd `DELETE` + `CREATE` PATH 레코드를 `rename`으로 매핑

### 6. `test/incident-store.test.js`

인시던트 저장소의 병합과 초기화를 검증합니다.

- `RULE_MATCH` 이벤트의 풍부한 필드(ruleName, severity, autoQuarantine, suspectProcesses 등)가 인시던트에 보존됨
- 동일 인시던트 내 여러 rule match 병합 (ruleMatches, totalObservedEvents, eventTypes, suspectProcesses 누적)
- 심각도 우선순위 유지 (`critical`이 `high`보다 우선)
- `clear()`로 인시던트, 알림, 격리 작업 전체 삭제

### 7. `test/rule-engine.test.js`

탐지 엔진의 가중치 버스트와 임계값을 검증합니다.

- 확장자 가중치 버스트 (`extension-weight-burst`) 임계값 초과 시 `RULE_MATCH` 발생
- 임계값 이상 상태에서 추가 이벤트는 중복 매치 방지 (버킷당 1회)
- 설정된 임계값(`thresholdWeight`) 적용 (기본 10, 커스텀 12)
- 이벤트 배수(`eventMultipliers`) 적용 (`rename` 배수 2.0 시 3개로 매치)
- `create`/`modify`/`rename`은 집계, `delete`는 무시
- 타겟별 버킷 독립 유지 (alpha/beta 각각 별도 집계)
- `resetWeights()`로 누적 가중치 초기화 및 zero 업데이트 이벤트 발생
- `applyWeightDecay()`로 버킷 가중치 감소 (설정된 interval/amount 적용)

### 8. `test/load-app-config.test.js`

애플리케이션 설정 로딩과 정규화를 검증합니다.

- 설정 파일의 모니터 타겟을 런타임 모드 오버라이드 없이 유지
- 레거시 threshold 정규화 미적용 확인 (rules 배열 유지)
- 탐지 정책 정규화 (thresholdWeight, weights, eventMultipliers, weightDecay, userAllowedExtensions, suspiciousExtensions)
- 데모 파일 개수 설정 정규화

### 9. `test/extension-weight-loader.test.js`

확장자 분류와 가중치 로딩을 검증합니다.

- 일반 확장자(`txt`, `sh`, `zip`, `exe`, `3ds`)는 기본 가중치 0.1 적용
- 커스텀 오버라이드로 기본값 대체 (`zip`을 0.9로, `md`를 0.05로)
- 미등록/빈/undefined 확장자는 unknown 가중치 1.0 적용
- 사용자 허용 목록, 의심 확장자, 이벤트 배수 정책 적용
- `getEventMultiplier`로 이벤트 타입별 배수 반환

### 10. `test/runtime-options.test.js`

CLI 옵션 파싱을 검증합니다.

- `--config <path>`로 설정 파일 경로 읽기
- 알 수 없는 인수(`--unknown`)는 경고 출력 후 무시

### 11. `test/watch-toggle.test.js`

감시 시작/중지 흐름과 API를 검증합니다.

- `runtime.startWatch()`로 모니터 서비스 시작
- `runtime.stopWatch()`로 모니터 서비스 중지
- `POST /api/watch/toggle`로 감시 켜기/끄기
- 연속 토글 시 충돌 없음 (중복 시작/중지 방지)
- 감시 중지 상태에서도 API(health 등) 정상 응답

### 12. `test/integration.test.js`

엔드투엔드 통합 흐름을 검증합니다.

- 탐지 → 격리 → 복구 전체 흐름
  - 11개의 `modify` 이벤트 발생으로 `RULE_MATCH` → `INCIDENT_OPENED` → `QUARANTINE_STARTED` → `QUARANTINE_COMPLETED` 이벤트 연쇄 확인
  - 격리 완료 시 파일/디렉터리 개수 및 권한 항목 수 검증
  - `restoreIncident()`로 복구 시 `RESTORE_COMPLETED` 발생 및 인시던트 상태 `restored` 변경
  - `.demo.locked` 파일은 Base64 인코딩 상태로 유지, 원본 파일은 삭제됨
- `all-watch-targets` 격리 범위 통합
  - 다중 타겟 중 한 곳에서 탐지 시 모든 타겟 격리
  - 복구 시에도 모든 타겟 권한 복원

---

## 테스트 대비 프로덕션 코드 비율

| 구분 | 파일 수 | 코드 줄 수 (대략) |
|------|--------|------------------|
| 테스트 (`test/*.test.js`) | 12개 | 3,247줄 |
| 프로덕션 (`src/**/*.js`) | 20여개 | 4,961줄 |
| **비율** | — | **약 0.65 : 1** |

테스트 코드는 프로덕션 코드 대비 약 65% 수준입니다. 핵심 모듈(런타임, API 서버, 격리, 모니터, 파서, 인시던트, 룰 엔진)은 테스트가 집중되어 있으나, 일부 UI 및 셸 스크립트 영역은 수동 검증에 의존합니다.

---

## 커버리지 맵

### 테스트된 영역

| 모듈 | 테스트 파일 | 주요 검증 항목 |
|------|----------|--------------|
| Runtime 생명주기 | `test/runtime.test.js` | 데모 모드, 정책 CRUD, 데모 리셋, 파일 카운트, 타겟 경로 설정 |
| API 서버 | `test/create-api-server.test.js` | 라우팅, JSON 요청/응답, 정책 유효성 검사, WebSocket 브로드캐스트 |
| 격리 서비스 | `test/quarantine-service.test.js` | 권한 잠금 순서, 안전한 프로세스 킬, 데모 타겟 범위 제한 |
| 모니터 서비스 | `test/monitor-service.test.js` | 백엔드 선택(auto/auditd/inotify), 폴백, 모드 전환, 재시작 |
| 이벤트 파서 | `test/monitor-event-parser.test.js` | inotifywait 출력 파싱, rename 페어링, auditd 정규화, 불완전 이벤트 폐기 |
| 인시던트 저장소 | `test/incident-store.test.js` | 인시던트 병합, 심각도 우선순위, 알림, clear |
| 룰 엔진 | `test/rule-engine.test.js` | 가중치 버스트, 임계값, 이벤트 배수, 감소, 초기화, 타겟별 버킷 |
| 설정 로딩 | `test/load-app-config.test.js` | 설정 정규화, 탐지 정책, 데모 설정 |
| 확장자 가중치 | `test/extension-weight-loader.test.js` | 확장자 분류, 커스텀 오버라이드, 허용 목록, 배수 |
| CLI 옵션 | `test/runtime-options.test.js` | `--config` 파싱, 알 수 없는 인수 무시 |
| 감시 토글 | `test/watch-toggle.test.js` | start/stop 흐름, API 토글, 연속 토글 안정성 |
| 통합 흐름 | `test/integration.test.js` | 탐지→격리→복구 E2E, 다중 타겟 격리/복구 |

### 테스트되지 않은 / 수동 검증 영역

| 영역 | 이유 |
|------|------|
| `public/app.js` (프론트엔드 대시보드) | 브라우저 기반 UI는 수동 시연으로 검증 |
| `ops/*.sh` (셸 스크립트) | `inotifywait`, `auditd`, `chmod` 등은 OS 의존적이며 통합 테스트에서 간접 검증 |
| `src/simulator/demo.js` | 통합 테스트에서 간접적으로 사용, 단위 테스트는 `runtime.test.js`의 데모 워커 테스트로 대체 |
| WebSocket 핸드셰이크 프레임 파싱 | `create-api-server.test.js`에서 프레임 디코딩은 테스트 더블로 검증, 실제 브라우저 연결은 수동 확인 |
| 실제 `auditd` 백엔드 | `auditd`가 설치된 환경이 아니면 실행 불가. 테스트에서는 팩토리 더블로 동작 검증 |

---

## 주요 테스트 시나리오 요약

1. **랜섬웨어 유사 행위 탐지**: 11개의 의심 확장자 파일 수정 이벤트를 발생시켜 `RULE_MATCH` → `INCIDENT_OPENED` → 자동 격리까지 연결되는지 확인 (`test/integration.test.js`, `test/rule-engine.test.js`)
2. **백엔드 폴백**: `auditd`를 선호하지만 실패 시 `inotify`로 자동 전환, PID 추적 가용성 변화 확인 (`test/monitor-service.test.js`)
3. **격리 안전성**: 현재 서버 프로세스는 킬 대상에서 제외하고, 데모 타겟 외 경로는 격리/킬 대상에서 제외 (`test/quarantine-service.test.js`)
4. **정책 영속성**: 탐지/응답 정책 변경이 `app-config.json`에 저장되고, 기본값 복원도 파일에 반영됨 (`test/runtime.test.js`, `test/load-app-config.test.js`)
5. **이벤트 정규화**: `inotifywait`의 `MOVED_FROM`/`MOVED_TO`를 `rename`으로 병합, `auditd`의 불완전 레코드는 폐기 (`test/monitor-event-parser.test.js`)
6. **실시간 대시보드**: WebSocket을 통해 FS_EVENT, 격리 시작/실패, 가중치 변화, 데모 로그가 브로드캐스트됨 (`test/create-api-server.test.js`)
