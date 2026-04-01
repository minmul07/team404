# 팀 정보
## 팀명: 404

## 조원
- 어승경 (2023203068), 팀장
- 정시은 (2025404032)
- 방주현 (2025403033)
- 정연진 (2025404018)
- 염도윤 (2026403019)

# 프로젝트 정보
# Linux 기반 랜섬웨어 의심 파일 행위 감시 및 자동 격리 시스템

본 프로젝트는 Linux 환경에서 특정 디렉터리 및 파일 시스템 이벤트를 감시하고,
랜섬웨어로 의심되는 비정상 파일 행위가 발생했을 때 이를 탐지하여 자동으로 기록·격리하는 시스템을 구현하는 것을 목표로 한다.

실제 랜섬웨어를 제작하거나 실행하는 것이 아니라,
짧은 시간 내 대량 파일 수정, 확장자 일괄 변경, 파일명 급변, 특정 디렉터리의 과도한 쓰기 작업 등
랜섬웨어와 유사한 행동 패턴을 모의하여 탐지하는 방식으로 구현한다.

핵심 기능은 다음과 같다.

1. Linux 파일 시스템 이벤트 감시
2. 짧은 시간 내 대량 수정/생성/이름 변경 탐지
3. 랜섬웨어 의심 행위 발생 시 로그 저장
4. 의심 프로세스 또는 작업 자동 격리
5. 격리 결과를 웹 화면 또는 로그 화면에 표시
6. 시뮬레이션을 통한 탐지 데모 구성

## 역할 분배
### 어승경
- 팀장 및 전체 구조 설계
- 감시 엔진 핵심 로직 구현
- 탐지 기준 설계 및 통합
- 최종 발표 총괄

### 정시은
- 랜섬웨어 의심 행위 시나리오 조사 및 정리
- 테스트용 파일 변조 시뮬레이터 작성 보조
- 데모 흐름 문서화

### 방주현
- 파일 이벤트 수집 모듈 구현
- 탐지 조건(대량 수정, 확장자 변경 등) 로직 구현
- 로그 저장 형식 정리

### 정연진
- 탐지 현황 표시용 웹 페이지 또는 대시보드 구현
- 시간대별 탐지 기록 시각화
- 경고 메시지 및 상태 표시 UI 구현

### 염도윤
- 격리 스크립트 및 Linux 명령어 처리 보조
- 서비스 실행 및 자동화(systemd) 문서화
- 환경 설정 및 테스트 자동화 보조

## 활용 방안
- Linux 파일 시스템 감시 기술을 실제 보안 문제와 연결해볼 수 있다.
- 서버/PC 환경에서 비정상 파일 행위를 탐지하는 기초 보안 시스템 학습에 활용할 수 있다.
- 시스템 로그, 파일 이벤트, 자동화 스크립트 등의 Linux 활용 능력을 종합적으로 경험할 수 있다.
- 정보보호 입문 수준에서 “행위 기반 탐지” 개념을 시각적으로 이해하는 데 도움이 된다.
- 추후 백업 시스템, 이상행동 감지 시스템, 관리자 알림 시스템으로 확장 가능하다.

## 차별점 및 개선점
- 단순 백신 흉내가 아니라 Linux 파일 시스템 이벤트를 직접 활용한다는 점에서 차별성이 있다.
- 실제 악성코드를 만드는 것이 아니라, 안전한 시뮬레이션 기반으로 랜섬웨어 유사 행동을 탐지한다.
- 감시 → 탐지 → 기록 → 격리까지 이어지는 자동 대응 흐름을 보여줄 수 있다.
- Linux의 로그, 스크립트, 프로세스 제어, 서비스 자동 실행 등 여러 기능을 자연스럽게 포함할 수 있다.
- 웹 대시보드를 결합하면 시연 효과가 크고 발표 전달력도 높다.

향후 개선 방향은 다음과 같다.
- 파일 해시 기반 이상 탐지 추가
- 디렉터리별 민감도 설정
- 관리자 알림 기능 추가
- 허용 프로세스 화이트리스트 도입
- 탐지 기준 정교화로 오탐 감소

## MVP 구현 상태

현재 저장소에는 `dev/` 설계를 기준으로 한 단일 호스트 MVP가 포함되어 있다.

- `src/collector`: canonical 파일 이벤트 수집과 경로 정책
- `src/rules`: 시간 창 기반 create/modify/delete/rename 룰 엔진
- `src/incidents`: incident 읽기 모델과 상태 전이 집계
- `src/isolation`: critical incident 자동 격리와 수동 복원
- `src/simulator`: `demo_mode` 전용 안전한 모의 랜섬웨어 시뮬레이터
- `src/dashboard`: HTTP API, WebSocket 스트림, 정적 운영 대시보드
- `src/app`, `src/server.ts`: 런타임 조립과 서버 진입점
- `ops/scripts`: Linux 명령어 경계 스크립트 (`monitor.sh`, `quarantine.sh`, `restore.sh`, `demo.sh`, `log_append.sh`, `preflight.sh`)

웹/API 계층은 계속 Node.js로 유지하지만, 운영체제와 직접 맞닿는 동작은 모두 Linux 명령어 기반 wrapper를 통해 수행한다.

- 파일 감시: `inotifywait`
- 격리/복원: `chmod`, `stat`, `sha256sum`, `df`
- 데모 변조/복원: `find`, `mv`, `base64`, `rm`, `chmod`
- 로그 append: `mkdir`, shell redirection

`demo_mode` 시뮬레이터는 `.demo.locked` 파일로 base64 기반 안전 변조를 수행하고, 실제 incident 자동 격리는 `rules[].autoQuarantine=true`인 룰이 열렸을 때만 monitor target 전체 트리의 디렉터리를 `500`, 파일을 `400`으로 잠그는 in-place permission lockdown으로 동작한다. 따라서 격리 대상 룰이 발동하면 시뮬레이터를 별도로 중단시키지 않아도 이후 변조 시도는 Linux 권한 오류로 실패한다.

## 실행 방법

0. Linux 명령어 선행 조건 설치

`inotifywait`는 `inotify-tools` 패키지로 제공되며, 애플리케이션 시작 시 `preflight.sh`가 아래 명령들의 존재 여부를 먼저 검사한다.

- `inotifywait`
- `mv`
- `cp`
- `rm`
- `chmod`
- `stat`
- `df`
- `sha256sum`
- `base64`
- `find`
- `sed`
- `awk`
- `xargs`

Ubuntu/Debian 계열에서는 다음 명령으로 설치할 수 있다.

```bash
sudo apt-get update
sudo apt-get install -y inotify-tools
```

1. 의존성 설치

```bash
npm install
```

2. 샘플 설정 기준 빌드

```bash
npm run build
```

3. 개발 실행

```bash
APP_CONFIG_PATH=ops/sample-config/app-config.json npm run dev
```

기본 대시보드 주소는 `http://127.0.0.1:4000` 이다.

실행 중 파일 감시, 격리, 복원, 데모 변조, 로그 기록은 `ops/scripts/*.sh`를 통해 수행되며, 필수 Linux 명령어가 누락되어 있으면 서버는 시작 전에 즉시 실패한다.

## 샘플 설정

- 샘플 설정 파일: `ops/sample-config/app-config.json`
- 데모 감시 루트: `./tmp/demo-target`
- 로그 경로: `./data/events.log`
- 격리 저장소: `./data/quarantine`

데모 실행 전에는 `tmp/demo-target` 아래에 테스트용 파일을 준비해야 한다. `demoMode`가 꺼져 있으면 시뮬레이터는 실행되지 않는다.
`quarantineDir` 설정은 계약 호환성을 위해 유지되지만, 현재 permission-only quarantine에서는 실제 파일 저장소로 사용하지 않는다.
`rules[].autoQuarantine` 값으로 각 룰이 탐지만 할지, threshold/window를 만족했을 때 실제 격리까지 이어질지를 분리해서 설정할 수 있다. 예를 들어 `create` burst는 알림만 띄우고, `modify` 또는 `delete` burst만 격리하도록 구성할 수 있다.

## 검증 명령

```bash
npm test
npm run build
```
