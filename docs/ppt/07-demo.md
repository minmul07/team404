# 7. Demo 시뮬레이터 및 시연 시나리오

> 본 문서는 Team 404의 Linux 랜섬웨어 모니터링 시스템 데모에 사용하는 시뮬레이터 구조와 8분 발표용 시연 절차를 설명합니다.
> **중요: 이 데모는 악성코드를 실행하는 것이 아닙니다.** 파일 시스템 이벤트를 유도하기 위한 "랜섬웨어 유사 행위 시뮬레이션"일 뿐, 시스템 전체를 위협하지 않습니다.

---

## 7.1 데모 시뮬레이터 개요

악성코드를 제작하거나 배포할 수 없으므로, 팀은 `src/simulator/` 디렉터리 아래에 안전한 모의 공격 환경을 구축했습니다. 이 시뮬레이터는 다음 행위를 재현합니다.

- 짧은 시간 내 다수 파일의 내용 변경 (Base64 인코딩)
- 확장자 일괄 변경 (`.txt` → `.demo.locked`)
- 파일명 변경 (`fs.renameSync`)으로 실제 감시 백엔드에서는 rename 이벤트 발생 가능

데모 worker가 직접 재발행하는 합성 이벤트는 `modify`와 `create`이지만, 이벤트 버스에는 실제 감시 이벤트와 같은 `FS_EVENT` 형태로 전달됩니다. 따라서 `RuleEngine`, `IncidentStore`, `QuarantineService`로 이어지는 탐지·격리·복구 파이프라인은 실제 감시 모드와 같습니다.

---

## 7.2 핵심 소스 파일

### `src/simulator/demo.js` — 모의 공격 본체

`demo.js`는 데모 타겟 디렉터리(`tmp/demo-target`)를 대상으로 랜섬웨어 유사 행위를 수행합니다.

**주요 함수**

| 함수 | 역할 |
|------|------|
| `startAttack(onEvent, options)` | Base64 인코딩 및 파일 rename을 순차 실행. `onEvent` 콜백으로 `modify`/`create` 이벤트를 외부에 전달 |
| `restoreDemo()` | `.demo.locked` 파일을 원래 이름과 내용으로 복원 |
| `resetDemo(options)` | 타겟 디렉터리를 초기화하고 `file_1.txt` ~ `file_N.txt`를 생성 |
| `normalizeDemoFileCount(value)` | 파일 개수를 1~200 사이로 클램핑. 기본값은 15개 |

**시뮬레이션 동작 상세**

```javascript
// src/simulator/demo.js:56-69
const filePath = path.join(TARGET_DIR, `file_${i}.txt`);
const lockedPath = filePath + '.demo.locked';

const originalContent = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : `original content ${i}`;

const encoded = Buffer.from(originalContent).toString('base64');
fs.writeFileSync(filePath, encoded);        // 1) modify 이벤트
onEvent?.('modify', filePath);
fs.renameSync(filePath, lockedPath);        // 2) create 이벤트 (locked 파일)
onEvent?.('create', lockedPath);
```

- 파일당 100ms 간격을 두어 이벤트가 연속적으로 발생하는 모습을 만듭니다.
- `tmp/demo-log.jsonl`에 모든 동작 기록을 남겨, 다른 팀원이 로그로 추적할 수 있게 합니다.

**안전 장치**

- `assertDemoWriteAllowed()`로 타겟 디렉터리와 파일의 쓰기 권한을 사전 확인합니다. 격리로 인해 권한이 잠겼다면 즉시 `blocked` 상태를 반환하고 중단합니다.
- `restoreDemoEncryption()`은 `.demo.locked` 확장자를 찾아 Base64 디코딩 후 원래 파일명으로 복원합니다. 이 과정은 완전히 가역적입니다.
- `resetDemoWithOptions()`는 기존 타겟 디렉터리를 삭제하고 새 파일을 생성하며, 필요 시 `chown`으로 소유권도 조정합니다.

### `src/simulator/demo-worker.js` — IPC Worker 래퍼

`demo-worker.js`는 `runtime.js`가 `fork()`로 생성한 별도 Node.js 프로세스입니다. 이 구조를 택한 이유는 다음과 같습니다.

1. **격리**: 모의 공격 프로세스를 메인 런타임과 분리하여, 예기치 않은 오류가 시스템 전체를 멈추지 않게 합니다.
2. **권한 분리**: `fork()` 시 `uid`/`gid`를 지정해 데모 worker를 별도 사용자로 실행할 수 있습니다.
3. **비동기 이벤트 스트리밍**: worker가 파일 이벤트를 발생시킬 때마다 `process.send()`로 메인 프로세스에 실시간 전달합니다.

**메시지 프로토콜**

```javascript
// src/simulator/demo-worker.js:16-24
const result = await startAttack((eventType, filePath) => {
    sendMessage({
        type: 'fs_event',
        payload: { eventType, filePath }
    });
}, { signal: controller.signal, fileCount });
```

Worker가 보내는 메시지 타입:

| 메시지 타입 | 의미 |
|-------------|------|
| `fs_event`  | 파일 수정 또는 생성 이벤트 발생 |
| `completed` | 모든 파일 시뮬레이션 완료 |
| `blocked`   | 격리로 인해 쓰기가 차단됨 |
| `aborted`   | 사용자 또는 시스템에 의해 중단됨 |
| `error`     | 예외 발생 |

메인 프로세스(`src/app/runtime.js`)는 이 메시지를 받아 `EVENT_NAMES.FS_EVENT`로 이벤트 버스에 재발행합니다. PID 추적이 가능한 환경에서는 `pid`, `comm`, `exe` 필드도 함께 기록되어, 실제 프로세스 추적과 동일한 형태의 이벤트가 생성됩니다.

### `src/app/runtime.js` — 데모 라이프사이클 관리

`runtime.js`는 데모의 시작·중지·초기화를 총괄합니다.

**데모 상태 머신**

```
ready → running → completed
ready → running → stopping → aborted
ready → running → failed (blocked / error / exit)
```

**핵심 메서드**

| 메서드 | 동작 |
|--------|------|
| `enableDemoMode()` | 감시 대상을 `tmp/demo-target`로 전환 (`activeMode: 'demo'`) |
| `startDemo()` | `demo-worker.js`를 `fork()`하고 이벤트 수신 시작. 단, 데모 모드가 아니면 409 오류 |
| `stopDemo()` | worker에게 `abort` 메시지를 보내고, 1.5초 내 응답 없으면 `SIGTERM` |
| `resetDemo()` | 감시를 잠시 중단 → 타겟 디렉터리 초기화 → incident/quarantine/rule 상태 초기화 → 감시 재개 |

`resetDemo()`는 특히 주목할 만합니다. 격리가 해제된 상태에서 파일을 다시 세팅해야 하므로, 모니터링을 잠시 멈추고(`데모 파일 세팅을 위해 감시를 중지합니다.`) 초기화한 뒤 다시 시작합니다(`데모 파일 세팅이 끝나 감시를 다시 시작합니다.`). 이 동작은 `test/runtime.test.js`에서도 검증됩니다.

### `ops/scripts/demo.sh` — 편의 wrapper

```bash
# 실행 예시
./ops/scripts/demo.sh start    # 모의 공격 시작
./ops/scripts/demo.sh restore  # 파일 복원
```

이 스크립트는 `node src/simulator/demo.js run|restore`를 감싸는 얇은 쉘 wrapper입니다. API 서버 없이 CLI로만 데모를 돌려보고 싶을 때 사용합니다.

---

## 7.3 데모 안전성 원칙

데모 시뮬레이터는 다음 원칙을 준수하여, 발표 중 실수로도 시스템을 손상하지 않도록 설계되었습니다.

1. **샌드박스 전용**: 모든 조작은 `tmp/demo-target` 디렉터리 내부에서만 일어납니다. 시스템 디렉터리나 사용자 홈 디렉터리에는 절대 접근하지 않습니다.
2. **가역적 변경**: 파일 내용은 Base64 인코딩만 수행되며, `restoreDemo()`로 완전히 원래 상태로 되돌릴 수 있습니다. 실제 암호화가 아닙니다.
3. **권한 사전 검사**: `assertDemoWriteAllowed()`로 쓰기 권한을 확인하고, 격리로 잠긴 디렉터리에는 쓰기를 시도조차 하지 않습니다.
4. **worker 격리**: 별도 프로세스로 실행되므로, 메인 서버 프로세스의 안정성과 무관하게 동작합니다.
5. **파일 개수 제한**: `normalizeDemoFileCount()`가 1~200개로 제한합니다. 코드 fallback 기본값은 15개이며, 실제 발표용 실행값은 `ops/sample-config/app-config.json`의 `demo.fileCount` 설정을 따릅니다.

---

## 7.4 8분 발표용 시연 시나리오 (10단계)

아래 시나리오는 발표 시간 8분을 기준으로 구성했습니다. 각 단계는 대시보드 화면 전환과 함께 진행합니다.

### Step 1 — 시스템 시작 (`npm run dev`)

터미널에서 `npm run dev`를 실행합니다. API 서버와 파일 감시 백엔드가 함께 구동되며, 콘솔에는 `SYSTEM_HEALTH` 이벤트가 출력됩니다.

> "지금 시스템을 실행하면, 파일 감시 백엔드가 준비되고 웹 대시보드에 접속할 수 있습니다."

### Step 2 — 감시 대상 디렉터리 설정

대시보드 또는 API를 통해 감시 대상을 `tmp/demo-target`로 지정하거나, 데모 모드를 활성화합니다. `runtime.enableDemoMode()`가 호출되면 `activeMode`가 `'demo'`로 바뀌고 타겟이 고정됩니다.

> "데모 모드를 켜면, 시스템이 자동으로 샌드박스 디렉터리를 감시 대상으로 삼습니다."

### Step 3 — 데모 파일 초기화

`resetDemo()`를 호출하여 데모 파일을 생성합니다. 코드 fallback 기본값은 15개지만, 현재 `npm run dev`가 읽는 `ops/sample-config/app-config.json` 기준 데모 파일 개수는 30개입니다. 대시보드의 "감시 중인 항목" 카드에서 생성된 파일 개수를 확인합니다.

> "시뮬레이션에 쓸 샘플 파일을 생성했습니다. 지금은 모두 일반 텍스트 파일입니다."

### Step 4 — 모의 공격 트리거

대시보드의 "데모 시작" 버튼을 누르거나, `runtime.startDemo()`를 호출합니다. `demo-worker.js`가 fork되어 파일 변조를 시작합니다.

> "랜섬웨어 유사 행위 시뮬레이션을 시작합니다. 실제 악성코드가 아니라, 파일 이벤트를 인위적으로 발생시키는 것뿐입니다."

### Step 5 — 파일 이벤트 실시간 관찰

대시보드 이벤트 스트림 창에서 `modify`와 `create` 이벤트가 빠르게 쌓이는 모습을 보여줍니다. 파일명이 `.demo.locked`로 바뀌는 과정도 함께 노출됩니다.

> "보시는 것처럼, 짧은 시간 안에 수십 건의 수정·생성·이름 변경 이벤트가 발생하고 있습니다."

### Step 6 — 탐지 임계치 초과 및 Incident 생성

이벤트 가중치가 `thresholdWeight`를 넘어서면, `RuleEngine`이 `RULE_MATCH`를 발생시키고 `IncidentStore`가 `INCIDENT_OPENED`를 생성합니다. 코드 fallback 기본 임계치는 10이지만, 현재 `npm run dev` 기본 config의 임계치는 12입니다. 대시보드에는 incident 및 격리 로그가 추가됩니다.

> "임계치를 초과했습니다. 시스템이 이를 랜섬웨어 의심 행위로 판단하고 자동으로 인시던트를 생성했습니다."

### Step 7 — 자동 격리 실행

`INCIDENT_OPENED` 이벤트를 받은 `QuarantineService`가 `ops/scripts/quarantine.sh`를 실행하여 타겟 디렉터리 권한을 잠급니다. 실제 스크립트는 파일과 디렉터리 모두 `000`으로 변경하여 접근을 차단합니다.

> "자동 격리가 작동했습니다. 감시 대상 디렉터리의 접근 권한이 제한되어, 공격 확산을 막습니다."

### Step 8 — 대시보드에서 격리 상태 확인

대시보드의 "Incident 및 격리 관리" 테이블에서 현재 격리 중인 디렉터리와 상태를 확인합니다. 동시에 데모 worker는 이후 파일 쓰기 시도에서 `EACCES`를 받고 `blocked` 상태로 종료될 수 있습니다.

> "격리가 실제로 적용되었습니다. 이제는 시뮬레이터조차 해당 디렉터리에 쓸 수 없습니다."

### Step 9 — 인시던트 복원

대시보드에서 해당 인시던트를 선택하고 "복원"을 클릭합니다. `runtime.restoreIncident(incidentId)`가 호출되면, `QuarantineService`가 저장해둔 원래 권한으로 되돌립니다.

> "이제 공격이 멈췄으니, 격리를 해제하고 원래 상태로 복원합니다."

### Step 10 — 권한 복원 및 파일 상태 확인

대시보드에서 권한 복원 상태를 확인하고, 터미널에서 `ls -l tmp/demo-target`를 실행해 파일과 디렉터리에 접근할 수 있는지 확인합니다. `restoreIncident()`는 권한만 원래 모드로 되돌리므로, `.demo.locked` 파일명과 Base64 인코딩된 내용은 그대로 남습니다.

> "격리로 잠겼던 권한이 원래대로 돌아왔습니다. 파일 내용 복원은 별도의 데모 복원 절차에서 수행할 수 있습니다."

---

## 7.5 데모 흐름 vs 실제 감시 흐름 비교

| 단계 | 데모 모드 | 실제 감시 모드 |
|------|-----------|----------------|
| 이벤트 발생 주체 | `demo-worker.js` 합성 이벤트 + 데모 디렉터리를 감시 중인 `inotifywait`/`auditd` 이벤트 | `inotifywait` / `auditd` |
| 이벤트 타입 | worker 합성 이벤트는 `modify`, `create`; 감시 백엔드는 `create`, `modify`, `delete`, `rename` 가능 | `create`, `modify`, `delete`, `rename` |
| 이벤트 정규화 | worker 이벤트는 `runtime.js`가, 감시 백엔드 이벤트는 `monitor-event-parser.js`가 `FS_EVENT`로 변환 | `monitor-event-parser.js`가 `FS_EVENT`로 변환 |
| 탐지 엔진 | `RuleEngine` (동일) | `RuleEngine` (동일) |
| 인시던트 생성 | `IncidentStore` (동일) | `IncidentStore` (동일) |
| 격리 실행 | `QuarantineService` → `quarantine.sh` (동일) | `QuarantineService` → `quarantine.sh` (동일) |
| 복원 | `restoreIncident()`는 권한 복원만 수행 | `restoreIncident()`는 권한 복원만 수행 |

**핵심 차이점은 데모 worker가 합성 `FS_EVENT`를 추가로 재발행한다는 점입니다.** 데모는 의도적으로 짧은 시간에 다량 이벤트를 몰아넣어 탐지·격리 파이프라인을 빠르게 보여주기 위한 것이며, 탐지 이후의 incident 생성, 격리, 권한 복원 흐름은 실제 감시 모드와 동일합니다.

---

## 7.6 요약

- `src/simulator/demo.js`는 Base64 인코딩과 `.demo.locked` rename으로 랜섬웨어 유사 행위를 재현합니다.
- `src/simulator/demo-worker.js`는 별도 프로세스로 실행되어 이벤트를 메인 런타임에 실시간 전달합니다.
- `src/app/runtime.js`는 데모의 시작·중지·초기화를 관리하며, 실제 감시와 동일한 이벤트 파이프라인을 사용합니다.
- 모든 변경은 `tmp/demo-target` 샌드박스 내에서만 일어나며, `restoreDemo()`로 완전히 되돌릴 수 있습니다.
- 8분 발표 시나리오는 10단계로 구성되어, 감시 → 탐지 → 격리 → 복원의 전체 흐름을 체계적으로 보여줍니다.
