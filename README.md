# Team404 - Linux 기반 랜섬웨어 의심 파일 행위 감시 및 자동 격리 시스템

## 팀 정보

### 팀명
404

### 조원
- 어승경 (2023203068) - 팀장
- 정시은 (2025404032)
- 방주현 (2025403033)
- 정연진 (2025404018)
- 염도윤 (2026403019)

---

# 프로젝트 소개

Linux 환경에서 특정 디렉터리 및 파일 시스템 이벤트를 실시간 감시하고,
랜섬웨어와 유사한 비정상 파일 행위가 발생했을 때 이를 탐지하여 자동으로 기록·격리하는 시스템입니다.

본 프로젝트는 실제 악성코드를 제작하거나 실행하지 않으며,
교육 목적의 랜섬웨어 대응 시뮬레이션 시스템으로 구현되었습니다.

데모 환경에서는 실제 랜섬웨어 대신 다음과 같은 랜섬웨어 유사 행위를 모의합니다.

- 짧은 시간 내 대량 파일 수정
- 파일명 변경
- 특정 확장자 생성
- 반복적인 파일 쓰기 작업
- Base64 기반 mock encryption 수행

탐지 이후에는 자동으로:

- 이상 행위 기록
- incident 생성
- 디렉터리 접근 제한
- 실시간 대시보드 전송
- 복구 처리

를 수행합니다.

---

# 핵심 기능

- Linux 파일 시스템 이벤트 감시
- create / modify / rename 이벤트 탐지
- 확장자 기반 위험도(weight) 계산
- 랜섬웨어 유사 행위 자동 탐지
- 자동 격리 및 접근 제한
- 프로세스 종료 정책 지원
- 시스템 종료 정책 지원
- 실시간 WebSocket 대시보드
- 데모 시뮬레이션 지원
- 복구(restore) 기능 지원

---

# Detection Strategy

파일 확장자별 위험도를 weight로 계산하여,
짧은 시간 내 누적 weight가 threshold를 초과할 경우 랜섬웨어 유사 행위로 판단합니다.

기본 정책:

- 1초(bucket window) 내 이벤트 누적
- create / modify / rename 이벤트 대상
- delete 이벤트는 탐지 제외
- threshold 초과 시 RULE_MATCH 생성

예시 weight:

| Extension | Weight |
|---|---|
| txt | 0.1 |
| zip | 0.3 |
| exe | 0.5 |
| unknown | 1.0 |

---

# System Flow

```text
MonitorService
→ FS_EVENT
→ RuleEngine
→ RULE_MATCH
→ IncidentStore
→ INCIDENT_OPENED
→ QuarantineService
→ QUARANTINE_COMPLETED
→ Dashboard / WebSocket Broadcast
