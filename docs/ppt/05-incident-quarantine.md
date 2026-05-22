# 5. 사고 관리 및 격리/복원 흐름

이 문서는 랜섬웨어 의심 행위가 탐지된 이후의 사고 관리, 자동 격리, 복원 전체 흐름을 설명합니다. 실제 소스 코드를 기준으로 작성되었으며, `README.md`와 실제 구현이 다른 부분은 별도로 명시합니다.

---

## 5.1 사고 생성과 관리 (`src/incidents/incident-store.js`)

### 5.1.1 RULE_MATCH에서 사고로의 전환

`RuleEngine`이 임계치를 초과한 이상 행위를 탐지하면 `RULE_MATCH` 이벤트를 발행합니다. `IncidentStore`는 이 이벤트를 수신해 사고(incident)를 생성하거나 기존 사고를 갱신합니다.

```js
// src/incidents/incident-store.js (handleRuleMatch)
const targetKey = match.monitorTargetId ?? match.monitorRootPath ?? 'unknown';
const currentIncident = this.getActiveIncident(targetKey);
```

`targetKey`는 `monitorTargetId` 또는 `monitorRootPath`를 기준으로 합니다. 동일한 감시 대상에서 발생한 여러 `RULE_MATCH`는 하나의 사고로 묶입니다.

### 5.1.2 신규 사고 생성

해당 감시 대상에 활성 사고가 없으면 새로운 사고를 생성합니다.

```js
// src/incidents/incident-store.js
const incident = {
  id: crypto.randomUUID(),
  status: INCIDENT_STATUSES.DETECTED,
  monitorTargetId: match.monitorTargetId,
  monitorRootPath: match.monitorRootPath,
  severity: match.severity ?? 'high',
  autoQuarantine: Boolean(match.autoQuarantine),
  reason: match.reason ?? null,
  openedAt: match.observedAt,
  updatedAt: match.observedAt,
  lastMatchAt: match.observedAt,
  ruleMatches: 1,
  totalObservedEvents: match.eventCount,
  samplePaths: match.samplePaths,
  eventTypes: match.eventTypes ?? [match.eventType].filter(Boolean),
  suspectProcesses: normalizeSuspectProcesses(match.suspectProcesses),
  matchedRuleIds: [match.ruleId],
  matchedRuleNames: [match.ruleName].filter(Boolean)
};
```

생성된 사고는 `INCIDENT_OPENED` 이벤트를 통해 `QuarantineService` 등 다른 구독자에게 전달됩니다.

### 5.1.3 반복 매치 병합과 심각도 상향

동일한 감시 대상에서 추가 `RULE_MATCH`가 발생하면 기존 사고를 갱신합니다.

- `ruleMatches` 카운트 증가
- `severity`는 더 높은 우선순위로 상향 (`low` < `medium` < `high` < `critical`)
- `autoQuarantine`이 한 번이라도 `true`면 유지
- `samplePaths`는 중복 제거 후 최대 10개까지 보존
- `eventTypes`, `suspectProcesses`, `matchedRuleIds`, `matchedRuleNames`는 집합 병합

```js
// src/incidents/incident-store.js
function pickHigherSeverity(currentSeverity = 'high', nextSeverity = 'high') {
  const currentPriority = SEVERITY_PRIORITY.get(currentSeverity) ?? 0;
  const nextPriority = SEVERITY_PRIORITY.get(nextSeverity) ?? 0;
  return nextPriority > currentPriority ? nextSeverity : currentSeverity;
}
```

### 5.1.4 알림(alert) 관리

모든 `RULE_MATCH`는 별도의 `alerts` 배열에 저장됩니다. 최신 100개만 유지하며, `getAlerts()`로 내림차순 조회할 수 있습니다.

```js
// src/incidents/incident-store.js
this.alerts.unshift(match);
this.alerts = this.alerts.slice(0, 100);
```

### 5.1.5 활성 사고 추적

`activeIncidentIdsByTarget` Map을 통해 감시 대상별 활성 사고 ID를 추적합니다. 활성 상태는 다음과 같이 정의됩니다.

```js
// src/incidents/incident-store.js
const ACTIVE_STATUSES = new Set([
  INCIDENT_STATUSES.DETECTED,
  INCIDENT_STATUSES.TRIAGE,
  INCIDENT_STATUSES.QUARANTINE_REQUESTED,
  INCIDENT_STATUSES.QUARANTINING,
  INCIDENT_STATUSES.QUARANTINED,
  INCIDENT_STATUSES.RESTORE_PENDING
]);
```

복원이 완료되면(`RESTORE_COMPLETED`) 해당 사고는 활성 상태에서 제외됩니다.

---

## 5.2 자동 격리 흐름 (`src/isolation/quarantine-service.js`)

### 5.2.1 격리 트리거 조건

`QuarantineService`는 `INCIDENT_OPENED` 이벤트를 수신합니다. 단, `autoQuarantine`이 `true`이고 `monitorRootPath`가 존재할 때만 격리를 시작합니다.

```js
// src/isolation/quarantine-service.js (handleIncidentOpened)
if (!incident.autoQuarantine) return;
if (!incident.monitorRootPath) {
  this._emitFailed(incident, 'monitorRootPath가 없어 격리할 경로를 알 수 없습니다.');
  return;
}
```

### 5.2.2 중복 격리 방지

동일한 사고에 대해 격리가 중복 실행되지 않도록 `inProgressIds`와 `quarantineRecords`를 검사합니다.

```js
// src/isolation/quarantine-service.js
if (this.inProgressIds.has(incident.id) || this.quarantineRecords.has(incident.id)) {
  return;
}
this.inProgressIds.add(incident.id);
```

### 5.2.3 격리 범위 결정

`responsePolicy.quarantineScope`에 따라 격리 대상이 달라집니다.

- `'incident-target'`: 사고가 발생한 감시 디렉터리만 격리 (기본값)
- `'all-watch-targets'`: 사고 발생 디렉터리 + 모든 감시 대상 디렉터리를 함께 격리

```js
// src/isolation/quarantine-service.js
function resolveQuarantineRootPaths({ incident, responsePolicy, watchTargets }) {
  if (responsePolicy.quarantineScope !== 'all-watch-targets') {
    return [incident.monitorRootPath].filter(Boolean);
  }
  return uniqueRootPaths([
    incident.monitorRootPath,
    ...watchTargets.map((target) => target?.rootPath)
  ]);
}
```

### 5.2.4 3단계 대응 흐름

`responsePolicy` 설정에 따라 다음 3가지 대응을 조합합니다. 실제 실행 순서는 "즉시 차단"을 우선하도록 구성되어 있어 단순한 1→2→3 순차 실행은 아닙니다.

1. **시스템 종료 요청** (`shutdownSystem: true`): 가장 먼저 `systemctl poweroff --force --force` 또는 `poweroff -f`를 요청합니다.
2. **의심 프로세스 종료** (`killSuspectProcesses: true`): `shutdownSystem`이 꺼져 있으면 권한 잠금과 병렬에 가깝게 먼저 시작하고, 권한 잠금 후 결과를 확인합니다. `shutdownSystem`이 켜져 있으면 권한 잠금 이후 보조 단계로 실행됩니다.
3. **권한 잠금** (`lockDirectoryPermissions: true`): 원래 권한을 기록한 뒤 `chmod 000`으로 모든 파일과 디렉터리의 접근 권한을 제거합니다.

```js
// src/isolation/quarantine-service.js
// 3단계 대응은 즉시 차단을 우선해 OS 종료 요청을 가장 먼저 보낸다.
if (responsePolicy.shutdownSystem) {
  const shutdownResult = await requestSystemShutdown();
  // ...
}
```

### 5.2.5 원래 권한 스냅샷

격리 실행 전, `collectPermissions()`가 대상 디렉터리 하위의 모든 파일과 폴더 권한을 재귀적으로 수집합니다.

```js
// src/isolation/quarantine-service.js
async function collectPermissions(rootPath) {
  const entries = [];
  async function walk(currentPath) {
    const stat = await fs.stat(currentPath);
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    entries.push({ filePath: currentPath, originalMode: mode, entryType: stat.isDirectory() ? 'dir' : 'file' });
    // ...재귀 탐색
  }
  await walk(rootPath);
  return entries;
}
```

수집된 권한 정보는 `quarantineRecords` Map에 `incidentId`를 키로 저장됩니다.

### 5.2.6 프로세스 종료 안전장치

프로세스 종료는 데모 환경에서만 허용됩니다. `SAFE_KILL_PATH_SEGMENT = 'demo-target'`로 제한하며, PID 1(시스템), 현재 프로세스, 부모 프로세스는 제외합니다. 또한 `/proc/<pid>/cwd`와 `/proc/<pid>/fd` 링크를 통해 실제로 해당 경로를 점유하는지 재검증합니다.

```js
// src/isolation/quarantine-service.js
function isSafeKillRoot(rootPath) {
  return path.resolve(rootPath).split(path.sep).includes(SAFE_KILL_PATH_SEGMENT);
}
```

---

## 5.3 실제 격리 스크립트 (`ops/scripts/quarantine.sh`)

`quarantine.sh`는 파일과 디렉터리의 접근 권한을 `chmod 000`으로 변경합니다. 파일을 이동하거나 삭제하지 않습니다.

```bash
#!/usr/bin/env bash
# ops/scripts/quarantine.sh

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
```

> **주의**: `README.md`에는 "파일 권한 400, 디렉터리 권한 500"이라고 기술되어 있지만, 실제 `quarantine.sh`와 `quarantine-service.js`의 fallback 로직은 모두 `chmod 000`을 사용합니다. 이 문서는 실제 코드를 기준으로 작성되었습니다.

---

## 5.4 권한 복원 흐름 (`src/isolation/quarantine-service.js`)

### 5.4.1 복원 요청

`restore(incidentId)`를 호출하면 `quarantineRecords`에서 해당 사고의 권한 기록을 조회합니다. 기록이 없으면 404 오류를 반환합니다.

```js
// src/isolation/quarantine-service.js
const record = this.quarantineRecords.get(incidentId);
if (!record) {
  const error = new Error(`incidentId ${incidentId}에 대한 격리 기록이 없습니다.`);
  error.statusCode = 404;
  throw error;
}
```

### 5.4.2 복원 실행

`restore.sh`를 entry 단위로 호출해 원래 기록된 모드로 권한을 복원합니다. 개별 실패는 기록되지만 전체 복원은 중단하지 않습니다.

```js
// src/isolation/quarantine-service.js
for (const rootRecord of records) {
  const progressItems = await restorePermissions(rootRecord.entries);
  // ...
}
```

복원이 완료되면 `quarantineRecords`에서 해당 기록을 삭제하고 `RESTORE_COMPLETED` 이벤트를 발행합니다.

---

## 5.5 실제 복원 스크립트 (`ops/scripts/restore.sh`)

`restore.sh`는 단일 파일 또는 폴더의 권한을 지정된 모드로 복원합니다.

```bash
#!/usr/bin/env bash
# ops/scripts/restore.sh

if chmod "$MODE" "$FILE_PATH" 2>/dev/null; then
  printf 'RESTORED\t%s\t%s\tsuccess\n' "$FILE_PATH" "$MODE"
else
  printf 'RESTORED\t%s\t%s\tfailed\n' "$FILE_PATH" "$MODE"
  exit 1
fi
```

> **주의**: `README.md`에는 "파일 644, 디렉터리 755"라고 기술되어 있지만, 실제 `restore.sh`는 격리 시 기록된 `originalMode`를 그대로 복원합니다. 고정된 644/755가 아닙니다.

---

## 5.6 격리 로깅 (`src/isolation/quarantine-logger.js`)

모든 격리 및 복원 이벤트는 `logs/quarantine.log`에 append-only JSONL 형태로 기록됩니다.

```js
// src/isolation/quarantine-logger.js
export async function appendLog(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, line, 'utf8');
  } catch {
    // 로깅 실패가 서비스를 중단시켜서는 안 된다
  }
}
```

지원하는 `eventType`:

- `quarantine_started`
- `quarantine_progress`
- `quarantine_completed`
- `quarantine_failed`
- `restore_requested`
- `restore_completed`
- `restore_failed`

로깅 실패는 서비스 중단으로 이어지지 않도록 예외를 무시합니다.

---

## 5.7 격리 작업 추적과 상태 수명주기

### 5.7.1 상태 전이 다이어그램

```
DETECTED
   |
   v
QUARANTINING  <-- QUARANTINE_STARTED 이벤트
   |
   +---> QUARANTINED  <-- QUARANTINE_COMPLETED 이벤트
   |        |
   |        v
   |   RESTORED  <-- restore API 호출 후 RESTORE_COMPLETED 이벤트
   |
   +---> FAILED  <-- QUARANTINE_FAILED / RESTORE_FAILED 이벤트
```

> 참고: `RESTORE_PENDING` 상수는 정의되어 있지만, 현재 구현은 복원 요청 시 별도 pending 상태로 전환하지 않고 `RESTORE_COMPLETED`에서 바로 `restored`로 갱신합니다.

### 5.7.2 격리 작업 목록

`IncidentStore`는 `quarantineJobs` 배열을 통해 격리 작업을 추적합니다.

```js
// src/incidents/incident-store.js
handleQuarantineStarted({ incidentId, rootPath, rootPaths, status }) {
  const existing = this.quarantineJobs.find(j => j.incidentId === incidentId);
  if (existing) {
    existing.status = status;
    existing.rootPath = rootPath ?? existing.rootPath;
    existing.rootPaths = rootPaths ?? existing.rootPaths;
  } else {
    this.quarantineJobs.unshift({ incidentId, rootPath, rootPaths, status });
  }
}
```

`QuarantineService`의 `getQuarantineJobs()`는 현재 격리 중인 작업 목록을 반환하며, `entryCount`(파일 수)와 `permissionEntryCount`(전체 entry 수)를 포함합니다.

---

## 5.8 권한 매트릭스

| 단계 | 파일 권한 | 디렉터리 권한 | 설명 |
|------|-----------|---------------|------|
| 격리 전 | 원래 모드 (예: 644, 755 등) | 원래 모드 | `collectPermissions()`로 스냅샷 저장 |
| 격리 중 | 000 | 000 | `quarantine.sh`가 `chmod 000` 실행 |
| 복원 후 | 기록된 원래 모드 | 기록된 원래 모드 | `restore.sh`가 기록된 모드로 복원 |

> 파일을 이동하거나 삭제하지 않고, 오직 권한만 변경합니다.

---

## 5.9 안전장치 요약

| 안전장치 | 구현 위치 | 내용 |
|----------|-----------|------|
| 중복 격리 방지 | `quarantine-service.js` | `inProgressIds` + `quarantineRecords`로 동일 사고 중복 실행 차단 |
| 범위 제한 | `quarantine-service.js` | `quarantineScope`로 `incident-target` 또는 `all-watch-targets` 선택 |
| 프로세스 종료 안전 | `quarantine-service.js` | `demo-target` 경로만 허용, PID 1/자신/부모 제외, `/proc` 재검증 |
| 로깅 실패 무시 | `quarantine-logger.js` | `appendFile` 실패 시 서비스 중단 방지 |
| 권한 기록 보존 | `quarantine-service.js` | `quarantineRecords` Map에 원래 권한을 메모리에 저장 |
| 복원 기록 삭제 | `quarantine-service.js` | 복원 완료 시 `quarantineRecords`에서 해당 기록 제거 |

---

## 5.10 미구현 사항 (향후 개선)

- 실시간 관리자 알림 기능은 현재 구현되어 있지 않습니다. `README.md`의 "관리자 알림 기능 추가"는 MVP 이후 개선 항목입니다.
- 파일 해시 기반 이상 탐지는 현재 미구현 상태입니다.

---

## 참고 소스 파일

- `src/incidents/incident-store.js`
- `src/isolation/quarantine-service.js`
- `src/isolation/quarantine-logger.js`
- `ops/scripts/quarantine.sh`
- `ops/scripts/restore.sh`
- `src/shared/contracts/event-names.js`
