# 06. 대시보드 UI 및 API 엔드포인트

이 문서는 Team 404의 Linux 랜섬웨어 모니터링 시스템 웹 대시보드의 구조와, 이를 지원하는 REST API 및 WebSocket 서버를 설명합니다. 모든 내용은 실제 소스 코드를 기준으로 작성되었습니다.

---

## 1. 대시보드 아키텍처 개요

웹 대시보드는 정적 파일 3개로 구성된 싱글 페이지 애플리케이션(SPA)입니다.

| 파일 | 역할 |
|---|---|
| `public/index.html` | 마크업 구조. 사이드바, 탑바, 3개 뷰 패널(대시보드 / 탐지 규칙 / 설정)을 정의합니다. |
| `public/app.js` | 전체 프론트엔드 로직. WebSocket 연결, API 호출, DOM 업데이트, 이벤트 핸들링을 담당합니다. |
| `public/style.css` | IBM Carbon Design System 스타일을 참고한 디자인 시스템. 라이트/다크 테마, 0px 보더 라디우스, 플랫 UI를 적용합니다. |

서버는 `src/server/create-api-server.js`에 정의되어 있으며, **Node.js 기본 `node:http` 모듈**로 직접 구현되었습니다. Express나 Fastify 같은 외부 프레임워크를 사용하지 않습니다.

---

## 2. API 서버 구조 (`create-api-server.js`)

API 서버는 `http.createServer()`로 생성한 기본 HTTP 서버 위에 라우팅과 WebSocket 핸드셰이크를 직접 구현한 구조입니다.

### 2.1 서버 생성 흐름

```
createApiServer({ runtime })
  ├── http.createServer(handleApiRequest)
  └── attachDashboardWebSocket({ server, runtime })
```

- `runtime` 객체는 monitor, rule engine, incident store, quarantine service 등 전체 시스템 상태를 담고 있습니다.
- `handleApiRequest`는 URL 경로와 HTTP 메서드를 기준으로 분기하는 단순 if-else 체인입니다.
- `attachDashboardWebSocket`은 `server.on('upgrade', ...)` 이벤트를 통해 WebSocket 연결을 처리합니다.

### 2.2 정적 파일 서빙

`GET /`, `/index.html`, `/style.css`, `/app.js` 요청은 `public/` 디렉터리에서 파일을 읽어 MIME 타입과 함께 반환합니다. 별도의 정적 파일 미들웨어 없이 `fs.readFile`로 직접 읽습니다.

---

## 3. API 엔드포인트 목록

아래 표는 `src/server/create-api-server.js`와 `src/shared/contracts/event-names.js`에 정의된 모든 엔드포인트를 정리한 것입니다.

| 메서드 | 경로 | 설명 | 소스 |
|---|---|---|---|
| GET | `/api/health` | 서버 및 감시 상태, 데모 상태, 백엔드 정보를 반환합니다. | `create-api-server.js:55` |
| GET | `/api/snapshot` | 시스템 전체 스냅샷(health, policy, demo, monitor 설정 등)을 반환합니다. | `create-api-server.js:71` |
| GET | `/api/incidents` | 저장된 incident 목록을 반환합니다. | `create-api-server.js:59` |
| GET | `/api/alerts` | 저장된 alert 목록을 반환합니다. | `create-api-server.js:63` |
| GET | `/api/quarantine-jobs` | 격리 작업 목록을 반환합니다. | `create-api-server.js:67` |
| POST | `/api/incidents/:incidentId/restore` | 지정한 incident의 격리를 해제하고 권한을 복원합니다. | `create-api-server.js:176` |
| POST | `/api/demo/start` | 데모를 시작합니다. | `create-api-server.js:119` |
| POST | `/api/demo/stop` | 데모를 중지합니다. | `create-api-server.js:123` |
| POST | `/api/demo/reset` | 데모 상태를 초기화합니다. | `create-api-server.js:127` |
| POST | `/api/watch/target` | 감시 대상 디렉터리를 변경하거나 데모 모드를 활성화/비활성화합니다. | `create-api-server.js:131` |
| POST | `/api/watch/toggle` | 감시를 켜거나 끕니다. `enabled` boolean 필수. | `create-api-server.js:162` |
| GET | `/api/settings/response-policy` | 현재 격리 대응 정책을 반환합니다. | `create-api-server.js:75` |
| PUT | `/api/settings/response-policy` | 격리 대응 정책을 수정합니다. | `create-api-server.js:79` |
| GET | `/api/settings/detection-policy` | 현재 탐지 가중치 정책을 반환합니다. | `create-api-server.js:85` |
| PUT | `/api/settings/detection-policy` | 탐지 가중치 정책을 수정합니다. | `create-api-server.js:89` |
| POST | `/api/settings/detection-policy/reset` | 탐지 정책을 기본값으로 되돌립니다. | `create-api-server.js:95` |
| GET | `/api/settings/demo` | 데모 설정(파일 개수 등)을 반환합니다. | `create-api-server.js:99` |
| PUT | `/api/settings/demo` | 데모 설정을 수정합니다. | `create-api-server.js:113` |
| GET | `/api/settings/monitor` | 감시 백엔드 설정을 반환합니다. | `create-api-server.js:103` |
| PUT | `/api/settings/monitor` | 감시 백엔드 설정을 수정합니다. | `create-api-server.js:107` |

### 3.1 주요 엔드포인트 상세

#### GET `/api/health`

서버 연결 상태, 감시 활성화 여부, 데모 상태, 활성 백엔드(auditd / inotify) 및 PID 추적 가능 여부를 포함합니다. 대시보드 상단 상태 표시줄의 주요 데이터 원천입니다.

#### GET `/api/snapshot`

`/api/health`보다 더 넓은 범위의 데이터를 한 번에 제공합니다. `watchEnabled`, `responsePolicy`, `detectionPolicy`, `quarantineJobs`, `demo`, `monitor` 설정 등을 포함하며, 대시보드 초기 로딩 시 `loadState()` 함수가 이 엔드포인트를 호출합니다.

#### POST `/api/watch/target`

요청 본문의 `mode` 필드에 따라 동작이 달라집니다.

- `mode: 'demo'` : 데모 모드를 활성화합니다.
- `restoreDefault: true` : 데모 모드를 비활성화하고 기본 감시 대상으로 복원합니다.
- `targetPaths` (배열) 또는 `targetPath` (단일 문자열) : 실제 존재하는 디렉터리인지 검증 후 감시 대상을 변경합니다. 중복 경로는 400 오류를 반환합니다.

#### POST `/api/watch/toggle`

`enabled` boolean 값을 받아 감시를 시작하거나 중지합니다. 이 엔드포인트는 `src/server/create-api-server.js`에 직접 구현되어 있으나, `src/shared/contracts/event-names.js`의 `API_ROUTES` 상수에는 포함되어 있지 않습니다.

#### POST `/api/incidents/:incidentId/restore`

정규식 `^/api/incidents/([^/]+)/restore$`으로 경로를 매칭합니다. `runtime.restoreIncident(incidentId)`를 호출하여 격리된 디렉터리의 권한을 원래대로 복원합니다. 이 엔드포인트 역시 `API_ROUTES` 상수에는 없고 서버 코드에 직접 하드코딩되어 있습니다.

---

## 4. WebSocket 실시간 이벤트 브로드캐스트

API 서버는 WebSocket을 통해 서버에서 발생하는 이벤트를 대시보드로 실시간 전송합니다. 중요한 점은 이 WebSocket이 `ws` 같은 외부 라이브러리가 아니라, **Node.js 기본 `crypto`와 `net.Socket`을 이용해 RFC 6455 핸드셰이크 및 텍스트 프레임 인코딩을 직접 구현**한 것입니다.

### 4.1 핸드셰이크

클라이언트의 `Sec-WebSocket-Key`를 받아 고정 GUID(`258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)와 결합한 뒤 SHA-1 해시와 base64 인코딩으로 `Sec-WebSocket-Accept`를 생성합니다. 이는 표준 WebSocket 프로토콜 그대로입니다.

### 4.2 연결 경로

`GET /` 또는 `GET /ws`로 `Upgrade: websocket` 헤더와 함께 요청하면 연결이 수립됩니다.

### 4.3 브로드캐스트 이벤트

`runtime.eventBus`에 구독한 리스너들이 이벤트를 받으면, 연결된 모든 WebSocket 클라이언트에게 JSON 메시지를 전송합니다.

| 서버 이벤트 | WebSocket 메시지 타입 | 설명 |
|---|---|---|
| `FS_EVENT` | `FILE_EVENT` | 파일 생성/수정/삭제/이름 변경 이벤트 |
| `QUARANTINE_STARTED` | `QUARANTINE_STARTED` | 격리 작업 시작 |
| `QUARANTINE_COMPLETED` | `QUARANTINE_COMPLETED` | 격리 작업 완료 |
| `QUARANTINE_FAILED` | `QUARANTINE_FAILED` | 격리 작업 실패 |
| `RESTORE_COMPLETED` | `RESTORE_COMPLETED` | 권한 복원 완료 |
| `RULE_WEIGHT_UPDATED` | `RULE_WEIGHT_UPDATED` | 탐지 가중치 변경 |
| `RULE_MATCH` | `RULE_MATCH` | 랜섬웨어 의심 행위 탐지 |
| `DEMO_STARTED` | `DEMO_STARTED` | 데모 시작 |
| `DEMO_ABORTED` | `DEMO_ABORTED` | 데모 중단 |
| `DEMO_COMPLETED` | `DEMO_COMPLETED` | 데모 완료 |
| `DEMO_LOG` | `DEMO_LOG` | 데모 내부 로그 |
| `SYSTEM_HEALTH` | `SYSTEM_HEALTH` | 시스템 상태 변경 |

연결 직후 클라이언트는 `CONNECTED` 메시지를 받으며, 이 메시지에 현재 health 상태가 포함됩니다.

---

## 5. 폴링과 WebSocket의 협력 전략

대시보드는 **WebSocket을 주 업데이트 수단으로 사용하고, 5초 주기 health 폴링을 서버 생존 확인용 보조 수단으로 사용**합니다. 현재 폴링은 WebSocket 재연결이나 이벤트 재전송을 수행하는 완전한 fallback은 아닙니다.

### 5.1 WebSocket 실시간 업데이트

`public/app.js`는 페이지 로드 시 `new WebSocket(...)`으로 연결을 엽니다. 서버에서 이벤트가 발생하면 즉시 `socket.onmessage`로 수신하여 해당 로그 영역에 prepend 방식으로 추가합니다. 파일 이벤트, 격리 상태, 데모 로그 등 대부분의 실시간 데이터는 이 경로로 전달됩니다.

### 5.2 5초 주기 Health 폴링

`setInterval(checkHealth, 5000)`으로 5초마다 `GET /api/health`를 호출합니다. 이 폴링의 목적은 다음과 같습니다.

- WebSocket 연결이 끊어졌을 때 서버가 실제로 살아 있는지 확인
- 초기 로딩 중 WebSocket 연결보다 먼저 서버 가용성을 판단
- `server-status-text`가 "메인 서버 연결 중..." 상태일 때만 상태를 갱신

### 5.3 `/api/snapshot` 기반 상태 동기화

탐지, 격리, 복원, 데모 상태처럼 누적 상태가 바뀌는 WebSocket 이벤트를 수신하면 `loadState()` 함수가 `/api/snapshot`을 호출하여 전체 상태를 다시 동기화합니다. `FILE_EVENT`, `RULE_WEIGHT_UPDATED`, `SYSTEM_HEALTH`처럼 화면 일부만 갱신해도 되는 이벤트는 즉시 UI만 업데이트합니다.

---

## 6. 대시보드 UI 구성 요소

### 6.1 사이드바 (`public/index.html`)

- 로고: "SENTINEL 404" / "Security Monitor"
- 탭 메뉴: 대시보드 / 탐지 규칙 / 설정
- `data-view` 속성으로 뷰 전환을 제어합니다.

### 6.2 탑바 (`public/index.html`)

- 페이지 제목 및 부제목 (뷰에 따라 변경)
- 데모 모드 토글 스위치
- 서버 연결 상태 점(dot): online / offline / warning
- 데모 서버 상태 점
- "감시 시작/중지" 버튼 (`btn-watch-toggle`)
- 데모 제어 버튼: 시작/중지, 초기화 (데모 모드일 때만 노출)

### 6.3 대시보드 뷰 (`data-view-panel="dashboard"`)

#### 상태 카드 영역

- **감시 중인 항목**: 현재 감시 대상 파일 개수
- **현재 가중치**: `currentWeight / thresholdWeight` 형식으로 표시, 임계치 초과 시 빨간색으로 변경되는 미터 바 포함
- **감시 디렉터리**: 현재 감시 중인 경로 목록, 편집 가능한 입력 필드와 적용 버튼

#### 로그 영역

- **파일시스템 이벤트**: `FS_EVENT` WebSocket 메시지를 실시간으로 표시. create(녹색), modify(노란색), delete(빨간색)로 구분. PID, comm, exe 정보가 있으면 함께 출력.
- **Incident 및 격리 로그**: 탐지, 격리 시작/완료/실패, 복원 이벤트를 표시.
- **데모 로그**: 데모 모드일 때만 노출되며, 데모 진행 상황과 내부 로그를 표시.

모든 로그는 최신 항목이 위로 올라오는 prepend 방식이며, 각 컨테이너는 최대 100개까지만 유지합니다. "로그 초기화" 버튼은 개별 초기화, Shift+클릭은 전체 초기화를 지원합니다.

#### Incident 및 격리 관리 테이블

- ID, 대상 경로, 파일 항목 수, 상태, 액션 열로 구성
- 상태: 격리 중 / 격리됨 / 실패 / 권한 복구됨
- "복구" 버튼으로 `POST /api/incidents/:id/restore` 호출

### 6.4 탐지 규칙 뷰 (`data-view-panel="rules"`)

#### 격리 범위 설정

- incident가 발생한 디렉터리만 격리
- 모든 감시 중인 디렉터리 격리

#### 감시 가중치 슬라이더

| 항목 | 기본값 | 범위 |
|---|---|---|
| 기준 가중치 (threshold) | 10.00 | 1 ~ 50 |
| 정상 확장자 가중치 | 0.10 | 0 ~ 5 |
| 알 수 없는 확장자 가중치 | 1.00 | 0 ~ 5 |
| 확장자 없음 가중치 | 1.00 | 0 ~ 5 |
| 의심 확장자 가중치 | 2.00 | 0 ~ 5 |
| Create 보정 | 1.00 | 0 ~ 3 |
| Modify 보정 | 1.00 | 0 ~ 3 |
| Rename 보정 | 1.50 | 0 ~ 3 |
| 감소 주기(ms) | 1000 | 100 ~ 10000 |
| 주기당 감소량 | 1.00 | 0 ~ 10 |

각 슬라이더는 동기화된 숫자 입력 필드가 함께 제공됩니다.

#### 사용자 화이트리스트 확장자

- 입력 후 "추가" 버튼으로 chip 형태로 등록
- chip의 x 버튼으로 제거 가능
- 기본 의심 확장자: `locked`, `encrypted`, `warning`, `decrypt`, `ransom`, `recover`, `pay`

### 6.5 설정 뷰 (`data-view-panel="settings"`)

#### 화면 테마

- 라이트 / 다크 테마 선택
- `localStorage`에 저장, `data-theme` 속성으로 CSS 변수 전환

#### 감시 환경

- 자동(auditd 우선, 실패 시 inotify)
- auditd (PID 추적 가능, 권한 필요)
- inotify (기본 파일 이벤트, PID 정보 없음)

#### 데모 설정

- 데모 파일 개수: 1 ~ 200개 (기본 15)

#### 격리 대응 단계

- **1단계**: 감시 디렉터리 권한 잠금 (기본)
- **2단계**: 의심 프로세스 강제 종료 (auditd PID 추적 필요)
- **3단계**: 즉시 시스템 강제 종료 (확인 대화상자 필요)

2단계와 3단계는 활성화 시 `confirm()`으로 추가 확인을 요구합니다.

---

## 7. 디자인 시스템

### 7.1 IBM Carbon Design System 참고

`public/style.css`는 IBM Carbon Design System의 시각 언어를 참고하여 작성되었습니다. 주요 특징은 다음과 같습니다.

- **0px 보더 라디우스**: 모든 버튼, 카드, 입력 필드, 테이블 셀의 모서리는 직각입니다.
- **1px 헤어라인 보더**: 카드와 구분선은 얇은 1px 선으로 처리하며, 그림자는 사용하지 않습니다.
- **IBM Blue (#0f62fe) 단일 강조색**: 주요 버튼, 활성 탭, 포커스 링, 뱃지에 사용됩니다.
- **서피스 레벨 구분**: 흰색 배경(`--bg-main`)과 연한 회색(`--bg-sidebar`, `--input-bg`)으로 깊이를 표현합니다.
- **라이트/다크 테마**: CSS 커스텀 프로퍼티(`:root` / `:root[data-theme="dark"]`)로 전환합니다.

### 7.2 실제 폰트 적용

`DESIGN.md`에서는 IBM Plex Sans를 권장하지만, 실제 `public/index.html`의 폰트 임포트는 **Pretendard Variable**을 사용합니다. 이는 한국어 가독성을 우선한 선택입니다.

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
```

CSS `font-family` 선언:

```css
font-family: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, Roboto, "Helvetica Neue", "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
```

### 7.3 반응형 대응

- 900px 이하: 사이드바가 상단으로 이동, 대시보드 그리드가 단일 열로 변경, 로그 영역 높이 고정
- 560px 이하: 터치 타겟 확대(48px), 버튼 전폭 배치, 테이블 가로 스크롤

---

## 8. 프론트엔드 주요 동작 흐름 (`public/app.js`)

### 8.1 초기화 순서

1. `loadThemePreference()`로 저장된 테마 적용
2. `new WebSocket(...)` 연결 시도
3. `loadInitialState()`로 `/api/snapshot` 호출 및 전체 UI 초기화
4. `checkHealth()` 실행 후 5초 간격 폴링 시작

### 8.2 WebSocket 메시지 처리

`socket.onmessage`는 `msg.type`에 따라 분기합니다.

- `CONNECTED`: 데모 상태, 모니터 백엔드 상태 초기화
- `SYSTEM_HEALTH`: 감시 백엔드 상태 업데이트, 감시 시작/중지 로그 추가
- `RULE_WEIGHT_UPDATED`: 현재 가중치 미터 바 갱신
- `FILE_EVENT`: 파일시스템 이벤트 로그에 prepend
- `RULE_MATCH`, `QUARANTINE_*`, `RESTORE_COMPLETED`: incident 로그에 prepend 후 `loadState()`로 테이블 갱신
- `DEMO_*`: 데모 로그에 prepend 후 `loadState()`로 상태 갱신

### 8.3 API 호출 패턴

모든 API 호출은 `fetch()`를 사용하며, 에러 발생 시 `alert()` 또는 화면 내 `field-error` 요소에 메시지를 표시합니다. 저장 버튼은 요청 중 `disabled` 처리되고 텍스트가 "저장 중"으로 변경됩니다.

---

## 9. 테스트

`test/create-api-server.test.js`는 Node.js 기본 테스트 러너(`node:test`)를 사용합니다. 다음 항목을 검증합니다.

- 데모 시작/중지/설정 변경
- health, snapshot, incident, alert, quarantine-jobs 조회
- 감시 대상 변경(단일/다중 경로, 데모 모드, 기본 복원)
- 중복 경로 및 존재하지 않는 디렉터리 거부
- response policy 조회 및 수정(누적 단계 정규화, 격리 범위)
- detection policy 조회, 수정, 초기화(유효하지 않은 값 거부)
- monitor backend 설정 변경 및 유효성 검사
- WebSocket 업그레이드 및 이벤트 브로드캐스트(FS_EVENT, QUARANTINE_STARTED, QUARANTINE_FAILED, RULE_WEIGHT_UPDATED, DEMO_LOG)

---

## 10. 참고 소스 파일

- `src/server/create-api-server.js` — API 서버 및 WebSocket 구현
- `public/index.html` — 대시보드 마크업
- `public/app.js` — 대시보드 프론트엔드 로직
- `public/style.css` — 대시보드 스타일시트
- `src/shared/contracts/event-names.js` — 이벤트명 및 API 경로 상수
- `test/create-api-server.test.js` — API 서버 테스트
- `DESIGN.md` — IBM Carbon 스타일 참고 문서
