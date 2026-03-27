# 인증과 요청 흐름 추적

이 문서는 "실제로 요청이 어떻게 흐르는가"를 단계별로 설명합니다. 초심자가 가장 어려워하는 부분이 바로 여기입니다. 함수 하나하나보다도 **전체 흐름**이 먼저 잡혀야 코드를 읽을 수 있습니다.

## 1. 먼저 큰 그림

기본 `custom` 모드에서의 큰 흐름은 아래와 같습니다.

```text
클라이언트
  -> 서버 메타데이터 조회
  -> OAuth 클라이언트 등록
  -> 사용자 승인 페이지로 이동
  -> authorization code 획득
  -> access token / refresh token 교환
  -> access token을 들고 MCP 도구 호출
  -> 서버가 토큰을 읽고 scope 확인 후 결과 반환
```

이 과정에서 핵심 파일은 두 개입니다.

- [`fastmcp_client.py`](../fastmcp_client.py)
- [`oauth/chatgpt_oauth.py`](../oauth/chatgpt_oauth.py)

## 2. 서버 시작 시 무슨 일이 일어나나

### 단계 1. 환경 변수 읽기

서버는 [`fastmcp_client.py`](../fastmcp_client.py)의 `build_auth()`에서 `FASTMCP_OAUTH_PROVIDER`를 읽습니다.

가능한 값:

- `custom`
- `github`
- `google`
- `oidc`
- `none`

아무 값도 없으면 기본적으로 `custom`입니다.

### 단계 2. 인증 provider 생성

`custom`이면 `ChatGPTCustomOAuthProvider`를 만듭니다.  
다른 값이면 FastMCP가 제공하는 내장 provider 또는 `OIDCProxy`를 사용합니다.

즉, 서버 실행 시점에 이미 "어떤 인증 전략을 쓸지" 결정됩니다.

### 단계 3. FastMCP 앱 생성

`mcp = FastMCP("OAuth MCP Server", auth=build_auth())`

여기서 만들어진 `mcp` 객체가 이후 모든 도구와 라우트의 중심이 됩니다.

### 단계 4. 루트 라우트와 도구 등록

서버는:

- `/` 루트 정보 엔드포인트
- `greet`
- `get_current_time`
- `who_am_i`
- `admin_ping`

를 등록합니다.

### 단계 5. HTTP 서버 실행

맨 아래의 `mcp.run(...)`이 실제 서버를 띄웁니다. 이때 `/mcp` 경로로 MCP 요청을 받습니다.

## 3. `custom` provider에서 인증은 어떻게 시작되나

이제부터가 진짜 중요한 부분입니다.

### 단계 1. 클라이언트가 메타데이터를 본다

클라이언트는 보통 아래 URL들을 조회해 인증 방법을 파악합니다.

- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource/mcp`

이 정보는 [`oauth/chatgpt_oauth.py`](../oauth/chatgpt_oauth.py)의 `get_routes()`와 `_build_metadata()` 흐름을 통해 제공됩니다.

쉽게 말하면:

- "로그인은 어디로 가야 하나?"
- "토큰은 어디서 받나?"
- "지원 scope는 뭔가?"

를 알려주는 단계입니다.

### 단계 2. 클라이언트 등록

ChatGPT 같은 클라이언트는 자기 redirect URI와 기타 정보를 서버에 알려야 합니다.  
이 프로젝트에서는 `/register`가 그 역할을 합니다.

[`oauth/chatgpt_oauth.py`](../oauth/chatgpt_oauth.py)의 `_handle_registration()`이 다음을 검사합니다.

- `grant_types`에 `authorization_code`, `refresh_token`이 있는가
- `response_types`에 `code`가 있는가
- 요청한 scope가 유효한가
- redirect URI가 허용 목록 안에 있는가

통과하면 새 `client_id`를 만들어 `clients` 저장소에 넣습니다.

## 4. 사용자 승인 단계는 어떻게 흘러가나

### 단계 3. authorize 요청 수신

클라이언트가 인증 시작을 요청하면 provider의 `authorize()`가 호출됩니다.

이 단계에서 서버는 다음을 정리합니다.

- 어떤 클라이언트인지
- 어떤 redirect URI를 쓸지
- 어떤 scope를 요청했는지
- 어떤 resource를 대상으로 하는지
- 어떤 PKCE `code_challenge`를 쓸지
- 요청이 언제 만료되는지

이 정보는 `PendingAuthorization` 객체로 만들어져 `pending` 저장소에 기록됩니다.

그리고 서버는 브라우저를 아래 주소로 보내라고 알려줍니다.

```text
/oauth/approve?txn=...
```

여기서 `txn`은 "아직 끝나지 않은 승인 거래"를 찾기 위한 식별자입니다.

### 단계 4. 승인 페이지 표시

브라우저가 `/oauth/approve?txn=...`로 들어오면 `_handle_approval()`의 GET 분기가 실행됩니다.

이 함수는:

- `txn`이 있는지 확인
- `pending` 저장소에서 해당 거래를 찾기
- 만료 여부 확인
- 승인 HTML 렌더링

을 수행합니다.

### 단계 5. 사용자가 개발용 계정을 선택

승인 페이지는 실제 소셜 로그인 대신, 개발용 사용자 목록 중 하나를 고르게 합니다.

사용자 목록 출처:

- `FASTMCP_DEV_USERS_FILE`가 있으면 그 JSON 파일
- 없으면 코드에 내장된 기본 사용자 목록

즉, 이 프로젝트는 "사용자 로그인"을 완전히 구현한 것이 아니라, **OAuth 승인 흐름을 학습하기 위한 간단한 사용자 선택기**를 둔 것입니다.

### 단계 6. authorization code 발급

사용자가 폼을 제출하면 `_handle_approval()`의 POST 분기가 실행됩니다.

이때 서버는 다음을 검사합니다.

- transaction이 아직 유효한가
- 선택한 사용자가 실제로 존재하는가
- 그 사용자가 요청된 scope를 모두 가지고 있는가

통과하면 `AuthorizationCodeRecord`를 만들고 `codes` 저장소에 저장합니다.  
그 후 `pending` 항목은 삭제합니다.  
마지막으로 클라이언트를 redirect URI로 되돌리면서 `code`와 `state`를 붙여 줍니다.

## 5. 토큰 발급은 어떻게 되나

### 단계 7. authorization code 교환

클라이언트는 받은 authorization code를 access token으로 바꾸려고 합니다.  
이때 `exchange_authorization_code()`가 관여합니다.

서버는:

- 해당 code가 실제로 존재하는가
- 이미 쓰인 적 없는가
- 이 code가 같은 client_id에 속하는가
- resource가 맞는가

를 확인한 뒤 `_issue_token_pair()`를 호출합니다.

### 단계 8. access token / refresh token 생성

`_issue_token_pair()`는 JWT issuer를 이용해:

- access token
- refresh token

을 생성합니다.

그리고 단순히 토큰 문자열만 반환하는 것이 아니라, 별도의 저장소에도 상태를 남깁니다.

- `access` 저장소
- `refresh` 저장소

이렇게 해야 나중에 만료 체크, revoke, refresh 교환이 가능합니다.

## 6. 도구 호출 시 서버는 무엇을 하나

### 단계 9. 클라이언트가 `/mcp`로 도구 호출

클라이언트는 이제 access token을 포함해서 `/mcp`로 요청합니다.

예를 들어:

- `get_current_time`
- `who_am_i`
- `admin_ping`

같은 도구를 호출할 수 있습니다.

### 단계 10. 서버가 access token을 읽는다

`who_am_i()`는 `get_access_token()`을 감싼 `_current_token()`으로 현재 토큰을 꺼냅니다.

따라서 `who_am_i`는 "요청에 실린 인증 정보가 실제로 서버에서 어떻게 보이는지"를 보여주는 좋은 관찰 도구입니다.

### 단계 11. scope 검사

`admin_ping()`는 `_require_runtime_scopes("admin")`를 호출합니다.

여기서 중요한 점:

- 도구 메타데이터에도 필요한 scope가 적혀 있음
- 하지만 런타임에도 한 번 더 검사함

이중 체크를 하는 이유는 보안상 메타데이터 선언만 믿지 않고, 실제 요청 토큰의 scope를 직접 확인하기 위해서입니다.

## 7. refresh token 흐름

토큰이 만료되면 클라이언트는 refresh token으로 새 access token을 받을 수 있습니다.

관련 함수:

- `load_refresh_token()`
- `exchange_refresh_token()`

흐름은 다음과 같습니다.

1. refresh token JWT를 검증
2. 저장소에 기록이 있는지 확인
3. client_id와 만료 시각을 확인
4. 요청 scope가 원래 허용 범위를 넘지 않는지 확인
5. 기존 토큰 쌍을 폐기
6. 새 토큰 쌍을 발급

즉, 이 구현은 refresh 시점에 토큰을 회전시키는 구조입니다.

## 8. revoke는 어떻게 동작하나

`revoke_token()`은 access token인지 refresh token인지 확인한 뒤, 관련된 토큰 쌍을 저장소에서 삭제합니다.

이 구현에서는 access와 refresh가 연결되어 있으므로 한쪽을 revoke할 때 다른 쪽도 함께 정리됩니다.

## 9. 왜 `custom` provider는 ChatGPT 친화적인가

이 구현은 다음을 직접 제공하기 때문입니다.

- well-known 메타데이터
- dynamic client registration
- redirect URI 검증
- 승인 화면
- JWT 기반 토큰 발급
- protected resource metadata

즉, ChatGPT 같은 클라이언트가 "일반적인 OAuth 서버가 해 줘야 하는 것"을 이 프로젝트 안에서 찾을 수 있게 만든 것입니다.

## 10. 다른 provider는 어떻게 다른가

### `github`

GitHub OAuth App 정보를 환경 변수로 받아 FastMCP 내장 provider를 사용합니다.  
여기서는 인증 세부 구현을 직접 쓰지 않고 라이브러리에 많이 맡깁니다.

### `google`

Google OAuth client 정보를 환경 변수로 받아 내장 provider를 사용합니다.  
필수 scope로 `openid`, `userinfo.email` 등을 둘 수 있습니다.

### `oidc`

Auth0, Keycloak, Azure AD 같은 일반 OIDC 공급자를 붙이기 위한 경로입니다.  
이 경우 `OIDCProxy`가 핵심입니다.

### `none`

인증을 끄는 모드입니다. MCP 서버 구조만 확인할 때 편합니다.

## 11. 흐름을 한 장으로 다시 요약

```text
1. 서버 시작
   fastmcp_client.py -> build_auth() -> provider 선택

2. 클라이언트 준비
   client가 메타데이터 조회

3. 클라이언트 등록
   /register -> client_id 저장

4. 승인 시작
   authorize() -> pending transaction 저장

5. 브라우저 승인
   /oauth/approve -> 사용자 선택

6. code 발급
   codes 저장 -> redirect URI로 code 전달

7. 토큰 교환
   access/refresh 발급 및 저장

8. 도구 호출
   /mcp + bearer token

9. 런타임 권한 검사
   who_am_i / admin_ping 등 실행
```

## 다음 문서

다음은 [파일별 상세 해설](05-file-walkthrough.md)입니다. 여기서는 각 파일 내부의 함수와 클래스까지 더 세밀하게 설명합니다.
