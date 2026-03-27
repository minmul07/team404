# 프로젝트 한눈에 보기

## 이 프로젝트는 무엇을 만들었나

이 프로젝트는 크게 보면 하나의 HTTP 서버를 실행합니다. 그런데 그 서버 안에는 두 역할이 같이 들어 있습니다.

1. **MCP 서버**
   사용자가 호출할 도구(`greet`, `get_current_time`, `who_am_i`, `admin_ping`)를 제공한다.
2. **OAuth 인증 서버**
   "누가 어떤 scope로 이 도구를 써도 되는지"를 확인하고, access token과 refresh token을 발급한다.

보통 초심자는 "도구를 제공하는 서버"와 "로그인/토큰을 처리하는 인증 서버"를 별개로 생각하는데, 이 프로젝트는 학습과 실험을 쉽게 하려고 두 기능을 한 저장소 안에서 함께 다루고 있습니다.

## 왜 이런 프로젝트가 필요한가

MCP 도구 자체를 만드는 것은 생각보다 간단합니다. 하지만 다음 조건이 붙는 순간 난도가 올라갑니다.

- 도구를 아무나 쓰게 하고 싶지 않다.
- 사용자별 권한(scope)을 나누고 싶다.
- ChatGPT 같은 외부 MCP 클라이언트가 안전하게 접속하도록 만들고 싶다.

즉, 이 저장소의 핵심은 "도구를 만든다"보다 "도구를 인증된 방식으로 노출한다"에 더 가깝습니다.

## 전체 구조를 아주 단순하게 그리면

```text
사용자/클라이언트
    |
    | 1) MCP 서버 정보 조회
    | 2) OAuth 메타데이터 조회
    | 3) 로그인 및 승인
    | 4) 토큰 발급
    | 5) 토큰을 들고 도구 호출
    v
fastmcp_client.py
    |
    +-- FastMCP 서버
    |     |
    |     +-- greet
    |     +-- get_current_time
    |     +-- who_am_i
    |     +-- admin_ping
    |
    +-- build_auth()
          |
          +-- custom  -> oauth/chatgpt_oauth.py
          +-- github  -> FastMCP 내장 GitHub provider
          +-- google  -> FastMCP 내장 Google provider
          +-- oidc    -> FastMCP OIDCProxy
          +-- none    -> 인증 없음
```

## 이 프로젝트에서 가장 중요한 사실 5개

### 1. 서버 진입점은 `fastmcp_client.py`다

이 파일이 FastMCP 서버 객체를 만들고, 인증 provider를 붙이고, MCP 도구를 등록하고, 마지막에 HTTP 서버를 실행합니다.

### 2. 기본 인증 방식은 `custom`이다

환경 변수를 따로 주지 않으면 `FASTMCP_OAUTH_PROVIDER=custom`으로 동작합니다. 이때 실제 인증 로직의 중심은 [`oauth/chatgpt_oauth.py`](../oauth/chatgpt_oauth.py)입니다.

### 3. `oauth/chatgpt_oauth.py`는 그냥 보조 파일이 아니다

이 파일은 매우 중요합니다. 단순 설정 파일이 아니라 아래 기능을 직접 구현합니다.

- 클라이언트 등록
- 승인 화면 표시
- authorization code 생성
- access token / refresh token 발급
- 토큰 검증
- 토큰 폐기
- OAuth 메타데이터 노출

즉, 이 파일 하나가 "작은 인증 서버"처럼 동작합니다.

### 4. `.fastmcp/`는 런타임 상태 저장소다

인증 과정에서는 일회용 코드, access token, refresh token, 등록된 클라이언트 정보 같은 상태가 생깁니다. 이 프로젝트는 그런 상태를 데이터베이스 대신 `.fastmcp/` 아래 JSON 파일들로 저장합니다.

### 5. 이 저장소는 학습용으로 이해하기 좋게 만들어져 있다

실제 상용 서비스는 보통 승인 UI, 사용자 DB, 세션 저장소, 외부 로그인 연동이 더 복잡합니다. 하지만 이 프로젝트는 구조를 눈으로 따라가기 쉽게 하기 위해:

- 개발용 사용자 목록을 JSON으로 둔다.
- 승인 화면을 간단한 HTML로 직접 렌더링한다.
- 토큰 상태를 파일로 저장한다.

덕분에 초심자가 흐름을 추적하기 좋습니다.

## 도구는 무엇을 하나

### `greet`

입력받은 이름으로 인사 문자열을 반환합니다. 가장 단순한 예제 도구입니다.

### `get_current_time`

현재 시간을 ISO 형식 문자열로 돌려줍니다. 인증이 끝난 뒤 가장 쉽게 시험해볼 수 있는 도구입니다.

### `who_am_i`

현재 요청에 포함된 access token을 읽어서 다음 정보를 보여줍니다.

- 인증 여부
- client id
- scopes
- claims
- resource

즉, "토큰이 진짜 잘 들어왔는지"를 확인하는 디버깅용 도구입니다.

### `admin_ping`

`admin` scope가 있는지 확인하는 도구입니다. 권한 분리 예제를 보여주기 위해 존재합니다.

## 이 프로젝트를 이해하는 가장 좋은 읽기 순서

1. [`fastmcp_client.py`](../fastmcp_client.py)가 서버를 어떻게 띄우는지 본다.
2. [`oauth/chatgpt_oauth.py`](../oauth/chatgpt_oauth.py)가 인증 서버 역할을 어떻게 구현하는지 본다.
3. [`oauth/fastmcp_oauth.py`](../oauth/fastmcp_oauth.py)로 클라이언트가 어떤 식으로 접속하는지 본다.
4. `.fastmcp/`가 왜 필요한지 떠올린다.
5. 마지막으로 "브라우저 승인 페이지가 왜 필요한가"를 생각해본다.

## 초심자가 흔히 헷갈리는 지점

### "MCP 서버면 도구만 있으면 되는 거 아닌가?"

인증이 없으면 가능합니다. 하지만 이 프로젝트는 "인증된 도구 서버"를 보여주기 때문에, 도구 외에도 OAuth 메타데이터와 토큰 발급 흐름이 필요합니다.

### "왜 로그인 페이지가 이 프로젝트 안에 있나?"

기본 `custom` 모드는 외부 로그인 서비스 대신 이 프로젝트가 직접 간단한 승인 UI를 제공합니다. 그래서 `/oauth/approve` 페이지가 존재합니다.

### "왜 ChatGPT 연결에는 공개 URL이 필요한가?"

ChatGPT는 여러분의 로컬 `127.0.0.1`에 직접 접속할 수 없습니다. 따라서 ChatGPT가 접근할 수 있는 공개 주소가 필요합니다. 이 문제는 [실행 방법과 실험 가이드](06-run-guide.md)에서 다시 설명합니다.

## 다음 문서

다음은 [MCP와 OAuth 기초](02-mcp-oauth-basics.md)입니다. 여기서는 코드 설명 전에 꼭 알아야 할 개념을 최대한 쉬운 말로 정리합니다.
