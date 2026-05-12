# 📌 Team404 개발 계획 (Plan)

# 현재 진행 상태

## 완료된 항목
- Linux 파일 시스템 이벤트 감시 구현
- monitor.sh 기반 inotifywait 연동 구현
- create / modify / delete / rename 이벤트 정규화 구현
- threshold 기반 이상 행위 탐지 엔진 구현
- incident 및 alert 상태 관리 구현
- autoQuarantine 기반 자동 격리 구현
- restore 기반 권한 복구 기능 구현
- REST API 서버 구현
- runtime 및 eventBus 기반 모듈 연결 구현
- demo 모드 실행 구조 구현
- 주요 기능 테스트 코드 구현

---

# 📌 남은 작업 계획

# 1. Dashboard 기능 마무리

## 목표
탐지 및 격리 결과를 시각적으로 확인할 수 있는 웹 대시보드 완성

## 작업 항목
- health 상태 표시
- incident 목록 표시
- alert 목록 표시
- quarantine 상태 표시
- active target 표시
- demo mode 상태 표시
- snapshot API 연동
- auto refresh 처리
- 사용자 친화적 로그 표현 개선

## 관련 API
- GET /api/health
- GET /api/incidents
- GET /api/alerts
- GET /api/quarantine-jobs
- GET /api/snapshot

---

# 2. Demo 시뮬레이션 기능 보완

## 목표
랜섬웨어 유사 행위를 안정적으로 재현할 수 있는 demo 환경 구성

## 작업 항목
- 다량 modify 이벤트 발생 시나리오 구성
- 파일 rename 반복 시나리오 구성
- Base64 기반 파일 변조 시나리오 구성
- delete 이벤트 발생 시나리오 구성
- demo-target 자동 초기화 기능 검토
- demo 실행 절차 정리

---

# 3. 탐지 규칙(rule) 개선

## 목표
오탐을 줄이고 탐지 정확도 향상

## 작업 항목
- threshold 값 조정
- windowMs 조정
- incidentCooldownMs 조정
- rename 이벤트 탐지 보완
- 반복 modify 이벤트 처리 개선
- severity 기준 정교화

---

# 4. Quarantine 안정성 개선

## 목표
격리 및 복구 안정성 향상

## 작업 항목
- quarantine 중복 처리 방지 검증
- restore 실패 처리 보완
- 권한 복원 예외 처리 개선
- quarantine 상태 로그 개선

---

# 5. 로그 저장 기능 개선

## 목표
이벤트 및 incident 기록 보존 강화

## 작업 항목
- append-only 로그 파일 저장 검토
- incident 로그 분리 저장 검토
- quarantine 로그 저장 검토
- timestamp 기반 로그 정리

---

# 6. API 및 Runtime 안정화

## 목표
시스템 실행 안정성 향상

## 작업 항목
- API 예외 처리 보완
- invalid request 처리 강화
- runtime 종료 처리 검증
- monitor 재시작 처리 검증
- snapshot 응답 구조 정리

---

# 7. 테스트 코드 추가 및 보완

## 목표
핵심 기능 검증 강화

## 작업 항목
- quarantine-service 테스트 추가
- restore 기능 테스트 추가
- API restore 테스트 추가
- runtime 종료 테스트 추가
- monitor restart 테스트 추가

---

# 8. README 및 문서화 지속 업데이트

## 목표
팀원 및 조교가 프로젝트 구조를 쉽게 이해할 수 있도록 문서 유지

## 작업 항목
- API 구조 최신화
- 시스템 흐름 최신화
- app-config 설명 최신화
- 테스트 항목 최신화
- dashboard 사용 방법 추가
- demo 시연 절차 추가

---

# 9. 최종 발표 준비

## 목표
프로젝트 시연 및 발표 자료 완성

## 작업 항목
- 시스템 구조 정리
- 동작 흐름 정리
- 시연 시나리오 정리
- API 설명 정리
- 역할 분담 정리
- 문제 해결 과정 정리
- 개선 방향 정리

---

# 📌 예상 최종 시연 흐름

1. npm run dev -- --demo 실행
2. demo-target 디렉터리 감시 시작
3. 랜섬웨어 유사 행위 발생
4. monitor.sh 이벤트 감지
5. RuleEngine threshold 초과 탐지
6. incident 생성
7. autoQuarantine 실행
8. 파일 권한 잠금 수행
9. dashboard 및 API 상태 변경 확인
10. restore API 실행
11. 권한 복구 확인

---

# 📌 장기 개선 방향

- 파일 해시 기반 탐지 추가
- 머신러닝 기반 이상 탐지 검토
- 관리자 알림 기능 추가
- 실시간 websocket 연동 검토
- dashboard UI 개선
- 로그 시각화 기능 추가
- multi-target 감시 강화
