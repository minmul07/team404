# 04. 탐지 엔진 상세 설계

## 개요

팀 404의 랜섬웨어 탐지 시스템은 파일 시스템 이벤트를 실시간으로 분석하여 랜섬웨어와 유사한 비정상 행위를 식별합니다. 본 문서는 `src/rules/rule-engine.js`와 `src/rules/extension-weight-loader.js`를 중심으로 탐지 엔진의 동작 원리, 정책 구조, 그리고 확장자 기반 가중치 체계를 설명합니다.

---

## 1. 탐지 엔진 아키텍처 (`src/rules/rule-engine.js`)

### 1.1 핵심 개념: 확장자 가중치 버스트 탐지

탐지 엔진은 현재 하나의 규칙, `extension-weight-burst`를 운영합니다. 이 규칙은 특정 감시 대상(target)에서 짧은 시간 내에 발생하는 파일 이벤트들의 확장자 가중치 합계가 임계치를 초과하면 `RULE_MATCH` 이벤트를 발생시킵니다.

```javascript
const BURST_RULE_ID = 'extension-weight-burst';
const DETECTABLE_EVENT_TYPES = new Set([
  FILE_EVENT_TYPES.CREATE,
  FILE_EVENT_TYPES.MODIFY,
  FILE_EVENT_TYPES.RENAME
]);
```

탐지 대상 이벤트는 `create`, `modify`, `rename` 세 가지입니다. `delete` 이벤트는 탐지 계산에서 제외됩니다. 이는 랜섬웨어가 파일을 암호화한 뒤 원본을 삭제하는 행위보다, 암호화된 파일을 생성하거나 기존 파일을 수정·이름을 바꾸는 행위가 더 직접적인 탐지 지표이기 때문입니다.

### 1.2 대상별 버킷(per-target buckets)

`RuleEngine`은 각 감시 대상(`monitorTargetId` 또는 `monitorRootPath`)마다 독립적인 가중치 버킷을 유지합니다.

```javascript
this.bucketsByTarget = new Map();
```

버킷은 다음과 같은 구조를 가집니다.

```javascript
function createBucket(targetKey) {
  return {
    targetKey,
    totalWeight: 0,
    events: [],
    extensions: [],
    lastEvent: null,
    lastEventWeight: 0,
    matched: false
  };
}
```

- `totalWeight`: 해당 대상에서 누적된 가중치 합계
- `events`: 수집된 파일 이벤트 목록
- `matched`: 이미 탐지된 상태인지 여부 (중복 탐지 방지)

이 구조 덕분에 감시 대상 A에서의 이벤트가 감시 대상 B의 탐지에 영향을 주지 않습니다.

### 1.3 가중치 계산

개별 이벤트의 가중치는 다음 공식으로 계산됩니다.

```
eventWeight = getExtensionWeight(extension) * getEventMultiplier(event.type)
```

예를 들어, `.locked` 확장자(의심 확장자, 가중치 2)에 대한 `rename` 이벤트(배율 1.5)의 가중치는 `2 * 1.5 = 3`이 됩니다.

### 1.4 임계치 초과 및 탐지 발생

버킷의 `totalWeight`가 `thresholdWeight`를 초과하고, 해당 버킷이 아직 `matched` 상태가 아니라면 `RULE_MATCH` 이벤트가 발생합니다.

```javascript
if (bucket.totalWeight <= thresholdWeight || bucket.matched) {
  return;
}
```

`RULE_MATCH` 이벤트는 다음 정보를 포함합니다.

| 필드 | 설명 |
|------|------|
| `id` | UUID 기반 고유 식별자 |
| `ruleId` | `extension-weight-burst` |
| `ruleName` | `Extension Weight Burst` |
| `severity` | `critical` (고정) |
| `autoQuarantine` | `true` (고정) |
| `reason` | 가중치 초과 설명 문자열 |
| `thresholdWeight` | 설정된 임계치 |
| `totalWeight` | 누적 가중치 |
| `eventCount` | 누적 이벤트 수 |
| `samplePaths` | 최대 10개의 대표 경로 |
| `eventTypes` | 발생한 이벤트 유형 목록 |
| `suspectProcesses` | 관련 프로세스 정보 |

---

## 2. 중복 탐지 방지 (Cooldown)

탐지 엔진은 `matched` 플래그를 이용해 중복 탐지를 방지합니다. 한 번 임계치를 초과하여 `RULE_MATCH`가 발생한 버킷은 `matched = true`로 설정됩니다. 이후에도 해당 버킷의 가중치가 임계치를 유지하더라도 추가 탐지 이벤트는 발생하지 않습니다.

```javascript
bucket.matched = true;
```

중복 탐지가 다시 가능해지려면 두 가지 조건 중 하나를 만족해야 합니다.

1. **가중치 감소(decay)**: 시간이 지나면서 가중치가 감소하여 임계치 이하로 내려가면 `matched`가 `false`로 해제됩니다.
2. **수동 초기화**: `resetWeights()`를 호출하여 모든 버킷을 초기화합니다.

이 방식은 동일한 대상에 대한 연속적인 이벤트 폭주 상황에서 불필요한 다중 알림을 막습니다.

---

## 3. 가중치 감소 메커니즘 (Decay)

`RuleEngine`은 주기적으로 누적 가중치를 감소시키는 decay 타이머를 운영합니다.

```javascript
this.decayTimer = setInterval(() => {
  this.applyWeightDecay();
}, decay.intervalMs);
```

기본 설정은 1000ms(1초)마다 가중치를 1씩 감소시킵니다. 감소 후 가중치가 임계치 이하로 내려가면 해당 버킷의 `matched` 상태가 해제되어 다시 탐지가 가능해집니다. 가중치가 0 이하로 떨어지면 버킷은 메모리에서 삭제됩니다.

```javascript
const nextWeight = Math.max(0, bucket.totalWeight - decay.amount);
if (bucket.totalWeight <= thresholdWeight) {
  bucket.matched = false;
}
```

Decay는 이벤트가 멈춘 후에도 과거 누적 가중치가 영구히 남아있는 것을 방지하여, 오래된 이벤트가 새로운 탐지에 계속 영향을 주는 문제를 막습니다.

---

## 4. 확장자 가중치 로더 (`src/rules/extension-weight-loader.js`)

### 4.1 확장자 분류 체계

모든 파일 확장자는 다음 네 가지 범주 중 하나로 분류됩니다.

| 범주 | 설명 | 기본 가중치 |
|------|------|------------|
| `knownExtension` | `ops/common-file-extensions.json`에 등록된 일반 확장자 | 0.1 |
| `unknownExtension` | 등록되지 않은 확장자 | 1 |
| `noExtension` | 확장자가 없는 파일 | 1 |
| `suspiciousExtension` | 랜섬웨어 관련 의심 확장자 | 2 |

### 4.2 확장자 사전 (`ops/common-file-extensions.json`)

`ops/common-file-extensions.json`에는 3D, archive, audio, book, code, exec, font, image, sheet, slide, text, video, web 등 13개 카테고리의 일반적인 파일 확장자가 정의되어 있습니다. 총 300개 이상의 확장자가 포함되어 있으며, 이 목록은 `knownExtension`의 기준으로 사용됩니다.

```json
{
  "3D": ["3ds", "f3d", "3mf", "smt", "stp", "step", "stl", "obj", "gcode", "scad"],
  "archive": ["7z", "zip", "tar", "gz", "rar", "bz2", "xz", "..."],
  "code": ["c", "cpp", "js", "py", "java", "go", "rs", "..."],
  "...": "..."
}
```

### 4.3 의심 확장자 목록

`ops/default-detection-policy.json`에는 공개된 랜섬웨어가 사용하는 확장자들이 `suspiciousExtensions`로 등록되어 있습니다.

```json
[
  "locked", "encrypted", "warning", "decrypt", "ransom",
  "recover", "pay", "wncry", "wcry", "locky", "odin",
  "djvu", "rumba", "radman", "gero", "xtbl", "crysis",
  "crypt", "lock", "crypted", "dharma", "wallet", "onion",
  "faust", "conti", "play", "hive", "akira", "akiranew",
  "lockbit", "snatch"
]
```

이 목록에는 WannaCry(`wncry`), Locky(`locky`), Conti(`conti`), Hive(`hive`), LockBit(`lockbit`) 등 공개된 랜섬웨어 패밀리의 확장자가 포함되어 있습니다.

### 4.4 이벤트 배율

이벤트 유형별로 가중치에 곱해지는 배율이 다릅니다.

```json
{
  "create": 1,
  "modify": 1,
  "rename": 1.5
}
```

`rename`은 파일 확장자를 강제로 변경하는 랜섬웨어의 전형적 행위이므로 1.5배의 높은 배율을 적용받습니다.

### 4.5 사용자 정의 설정

`loadExtensionWeights` 함수는 다음 두 가지 사용자 정의 설정을 지원합니다.

- **`detectionPolicy`**: 임계치, 가중치, 배율, decay, 의심 확장자 목록 등을 재정의
- **`customExtensionWeights`**: 특정 확장자에 대한 가중치를 개별적으로 지정

```javascript
loadExtensionWeights({
  customExtensionWeights: {
    zip: 0.9,
    md: 0.05
  }
});
```

---

## 5. 탐지 정책 구조 (`ops/default-detection-policy.json`)

기본 탐지 정책은 다음과 같은 구조를 가집니다.

```json
{
  "thresholdWeight": 10,
  "weights": {
    "knownExtension": 0.1,
    "unknownExtension": 1,
    "noExtension": 1,
    "suspiciousExtension": 2
  },
  "eventMultipliers": {
    "create": 1,
    "modify": 1,
    "rename": 1.5
  },
  "weightDecay": {
    "intervalMs": 1000,
    "amount": 1
  },
  "userAllowedExtensions": [],
  "suspiciousExtensions": ["locked", "encrypted", "..."]
}
```

### 5.1 정책 정규화 (`src/shared/config/detection-policy.js`)

`detection-policy.js`는 외부에서 전달된 정책을 내부 표준 형태로 정규화합니다. 누락된 필드는 기본값으로 채워지고, 잘못된 타입이나 음수 값은 검증 오류를 발생시킵니다.

```javascript
export function normalizeDetectionPolicy(rawPolicy = {}) {
  if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
    throw new Error('detectionPolicy must be an object');
  }
  return normalizeDetectionPolicyShape(rawPolicy, DEFAULT_DETECTION_POLICY);
}
```

정규화 과정에서 확장자는 소문자로 변환되고, 앞의 점(`.`)은 제거됩니다.

```javascript
export function normalizeExtension(ext) {
  const trimmed = ext.trim();
  return trimmed.startsWith('.') ? trimmed.slice(1).toLowerCase() : trimmed.toLowerCase();
}
```

---

## 6. 탐지 기준 요약

| 기준 | 설명 | 기본값 |
|------|------|--------|
| 임계치(`thresholdWeight`) | 버킷 가중치 합계가 이 값을 초과하면 탐지 | 10 |
| 탐지 이벤트 | `create`, `modify`, `rename` | - |
| 제외 이벤트 | `delete` | - |
| 의심 확장자 가중치 | 랜섬웨어 확장자에 적용 | 2 |
| 일반 확장자 가중치 | `common-file-extensions.json`에 등록된 확장자 | 0.1 |
| 미지 확장자 가중치 | 등록되지 않은 확장자 | 1 |
| 확장자 없음 가중치 | 확장자가 없는 파일 | 1 |
| rename 배율 | 이름 변경 이벤트 가중치 배율 | 1.5 |
| create/modify 배율 | 생성·수정 이벤트 가중치 배율 | 1 |
| 감소 주기 | 가중치 감소 타이머 간격 | 1000ms |
| 감소량 | 한 번에 감소하는 가중치 | 1 |
| 심각도 | 탐지 발생 시 할당되는 심각도 | `critical` |
| 자동 격리 | 탐지 시 자동 격리 여부 | `true` |

---

## 7. 탐지 예시

### 시나리오: `.locked` 파일 다수 생성

가정: `thresholdWeight = 10`, `.locked`는 의심 확장자(가중치 2), `create` 배율은 1.

| 순서 | 이벤트 | 확장자 가중치 | 배율 | 이벤트 가중치 | 누적 가중치 | 탐지 여부 |
|------|--------|--------------|------|--------------|------------|----------|
| 1 | `create` | 2 | 1 | 2 | 2 | - |
| 2 | `create` | 2 | 1 | 2 | 4 | - |
| 3 | `create` | 2 | 1 | 2 | 6 | - |
| 4 | `create` | 2 | 1 | 2 | 8 | - |
| 5 | `create` | 2 | 1 | 2 | 10 | - |
| 6 | `create` | 2 | 1 | 2 | 12 | **탐지** |

6번째 이벤트에서 누적 가중치 12가 임계치 10을 초과하여 `RULE_MATCH`가 발생합니다. 이후에도 같은 대상에서 추가 이벤트가 발생하더라도 `matched` 플래그가 설정되어 있으므로 중복 탐지는 발생하지 않습니다.

### 시나리오: 다양한 확장자 혼합

| 순서 | 이벤트 | 확장자 | 확장자 가중치 | 배율 | 이벤트 가중치 | 누적 가중치 |
|------|--------|--------|--------------|------|--------------|------------|
| 1 | `modify` | `.txt` | 0.1 | 1 | 0.1 | 0.1 |
| 2 | `rename` | `.locked` | 2 | 1.5 | 3 | 3.1 |
| 3 | `create` | `.unknown` | 1 | 1 | 1 | 4.1 |
| 4 | `rename` | `.encrypted` | 2 | 1.5 | 3 | 7.1 |
| 5 | `modify` | `.crysis` | 2 | 1 | 2 | 9.1 |
| 6 | `create` | `.zip` | 0.1 | 1 | 0.1 | 9.2 |
| 7 | `rename` | `.wncry` | 2 | 1.5 | 3 | **12.2** |

7번째 이벤트에서 탐지가 발생합니다. 이 예시는 일반 파일 수정과 의심 확장자 변경이 혼재된 상황에서도 누적 가중치가 임계치를 초과하면 탐지가 이루어짐을 보여줍니다.

---

## 8. 정책 설정 예시

```json
{
  "thresholdWeight": 15,
  "weights": {
    "knownExtension": 0.1,
    "unknownExtension": 1.5,
    "noExtension": 1,
    "suspiciousExtension": 3
  },
  "eventMultipliers": {
    "create": 1,
    "modify": 1.2,
    "rename": 2
  },
  "weightDecay": {
    "intervalMs": 2000,
    "amount": 2
  },
  "userAllowedExtensions": [".backup", ".old"],
  "suspiciousExtensions": [
    "locked", "encrypted", "ransom", "pay"
  ]
}
```

이 설정은 다음과 같은 의도를 반영합니다.

- 임계치를 15로 높여 민감도를 낮춤
- `rename` 배율을 2로 높여 이름 변경 행위에 더 민감하게 반응
- `.backup`과 `.old`를 사용자 허용 확장자로 등록하여 의심 확장자 오분류 방지
- decay 간격을 2초로 늘려 가중치 감소 속도 조절

---

## 9. 테스트 검증

탐지 엔진의 동작은 `test/rule-engine.test.js`와 `test/extension-weight-loader.test.js`에서 검증됩니다.

### rule-engine 테스트 항목

- 임계치 초과 시 `RULE_MATCH` 발생
- 임계치 미만 시 탐지 미발생
- `matched` 플래그를 통한 중복 탐지 방지
- decay 적용 후 재탐지 가능
- `resetWeights()`를 통한 수동 초기화
- 이벤트 배율(`rename` 1.5배 등) 적용
- `delete` 이벤트 무시
- 대상별 버킷 독립성

### extension-weight-loader 테스트 항목

- 일반 확장자(`txt`, `sh`, `zip`)의 기본 가중치(0.1) 확인
- 사용자 정의 가중치 오버라이드
- 미지/누락 확장자의 `unknownExtension` 가중치 적용
- 의심 확장자 및 사용자 허용 확장자 정책 반영
- 이벤트 배율 정책 적용

---

## 10. 한계 및 향후 개선 방향

현재 탐지 엔진은 확장자 기반 가중치 버스트 방식으로 구현되어 있습니다. 이 방식은 랜섬웨어의 전형적인 파일 변조 패턴을 효과적으로 포착하지만, 다음과 같은 추가 개선이 가능합니다.

- **파일 해시 기반 이상 탐지**: 동일 파일의 내용 급변을 해시 변화로 감지
- **디렉터리별 민감도 설정**: 중요도가 다른 감시 대상마다 별도의 임계치 적용
- **행위 패턴 기반 탐지**: 단순 가중치 합계를 넘어 이벤트 시퀀스 패턴 분석

> 참고: 머신러닝 기반 탐지는 현재 구현되지 않았으며, 향후 연구 과제로 남아있습니다.

---

## 참고 파일

- `src/rules/rule-engine.js` — 탐지 엔진 핵심 구현
- `src/rules/extension-weight-loader.js` — 확장자 가중치 로딩 및 분류
- `src/shared/config/detection-policy.js` — 정책 정규화 및 기본값 관리
- `ops/default-detection-policy.json` — 기본 탐지 정책 설정
- `ops/common-file-extensions.json` — 일반 확장자 분류 사전
- `test/rule-engine.test.js` — 탐지 엔진 단위 테스트
- `test/extension-weight-loader.test.js` — 확장자 가중치 단위 테스트
