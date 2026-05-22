# 파일 감시 시스템 상세 설계

이 문서는 Team 404의 Linux 랜섬웨어 모니터링 시스템에서 파일 시스템 이벤트를 수집하고 정규화하는 3개 핵심 컴포넌트를 설명합니다.

- `ops/config/monitor.sh` — inotifywait 기반 쉘 감시기
- `src/collector/monitor-event-parser.js` — 원시 출력 파싱 및 이벤트 정규화
- `src/collector/monitor-service.js` — 백엔드 관리자 (데모 모드, 재시작, 폴백 지원)

---

## 1. monitor.sh — inotifywait 기반 쉘 감시기

`ops/config/monitor.sh`는 Linux `inotifywait` 도구를 래핑하여 감시 대상 디렉터리의 파일 이벤트를 실시간으로 스트리밍합니다.

### 1.1 실행 방식

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 ]]; then
  echo "usage: monitor.sh <root> [<root> ...]" >&2
  exit 1
fi
```

(`ops/config/monitor.sh`, 줄 1–7)

하나 이상의 감시 루트 경로를 인자로 받습니다. 인자가 없으면 사용법을 출력하고 종료합니다.

### 1.2 감시 이벤트 종류

```bash
inotifywait -m -r \
  -q \
  -e create -e modify -e delete -e moved_from -e moved_to \
  --format $'%w%f\t%e' \
  -- "$@" |
```

(`ops/config/monitor.sh`, 줄 9–13)

| 옵션 | 의미 |
|------|------|
| `-m` | 모니터 모드 (이벤트를 계속 출력) |
| `-r` | 재귀 감시 (하위 디렉터리 포함) |
| `-q` | quiet 모드 (감시 설정 메시지 생략) |
| `-e create` | 파일/디렉터리 생성 |
| `-e modify` | 파일 내용 수정 |
| `-e delete` | 파일/디렉터리 삭제 |
| `-e moved_from` | 이동 출발 (rename의 이전 경로) |
| `-e moved_to` | 이동 도착 (rename의 새 경로) |

`inotifywait`는 `move`라는 단일 이벤트 대신 `moved_from`과 `moved_to`를 각각 별도로 전달합니다. 이는 이후 파서에서 rename 이벤트로 병합하는 근거가 됩니다.

### 1.3 출력 형식

```bash
  while IFS= read -r line; do
    ts=${EPOCHREALTIME/./}
    printf '%s\t%s\n' "${ts:0:13}" "$line"
  done
```

(`ops/config/monitor.sh`, 줄 14–17)

각 줄은 **탭(`\t`)으로 구분된 3개 필드**로 구성됩니다.

1. **timestamp** — `EPOCHREALTIME`에서 소수점을 제거한 뒤 앞 13자리 (밀리초 단위 Unix timestamp)
2. **path** — `%w%f` (감시 디렉터리 + 상대/절대 파일 경로)
3. **events** — `%e` (쉼표로 구분된 이벤트 이름, 예: `CREATE,ISDIR`)

예시 출력:

```
1710000000123	/tmp/watch/file.txt	MODIFY
1710000000124	/tmp/watch/new.txt	CREATE
1710000000125	/tmp/watch/old.txt	MOVED_FROM
1710000000125	/tmp/watch/renamed.txt	MOVED_TO
```

---

## 2. monitor-event-parser.js — 파싱 및 정규화

`src/collector/monitor-event-parser.js`는 `monitor.sh`의 원시 출력과 `auditd` 로그를 읽어 **공통 구조(`FS_EVENT`)로 정규화**합니다.

### 2.1 FS_EVENT 구조

`src/shared/contracts/event-names.js`에 정의된 파일 이벤트 타입은 다음과 같습니다.

```js
export const FILE_EVENT_TYPES = Object.freeze({
  CREATE: 'create',
  MODIFY: 'modify',
  DELETE: 'delete',
  RENAME: 'rename'
});
```

(`src/shared/contracts/event-names.js`, 줄 21–26)

정규화된 FS_EVENT는 다음 필드를 포함합니다.

| 필드 | 설명 |
|------|------|
| `id` | UUID (고유 식별자) |
| `type` | `create`, `modify`, `delete`, `rename` 중 하나 |
| `observedTs` | 밀리초 단위 Unix timestamp (숫자) |
| `observedAt` | ISO 8601 문자열 |
| `path` | 이벤트가 발생한 파일 경로 |
| `previousPath` | `rename`일 경우 이전 경로, 그 외 `undefined` |
| `monitorTargetId` | 감시 대상 설정 ID |
| `monitorRootPath` | 감시 대상 루트 경로 |
| `rawEvents` | 원시 이벤트 토큰 배열 |
| `source` | `'inotify'` 또는 `'auditd'` |

### 2.2 monitor.sh 출력 파싱 — parseMonitorLine

```js
export function parseMonitorLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const [timestampRaw, filePath, rawEvents] = trimmed.split('\t');
  if (!timestampRaw || !filePath || !rawEvents) {
    return null;
  }

  const observedTs = parseObservedTimestamp(timestampRaw);
  if (observedTs === null) {
    return null;
  }

  const tokens = rawEvents
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);

  const rawType = RAW_EVENT_ORDER.find((token) => tokens.includes(token));
  if (!rawType) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    observedTs,
    observedAt: new Date(observedTs).toISOString(),
    path: filePath,
    rawEvents: tokens,
    rawType: normalizeRawType(rawType)
  };
}
```

(`src/collector/monitor-event-parser.js`, 줄 13–47)

`parseMonitorLine`은 탭 구분 출력을 3개 필드로 분리하고, `RAW_EVENT_ORDER` 우선순위에 따라 하나의 대표 이벤트 타입을 선택합니다.

```js
const RAW_EVENT_ORDER = ['MOVED_FROM', 'MOVED_TO', 'CREATE', 'MODIFY', 'DELETE'];
```

(`src/collector/monitor-event-parser.js`, 줄 6)

이 우선순위는 `MOVED_FROM`이 가장 먼저 처리되도록 하여, rename 병합 로직이 정확히 동작하도록 합니다.

### 2.3 Rename 이벤트 병합 — MonitorEventNormalizer

`inotifywait`는 rename을 `MOVED_FROM` + `MOVED_TO` 두 개의 독립 이벤트로 전달합니다. `MonitorEventNormalizer`는 이를 하나의 `rename`으로 병합합니다.

```js
export class MonitorEventNormalizer {
  constructor({ targets, movePairWindowMs }) {
    this.targets = sortTargets(targets);
    this.movePairWindowMs = movePairWindowMs;
    this.pendingMoves = [];
  }
```

(`src/collector/monitor-event-parser.js`, 줄 77–82)

#### 병합 규칙

1. `MOVED_FROM`이 들어오면 `pendingMoves` 버퍼에 임시 저장합니다.
2. 이후 `MOVED_TO`가 들어오면, `movePairWindowMs` 이내이고 **동일한 감시 대상 루트 내**에서 이동했는지 확인합니다.
3. 조건이 맞으면 `RENAME` 이벤트를 생성하고 `previousPath`에 `MOVED_FROM`의 경로를 기록합니다.
4. 조건이 맞지 않으면 `MOVED_TO`는 `CREATE`로, 버퍼에 남은 `MOVED_FROM`은 `DELETE`로 각각 처리됩니다.

```js
  consume(rawEvent) {
    const emitted = this.flushExpired(rawEvent.observedTs);

    switch (rawEvent.rawType) {
      case 'moved_from':
        this.pendingMoves.push(rawEvent);
        return emitted;
      case 'moved_to': {
        const match = this.findMoveMatch(rawEvent);
        if (match) {
          emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.RENAME, rawEvent, match.path));
        } else {
          emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.CREATE, rawEvent));
        }
        return emitted;
      }
      case 'create':
        emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.CREATE, rawEvent));
        return emitted;
      case 'modify':
        emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.MODIFY, rawEvent));
        return emitted;
      case 'delete':
        emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.DELETE, rawEvent));
        return emitted;
      default:
        return emitted;
    }
  }
```

(`src/collector/monitor-event-parser.js`, 줄 84–112)

#### 타임아웃 처리

`movePairWindowMs`를 초과한 `MOVED_FROM`은 `flushExpired`에서 `DELETE`로 강제 방출됩니다.

```js
  flushExpired(nowTs) {
    const keep = [];
    const emitted = [];

    for (const pending of this.pendingMoves) {
      if (nowTs - pending.observedTs > this.movePairWindowMs) {
        emitted.push(this.toCanonicalEvent(FILE_EVENT_TYPES.DELETE, pending));
      } else {
        keep.push(pending);
      }
    }

    this.pendingMoves = keep;
    return emitted;
  }
```

(`src/collector/monitor-event-parser.js`, 줄 122–136)

#### 동일 대상 내 이동 vs. 대상 간 이동

```js
  // target 디렉토리 간 이동: delete + create
  // 동일 target 내 디렉토리 간 이동: rename
  findMoveMatch(rawEvent) {
    const nextTarget = resolveTarget(rawEvent.path, this.targets);
    const index = this.pendingMoves.findIndex((pending) => {
      const withinWindow = rawEvent.observedTs - pending.observedTs <= this.movePairWindowMs;
      if (!withinWindow || !nextTarget) {
        return false;
      }

      const pendingTarget = resolveTarget(pending.path, this.targets);
      return pendingTarget?.rootPath === nextTarget.rootPath;
    });
```

(`src/collector/monitor-event-parser.js`, 줄 138–150)

- **동일 감시 대상 내 이동** → `rename`
- **서로 다른 감시 대상 간 이동** → `delete` + `create` (별개 이벤트)

### 2.4 auditd 로그 파싱 — AuditdEventNormalizer

`auditd` 모드에서는 `/var/log/audit/audit.log`를 tailing합니다. `AuditdEventNormalizer`는 audit 로그 레코드를 그룹화하여 FS_EVENT로 변환합니다.

#### 그룹화 기준

`msg=audit(<timestamp>:<auditId>)` 형식의 공통 키로 레코드를 그룹화합니다.

```js
export function parseAuditdRecord(line) {
  const match = trimmed.match(/^type=([^\s]+)\s+msg=audit\((\d+(?:\.\d+)?):(\d+)\):\s*(.*)$/);
  if (!match) {
    return null;
  }

  const [, type, timestampRaw, auditId, fieldsRaw] = match;
  // ...
  return {
    type,
    auditId,
    eventKey: `${timestampRaw}:${auditId}`,
    // ...
  };
}
```

(`src/collector/monitor-event-parser.js`, 줄 49–75)

#### 완성 조건 및 필터링

하나의 audit 이벤트는 `SYSCALL`, `PATH`, `CWD`, `PROCTITLE` 등 여러 레코드로 구성됩니다. `toCanonicalEvent`는 다음 조건을 모두 만족해야 이벤트를 생성합니다.

```js
  toCanonicalEvent(entry) {
    const syscall = entry.records.find((record) => record.type === 'SYSCALL');
    const paths = entry.records.filter((record) => record.type === 'PATH');
    const cwd = entry.records.find((record) => record.type === 'CWD');
    const proctitle = entry.records.find((record) => record.type === 'PROCTITLE');

    if (!syscall || paths.length === 0 || syscall.fields.success !== 'yes') {
      return null;
    }

    if (!entry.records.some((record) => record.fields.key === this.auditKey)) {
      return null;
    }
```

(`src/collector/monitor-event-parser.js`, 줄 255–267)

| 필터 조건 | 설명 |
|-----------|------|
| `SYSCALL` 레코드 존재 | 시스템콜 정보 필수 |
| `PATH` 레코드 1개 이상 | 대상 경로 정보 필수 |
| `success === 'yes'` | 실패한 시스템콜 무시 |
| `key === auditKey` | 감시 규칙과 일치하는 key만 처리 |

#### auditd 이벤트 타입 추론

```js
function inferAuditdEventType(syscallRaw, paths) {
  const syscall = String(syscallRaw ?? '').toLowerCase();
  const nameTypes = new Set(paths.map((record) => String(record.fields.nametype ?? '').toUpperCase()));

  if (RENAME_SYSCALLS.has(syscall) || (nameTypes.has('DELETE') && nameTypes.has('CREATE'))) {
    return FILE_EVENT_TYPES.RENAME;
  }

  if (DELETE_SYSCALLS.has(syscall) || nameTypes.has('DELETE')) {
    return FILE_EVENT_TYPES.DELETE;
  }

  if (CREATE_SYSCALLS.has(syscall) || nameTypes.has('CREATE')) {
    return FILE_EVENT_TYPES.CREATE;
  }

  if (nameTypes.has('NORMAL') || nameTypes.has('PARENT')) {
    return FILE_EVENT_TYPES.MODIFY;
  }

  return null;
}
```

(`src/collector/monitor-event-parser.js`, 줄 308–329)

| 시스템콜 / nametype | 추론 결과 |
|---------------------|-----------|
| `rename`, `renameat`, `renameat2` 또는 `DELETE`+`CREATE` 동시 존재 | `rename` |
| `unlink`, `unlinkat`, `rmdir` 또는 `DELETE` | `delete` |
| `creat`, `mkdir`, `mknod` 등 또는 `CREATE` | `create` |
| `NORMAL` 또는 `PARENT` | `modify` |

#### auditd 전용 메타데이터

`auditd` 소스의 FS_EVENT에는 프로세스 추적에 유용한 추가 필드가 포함됩니다.

```js
    return {
      id: crypto.randomUUID(),
      type,
      // ... 기본 필드 ...
      source: 'auditd',
      auditEventId: entry.auditId,
      pid: parseOptionalInteger(syscall.fields.pid),
      ppid: parseOptionalInteger(syscall.fields.ppid),
      uid: parseOptionalInteger(syscall.fields.uid),
      auid: parseOptionalInteger(syscall.fields.auid),
      comm: syscall.fields.comm ?? null,
      exe: syscall.fields.exe ?? null,
      cwd: cwd?.fields.cwd ?? null,
      proctitle: decodeProctitle(proctitle?.fields.proctitle)
    };
```

(`src/collector/monitor-event-parser.js`, 줄 284–304)

---

## 3. monitor-service.js — 백엔드 관리자

`src/collector/monitor-service.js`는 감시 프로세스의 생명주기를 관리합니다. 백엔드 선택, 재시작, 데모 모드 전환, 감시 대상 경로 변경을 지원합니다.

### 3.1 지원 백엔드

```js
const BACKEND_MODES = new Set(['auto', 'auditd', 'inotify']);
```

(`src/collector/monitor-service.js`, 줄 12)

| 모드 | 동작 |
|------|------|
| `auto` | `auditd`를 먼저 시도하고, 실패하면 `inotify`로 폴백 |
| `auditd` | `auditd`만 사용. 실패 시 `degraded` 상태로 전환, 폴백 없음 |
| `inotify` | `inotifywait` 기반 쉘 스크립트만 사용 |

### 3.2 auto 모드 폴백 흐름

```js
    const auditdStarted = await this.startBackend(AUDITD_BACKEND, { allowFailure: false });
    if (auditdStarted) {
      return;
    }

    await this.startBackend(INOTIFY_BACKEND, { allowFailure: true });
```

(`src/collector/monitor-service.js`, 줄 65–70)

`auto` 모드에서 `auditd` 시작이 실패하면 `fallbackReason`에 실패 메시지를 기록하고 `inotify`로 전환합니다.

```js
      if (this.getRequestedBackend() === 'auto' && backendName === AUDITD_BACKEND && !allowFailure) {
        this.fallbackReason = error.message;
        this.activeBackend = null;
        this.status = 'starting';
        this.emitHealth('starting');
        return false;
      }
```

(`src/collector/monitor-service.js`, 줄 174–180)

### 3.3 InotifyMonitorBackend

`InotifyMonitorBackend`는 `monitor.sh`를 자식 프로세스로 실행하고 stdout을 line-by-line으로 읽습니다.

```js
  spawnProcess() {
    const roots = this.watchContext.targets.map((target) => target.rootPath);
    const command = 'bash';
    const args = [this.config.monitor.scriptPath, ...roots];

    this.child = spawn(command, args, {
      cwd: this.config.meta.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
```

(`src/collector/monitor-service.js`, 줄 297–305)

#### 재시작 로직

자식 프로세스가 비정상 종료하면 `restartDelayMs` 후 자동 재시작합니다.

```js
  scheduleRestart() {
    if (this.restartTimer || this.isStopping) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartCount += 1;
      this.spawnProcess();
    }, this.config.monitor.restartDelayMs);
  }
```

(`src/collector/monitor-service.js`, 줄 362–372)

#### 종료 시 잔여 이벤트 방출

백엔드가 중지되면 `normalizer.flushAll()`을 호출하여 버퍼에 남은 `MOVED_FROM` 이벤트를 모두 `DELETE`로 방출합니다.

```js
    const trailingEvents = this.normalizer.flushAll();
    for (const event of trailingEvents) {
      this.emitFsEvent(event);
    }
```

(`src/collector/monitor-service.js`, 줄 258–261)

### 3.4 AuditdMonitorBackend

`AuditdMonitorBackend`는 `auditctl`로 감시 규칙을 등록하고, `tail -F /var/log/audit/audit.log`로 로그를 스트리밍합니다.

```js
  async registerRules() {
    for (const target of this.watchContext.targets) {
      await this.commandRunner(['-w', target.rootPath, '-p', 'wa', '-k', this.auditKey]);
    }
  }

  async cleanupRules() {
    await this.commandRunner(['-D', '-k', this.auditKey]);
  }
```

(`src/collector/monitor-service.js`, 줄 462–470)

- `-w` : 감시 경로 등록
- `-p wa` : write(`w`)와 attribute(`a`) 변경 감시
- `-k team404_watch` : 감시 규칙 식별 키
- `-D -k team404_watch` : 해당 키의 규칙 일괄 삭제

`AuditdMonitorBackend`도 `InotifyMonitorBackend`와 동일하게 종료 시 잔여 이벤트를 방출하고, 비정상 종료 시 자동 재시작합니다.

### 3.5 데모 모드 및 감시 대상 변경

`MonitorService`는 런타임에 감시 대상을 동적으로 변경할 수 있습니다.

#### 데모 모드

```js
  if (watchOptions.demo) {
    const baseTarget = defaultTarget ?? createFallbackTarget();
    const activeTarget = {
      ...baseTarget,
      id: 'demo-target',
      rootPath: resolveDemoTargetPath(projectRoot),
      demoAllowed: true,
      mode: 'demo'
    };
```

(`src/collector/monitor-service.js`, 줄 581–589)

`watchOptions.demo`가 `true`면, 설정된 감시 대상 대신 프로젝트 내 데모 전용 디렉터리를 감시합니다. 이는 악성코드를 실행하지 않고 시뮬레이션을 안전하게 수행하기 위한 기능입니다.

#### 수동 대상 경로 지정

```js
  if (Array.isArray(watchOptions.targetPaths) && watchOptions.targetPaths.length > 0) {
    const targets = watchOptions.targetPaths.map((targetPath, index) => ({
      ...baseTarget,
      id: `manual-${index + 1}`,
      rootPath: path.resolve(targetPath),
      mode: 'target',
      demoAllowed: false
    }));
```

(`src/collector/monitor-service.js`, 줄 598–606)

API나 CLI를 통해 임의의 경로를 감시 대상으로 지정할 수 있습니다. 이때 `mode`는 `'target'`이 되며, `demoAllowed`는 `false`로 설정됩니다.

#### 동적 변경 및 재시작

```js
  async setWatchOptions(watchOptions = {}) {
    const shouldRestart = this.watchRequested;

    if (shouldRestart) {
      await this.stop();
    }

    this.watchContext = resolveWatchContext(/* ... */);

    if (shouldRestart) {
      await this.start();
    }
```

(`src/collector/monitor-service.js`, 줄 88–104)

`setWatchOptions`는 현재 감시 중이면 먼저 중지하고, 대상을 변경한 뒤 다시 시작합니다.

### 3.6 상태 및 건강 정보

`getHealth()`는 현재 백엔드 상태를 종합하여 반환합니다.

```js
  getHealth() {
    const backendHealth = this.backend?.getHealth?.() ?? this.backendHealth ?? {};
    // ...
    return {
      status: this.status,
      pid: backendHealth.pid ?? null,
      lastEventAt: backendHealth.lastEventAt ?? null,
      lastError: this.lastError ?? backendHealth.lastError ?? null,
      restartCount: backendHealth.restartCount ?? 0,
      requestedBackend,
      activeBackend,
      fallbackReason: this.fallbackReason,
      pidTrackingAvailable: activeBackend === AUDITD_BACKEND && this.status === 'running',
      // ...
    };
  }
```

(`src/collector/monitor-service.js`, 줄 128–149)

| 필드 | 설명 |
|------|------|
| `status` | `idle`, `starting`, `running`, `degraded`, `stopped` |
| `activeBackend` | 실제로 동작 중인 백엔드 이름 |
| `fallbackReason` | `auto` 모드에서 `auditd` 실패 시 기록 |
| `pidTrackingAvailable` | `auditd` 모드에서만 프로세스 추적 가능 |
| `restartCount` | 비정상 종료 후 자동 재시작 횟수 |

---

## 4. 이벤트 정규화 요약

| 원시 소스 | 원시 이벤트 | 정규화 결과 | 비고 |
|-----------|-------------|-------------|------|
| inotify | `CREATE` | `create` | — |
| inotify | `MODIFY` | `modify` | — |
| inotify | `DELETE` | `delete` | — |
| inotify | `MOVED_FROM` + `MOVED_TO` (동일 대상) | `rename` | `previousPath` 포함 |
| inotify | `MOVED_FROM` (타임아웃) | `delete` | 짝이 없으면 delete로 폴백 |
| inotify | `MOVED_TO` (짝 없음) | `create` | — |
| auditd | `SYSCALL` + `PATH` (CREATE) | `create` | `pid`, `exe` 등 메타데이터 포함 |
| auditd | `SYSCALL` + `PATH` (DELETE) | `delete` | — |
| auditd | `SYSCALL` + `PATH` (RENAME) | `rename` | `previousPath` 포함 |
| auditd | `SYSCALL` + `PATH` (NORMAL/PARENT) | `modify` | — |
| auditd | 불완전 레코드 | 버림 | `SYSCALL` 또는 `PATH` 누락 시 무시 |

---

## 5. 테스트 기반 검증

`test/monitor-event-parser.test.js`와 `test/monitor-service.test.js`는 다음 핵심 동작을 검증합니다.

### 5.1 파서 테스트

- `parseMonitorLine`이 밀리초/초 단위 timestamp를 모두 호환 처리함 (`test/monitor-event-parser.test.js`, 줄 6–20)
- `MOVED_FROM` + `MOVED_TO`가 동일 대상 내에서 `rename`으로 병합됨 (줄 22–38)
- 서로 다른 하위 디렉터리 간 이동도 동일 대상으로 인식하여 `rename` 처리됨 (줄 40–56)
- `AuditdEventNormalizer`가 `pid`, `comm`, `exe`, `cwd` 등 메타데이터를 추출함 (줄 59–88)
- 불완전한 audit 레코드는 `flushAll` 시 버려짐 (줄 90–99)
- `DELETE` + `CREATE` nametype 조합이 `rename`으로 매핑됨 (줄 101–121)

### 5.2 서비스 테스트

- 설정된 모든 대상을 기본으로 사용함 (`test/monitor-service.test.js`, 줄 39–52)
- `demo` 플래그로 데모 모드 전환 가능 (줄 54–66)
- `targetPath`로 수동 대상 지정 가능 (줄 68–79, 81–96)
- `setWatchOptions`로 런타임에 모드 토글 및 복원 가능 (줄 98–128)
- `auto` 모드에서 `auditd` 우선 시도 후 `inotify` 폴백 (줄 131–155)
- `auditd` 실패 시 `fallbackReason` 기록 (줄 157–180)
- `auditd` 단독 모드 실패 시 `degraded` 상태, 폴백 없음 (줄 182–204)
- 백엔드 모드 변경 시 자동 재시작 (줄 206–229)

---

## 6. 참고 파일 목록

| 파일 | 역할 |
|------|------|
| `ops/config/monitor.sh` | inotifywait 기반 쉘 감시기 |
| `src/collector/monitor-event-parser.js` | 원시 출력 파싱, rename 병합, auditd 정규화 |
| `src/collector/monitor-service.js` | 백엔드 생명주기 관리, 데모/대상 변경, 재시작 |
| `src/shared/contracts/event-names.js` | `FS_EVENT`, `FILE_EVENT_TYPES` 상수 정의 |
| `test/monitor-event-parser.test.js` | 파서 및 정규화 단위 테스트 |
| `test/monitor-service.test.js` | 서비스 상태 및 백엔드 전환 테스트 |
