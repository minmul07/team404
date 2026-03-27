# 프로젝트 구조

이 문서는 "어떤 파일이 어디에 있고, 각 파일이 무슨 책임을 가지는가"를 정리합니다.

## 전체 파일 트리

현재 저장소의 중요한 파일만 추리면 대략 아래와 같습니다.

```text
team404/
├── README.md
├── README/
│   ├── 01-overview.md
│   ├── 02-mcp-oauth-basics.md
│   ├── 03-project-structure.md
│   ├── 04-auth-flow.md
│   ├── 05-file-walkthrough.md
│   └── 06-run-guide.md
├── fastmcp_client.py
├── oauth_setup.md
├── requirements.txt
├── uri.py
├── oauth/
│   ├── chatgpt_oauth.py
│   ├── dev_users.sample.json
│   └── fastmcp_oauth.py
└── .fastmcp/
    ├── custom-oauth/
    └── oauth-proxy/
```

`.fastmcp/`는 실행하면서 생기는 데이터라 Git에는 올라가지 않습니다.

## 책임 기준으로 나누면

### 1. 서버 핵심

- [`fastmcp_client.py`](../fastmcp_client.py)

이 파일은 프로젝트의 중심입니다.

- FastMCP 앱 생성
- 인증 provider 선택
- MCP 도구 등록
- 루트 정보 엔드포인트 등록
- HTTP 서버 실행

쉽게 말해 "프로젝트의 메인 함수가 있는 곳"입니다.

### 2. 인증 핵심

- [`oauth/chatgpt_oauth.py`](../oauth/chatgpt_oauth.py)

이 파일은 커스텀 OAuth provider 구현체입니다. 길이가 긴 이유가 분명합니다. 인증에서 필요한 상태와 로직 대부분을 이 파일이 담당합니다.

- 개발용 사용자 모델
- pending transaction 모델
- authorization code / token 저장 레코드
- JSON 파일 저장소
- 승인 화면 HTML
- 클라이언트 등록 처리
- authorize / token exchange / revoke 처리

### 3. 클라이언트 예제

- [`oauth/fastmcp_oauth.py`](../oauth/fastmcp_oauth.py)

이 파일은 "클라이언트가 이 서버를 어떻게 쓰는가"를 보여주는 가장 짧은 예제입니다.

- 서버 URL 읽기
- 원하는 scope 읽기
- OAuth 인증 객체 생성
- `Client(..., auth=oauth)`로 접속
- `ping`, `get_current_time`, `who_am_i` 호출

### 4. 개발용 데이터

- [`oauth/dev_users.sample.json`](../oauth/dev_users.sample.json)

승인 화면에서 선택할 개발용 사용자 목록입니다. 실제 서비스의 사용자 DB를 단순화한 버전이라고 보면 됩니다.

### 5. 짧은 메모성 문서

- [`oauth_setup.md`](../oauth_setup.md)
- [`RUN.md`](../RUN.md)

`oauth_setup.md`는 설정 요약 문서입니다.  
`RUN.md`는 개인 실행 메모 성격이 강하며 `.gitignore`에 들어 있어 Git 추적에서 제외됩니다.

### 6. 보조 파일

- [`requirements.txt`](../requirements.txt)
- [`uri.py`](../uri.py)
- [`.gitignore`](../.gitignore)

`requirements.txt`는 핵심 의존성을 보여줍니다.  
`uri.py`는 현재 프로젝트 코드에서 실제로 참조되지 않는 상수 파일입니다. 실험 중 남은 보조 파일로 보입니다. 이 역시 **현재 코드 검색 결과를 바탕으로 한 판단**입니다.

## 디렉터리별 역할

### `oauth/`

인증 관련 코드와 샘플 데이터가 들어 있습니다. 이름 그대로 "인증 기능"을 모아둔 영역입니다.

### `README/`

이번에 추가한 상세 설명 문서 모음입니다. 초심자가 한 번에 전체를 소화하기 어렵기 때문에 개념, 구조, 흐름, 파일 해설, 실행 가이드를 분리했습니다.

### `.fastmcp/`

런타임 상태 저장소입니다. 특히 `custom` provider를 쓸 때 중요합니다.

대표 하위 폴더:

- `clients`: 등록된 OAuth 클라이언트 정보
- `pending`: 아직 승인되지 않은 요청
- `codes`: 발급된 authorization code
- `access`: access token 상태
- `refresh`: refresh token 상태

이 디렉터리 구조는 [`oauth/chatgpt_oauth.py`](../oauth/chatgpt_oauth.py)의 `JsonCollection`과 provider 초기화 코드를 보면 이해할 수 있습니다.

## 파일을 읽는 가장 좋은 순서

### 1단계. `fastmcp_client.py`

먼저 메인 서버 파일을 봐야 전체 윤곽이 보입니다.

특히 다음을 유심히 보면 됩니다.

- `build_auth()`
- `mcp = FastMCP(...)`
- `@mcp.tool(...)`
- `if __name__ == "__main__":`

### 2단계. `oauth/chatgpt_oauth.py`

그다음 인증 부분을 봅니다. 이 파일은 길지만 아래 묶음으로 나눠 읽으면 됩니다.

- 데이터 모델
- 저장소 클래스
- provider 초기화
- 라우트 추가
- registration / authorize / token / revoke
- 승인 페이지 렌더링

### 3단계. `oauth/fastmcp_oauth.py`

이 파일은 짧아서 "클라이언트 입장에서 최소 무엇이 필요한가"를 정리해 줍니다.

## 구조를 책임 관점으로 다시 요약하면

```text
fastmcp_client.py
  = 앱 조립자

oauth/chatgpt_oauth.py
  = 인증 엔진

oauth/fastmcp_oauth.py
  = 클라이언트 테스트 코드

oauth/dev_users.sample.json
  = 개발용 사용자 목록

.fastmcp/
  = 인증 상태 저장소
```

## 초심자가 구조를 볼 때 가져가면 좋은 질문

- 이 파일은 "설정"인가, "실제 로직"인가?
- 이 파일은 서버 쪽인가, 클라이언트 쪽인가?
- 이 파일은 실행 시점에 호출되는가, 아니면 데이터만 담고 있는가?
- 이 파일이 없어지면 로그인 흐름이 깨지는가, 도구 호출이 깨지는가?

이 질문으로 보면 각 파일의 중요도가 빨리 보입니다.

## 다음 문서

다음은 [인증과 요청 흐름 추적](04-auth-flow.md)입니다. 여기서는 실제 요청이 어떤 순서로 움직이는지 단계별로 정리합니다.
