# Team404 Development Notes

## 현재 구현 완료 기능

### 파일 시스템 감시
- Linux 기반 inotifywait 연동 구현
- create / modify / delete / rename 이벤트 수집
- moved_from + moved_to 기반 rename 이벤트 정규화
- monitor 프로세스 자동 재시작 처리
- multi-target 감시 구조 지원
- demo mode 및 targetPath 변경 지원

### 탐지 엔진
- threshold 기반 이상 행위 탐지 구현
- extension weight 기반 탐지 로직 구현
- create / modify / rename 이벤트 기반 탐지
- bucket window 기반 누적 계산 처리
- severity 및 autoQuarantine 정책 처리
- RULE_MATCH 이벤트 생성

### Incident 및 Alert 관리
- incident 생성 및 상태 관리 구현
- alert 저장 및 조회 기능 구현
- active incident 관리 구현
- severity 우선순위 처리

### 자동 격리 및 복구
- autoQuarantine 기반 자동 격리 구현
- 디렉터리 권한 잠금 처리
- quarantine 상태 관리 구현
- restore 기반 파일 및 권한 복구 구현
- quarantine / restore 이벤트 처리 구현

### REST API 서버
- health API 구현
- snapshot API 구현
- incidents / alerts 조회 API 구현
- quarantine job 조회 API 구현
- response policy API 구현
- demo start / stop / reset API 구현
- watch target 변경 API 구현
- watch toggle API 구현
- restore API 구현

### Dashboard 및 WebSocket
- WebSocket broadcast 구조 구현
- 실시간 FS_EVENT 전송 구현
- RULE_MATCH 이벤트 전송 구현
- quarantine 상태 이벤트 전송 구현
- dashboard 연동 구조 구현

### Demo 시뮬레이션
- Base64 기반 mock encryption 구현
- .demo.locked 파일 생성 구현
- demo restore 기능 구현
- demo reset 기능 구현
- demo log 저장 기능 구현

### Runtime 및 시스템 구조
- runtime 기반 전체 모듈 연결 구현
- eventBus 기반 모듈 통신 구조 구현
- snapshot 및 health 상태 관리 구현
- response policy 상태 관리 구현
- monitor lifecycle 관리 구현

### 테스트 코드
- API 테스트 구현
- runtime 테스트 구현
- monitor-service 테스트 구현
- rule-engine 테스트 구현
- integration 테스트 구현
- quarantine-service 테스트 구현
- extension-weight-loader 테스트 구현

---

# 최종 시연 흐름

```text
npm run dev 실행
↓
monitor service 시작
↓
demo-target 감시 활성화
↓
랜섬웨어 유사 행위 발생
↓
FS_EVENT 생성
↓
RuleEngine threshold 초과 탐지
↓
RULE_MATCH 생성
↓
incident 생성
↓
autoQuarantine 수행
↓
권한 잠금 수행
↓
dashboard 및 websocket 상태 변경 확인
↓
restore API 실행
↓
파일 복구 및 권한 복원 확인
