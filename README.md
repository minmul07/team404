# 팀명: 404

#### 조원
- 어승경 (2023203068), 팀장
- 정시은 (2025404032)
- 방주현 (2025403033)
- 정연진 (2025404018)
- 염도윤 (2026403019)

# 프로젝트 정보
### Linux 기반 랜섬웨어 의심 파일 행위 감시 및 자동 격리 시스템

Linux 환경에서 특정 디렉터리 및 파일 시스템 이벤트를 감시하고, 랜섬웨어와 유사한 비정상 파일 행위가 발생했을 때 이를 탐지하여 자동으로 기록·격리하는 시스템입니다.

데모 시에는, 실제 랜섬웨어를 제작하거나 실행하는 것이 아니라, 짧은 시간 내 대량 파일 수정, 확장자 일괄 변경, 파일명 급변, 특정 디렉터리의 과도한 쓰기 작업 등 랜섬웨어와 유사한 행동 패턴을 모의하여 탐지하는 방식으로 구현됩니다.

### 핵심 기능
1. Linux 파일 시스템 이벤트 감시
2. 짧은 시간 내 대량 수정/생성/이름 변경 탐지
3. 랜섬웨어 유사 행위 발생 시 로그 저장
4. 의심 행위 탐지 시 감시 대상 디렉터리에 대한 접근 권한을 일시적으로 제한하여 격리
5. 격리 결과를 웹 대시보드에 표시 및 로그에 기록
6. 시뮬레이션을 통한 탐지 데모 구성

### 판단 기준
- 일정 시간 내 다수 파일의 수정·생성·이름 변경 이벤트가 임계치를 초과할 경우 이상 행위로 판단
- 특정 확장자로의 일괄 변경, 짧은 시간 내 반복적 쓰기 작업, 다수 파일명 변경 등을 탐지 기준으로 사용

## 역할 분배
### 어승경 (팀장)
- 프로젝트 전체 구조 및 시스템 흐름 설계
- Linux 기반 디렉터리 및 파일 감시 시스템 설계·구현
- 각 모듈 간 연동 구조 조정 및 개발 총괄
- 최종 발표 자료 구성 및 발표 진행

### 정시은
- 의심 행위 발생 시 적용할 권한 제어 및 격리 방식 설계
- 감시 대상 디렉터리에 대한 접근 권한 변경 기능 구현
- 탐지 시스템과 연계된 자동 격리 로직 구현

### 방주현
- 시스템 상태 및 탐지 결과를 시각화하는 대시보드 설계·구현
- 파일 감시 시스템과 권한 제어 시스템에서 전달된 이벤트 정보를 화면에 표시
- 로그 및 탐지 결과의 사용자 친화적 표현 방식 구성

### 정연진
- 랜섬웨어 유사 행위를 재현하는 데모 프로그램 설계·구현
- 특정 디렉터리 내 파일들에 대해 Base64 인코딩, 파일명 변경 등 모의 행위 구성
- 탐지 시스템이 동작하는 시나리오 및 데모 절차 구성

### 염도윤
- 프로젝트 전반의 문서화 담당
- 감시 시스템, 권한 제어 시스템, 대시보드, 데모 프로그램 간 동작 흐름 정리
- 개발 내용, 실행 방법, 역할 분담, 시연 절차 등의 문서 작성 및 관리
## 차별점 및 개선점
- 단순 백신 흉내가 아니라 Linux 파일 시스템 이벤트를 직접 활용합니다.
- 감시 → 탐지 → 기록 → 격리까지 이어지는 랜섬웨어에 대한 1차적 대응 흐름을 구현할 수 있습니다.
- 웹 대시보드를 결합하여 현재의 시스템 상태를 쉽게 확인할 수 있습니다.

## MVP 이후의 추가 개선 방안
- 파일 해시 기반 이상 탐지 추가
- 디렉터리별 민감도 설정
- 관리자 알림 기능 추가
- 탐지 기준 정교화로 오탐 감소

-------------------------------------------------------------------------------------------------------------------------------------------------------------------

# 팀명: 404

## 조원
- 어승경 (2023203068), 팀장
- 정시은 (2025404032)
- 방주현 (2025403033)
- 정연진 (2025404018)
- 염도윤 (2026403019)

---

# 프로젝트 정보

## Linux 기반 랜섬웨어 의심 파일 행위 감시 및 자동 격리 시스템

Linux 환경에서 특정 디렉터리 및 파일 시스템 이벤트를 감시하고,
랜섬웨어와 유사한 비정상 파일 행위가 발생했을 때 이를 탐지하여
자동으로 기록 및 격리를 수행하는 시스템입니다.

실제 랜섬웨어를 실행하는 방식이 아니라,
짧은 시간 내 다량의 파일 수정·생성·삭제·이름 변경 등의 행동 패턴을 기반으로
랜섬웨어와 유사한 행위를 탐지하는 방식으로 구현됩니다.

---

# 핵심 기능

- Linux 파일 시스템 이벤트 감시
- create / modify / delete / rename 이벤트 수집
- threshold 기반 이상 행위 탐지
- 랜섬웨어 유사 행위 발생 시 incident 생성 및 alert 기록
- autoQuarantine 기반 자동 격리 수행
- 파일 및 디렉터리 권한 잠금 기능 구현
- restore 기반 권한 복구 기능 구현
- REST API 기반 시스템 상태 조회 지원
- demo 모드 기반 시뮬레이션 지원
- 웹 대시보드 연동 지원
- console logger 기반 이벤트 출력 지원

---

# 판단 기준

다음 조건을 기반으로 이상 행위를 탐지합니다.

- 일정 시간(windowMs) 내 특정 이벤트 수(threshold) 초과
- 짧은 시간 내 다수 파일 modify 발생
- 짧은 시간 내 다수 파일 create 발생
- 짧은 시간 내 다수 파일 delete 발생
- moved_from + moved_to 기반 rename 이벤트 탐지
- 특정 디렉터리 대상 반복적 파일 변경 행위 탐지

탐지 시 severity 및 autoQuarantine 설정을 기반으로 incident를 생성합니다.

---

# 프로젝트 구조

## ops/

Linux 기반 파일 감시 및 권한 제어 스크립트

### monitor.sh
- inotifywait 기반 파일 이벤트 감시 수행
- create / modify / delete / move 이벤트 수집
- timestamp 및 이벤트 로그 출력

### quarantine.sh
- 감시 대상 디렉터리 권한 잠금 수행
- 파일 권한 → 400
- 디렉터리 권한 → 500

### restore.sh
- 격리된 디렉터리 권한 복원 수행
- 파일 권한 → 644
- 디렉터리 권한 → 755

### app-config.json
- monitor / rules / server 설정 관리
- threshold 및 autoQuarantine 설정 포함

---

## src/collector

파일 이벤트 수집 및 정규화 처리

### monitor-event-parser.js
- monitor.sh 출력 파싱
- rename 이벤트 정규화
- moved_from + moved_to 이벤트 병합 처리

### monitor-service.js
- monitor 프로세스 실행 및 관리
- FS_EVENT 생성
- demo 모드 및 targetPath 변경 지원
- monitor 재시작 처리 지원

---

## src/rules

랜섬웨어 의심 행위 탐지 엔진

### rule-engine.js
- threshold 기반 이상 행위 탐지
- RULE_MATCH 이벤트 생성
- severity 및 autoQuarantine 처리
- cooldown 기반 중복 탐지 방지

---

## src/incidents

incident 및 alert 상태 관리

### incident-store.js
- RULE_MATCH 기반 incident 생성
- alert 저장
- active incident 관리
- severity 우선순위 처리

---

## src/isolation

자동 격리 및 복구 처리

### quarantine-service.js
- INCIDENT_OPENED 기반 자동 격리 수행
- 권한 저장 및 복구 처리
- quarantine 및 restore 이벤트 관리

---

## src/app

프로젝트 runtime 관리

### console-event-logger.js
- 콘솔 기반 FS_EVENT 출력

### runtime-options.js
- CLI 실행 옵션 처리
- --demo / --without-dashboard / --config 지원

### runtime.js
- MonitorService / RuleEngine / IncidentStore / QuarantineService 연결
- 시스템 runtime 관리
- snapshot 및 health 상태 제공

---

## src/server

REST API 서버

### create-api-server.js
- HTTP API 서버 구현
- health / incidents / alerts / snapshot API 제공
- demo 및 restore API 처리

### server.js
- 프로젝트 메인 실행 파일
- runtime 초기화
- monitor 시작 및 종료 관리
- API 서버 실행

---

# 내부 API 구조

```js
export const API_ROUTES = Object.freeze({
  SNAPSHOT: '/api/snapshot',
  INCIDENTS: '/api/incidents',
  HEALTH: '/api/health',
  ALERTS: '/api/alerts',
  QUARANTINE_JOBS: '/api/quarantine-jobs',
  DEMO_START: '/api/demo/start',
  DEMO_STOP: '/api/demo/stop',
  WATCH_TARGET: '/api/watch/target'
});

# 실행 조건 (WIP)
- `bash` 5 버전 이상
- `npm run dev`
    - `--demo`: 데모 모드를 활성화하여 시작합니다. 활성화 시 프로젝트 구조의 `.tmp/demo-target/`이 감시 대상이 됩니다
    - `--without-dashboard` 발생한 이벤트를 `npm` 로그에 출력합니다.
- `npm run dev -- --without-dashboard --demo`
