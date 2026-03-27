# 파일별 상세 해설

이 문서는 실제 코드를 따라가며 "이 함수가 왜 존재하는가"를 설명합니다. 코드 한 줄씩 복붙하기보다, **역할과 논리 흐름** 중심으로 읽는 것이 목표입니다.

## 1. `fastmcp_client.py`

이 파일은 서버의 메인 엔트리 포인트입니다.

## 1-1. `_parse_scopes`

문자열로 들어온 scope 목록을 파싱합니다.

예:

- `"mcp:use admin"`
- `"mcp:use,admin"`

둘 다 처리할 수 있게 쉼표를 공백으로 바꾼 뒤 분리합니다.

이 함수가 필요한 이유는 환경 변수 입력이 항상 깔끔하지 않기 때문입니다.

## 1-2. `_oauth_tool_meta`

각 도구에 붙일 OAuth 보안 메타데이터를 생성합니다.

예를 들어 `greet`와 `get_current_time`에는 `mcp:use`가, `admin_ping`에는 `admin`이 붙습니다.

이 메타데이터는 "이 도구를 쓰려면 어떤 scope가 필요한지"를 클라이언트에 알려주는 선언 역할을 합니다.

## 1-3. `_default_base_url`

서버의 기본 base URL을 결정합니다.

우선순위:

1. `FASTMCP_BASE_URL`
2. `FASTMCP_SCHEME`, `FASTMCP_HOST`, `FASTMCP_PORT`

이 값은 매우 중요합니다. OAuth 메타데이터, issuer, redirect, resource 판단이 전부 이 base URL에 기대기 때문입니다.

## 1-4. `_current_token`

`get_access_token()`을 안전하게 감싼 헬퍼입니다.

요청 컨텍스트 안에 access token이 있으면 가져오고, 없으면 `None`을 반환합니다.  
초심자 관점에서는 "현재 들어온 요청의 토큰을 읽는 함수"라고 이해하면 됩니다.

## 1-5. `_require_runtime_scopes`

런타임에 실제 토큰 scope를 검사합니다.

흐름:

1. 현재 토큰이 있는지 확인
2. 없으면 `Authentication required`
3. 토큰에 필요한 scope가 모두 있는지 확인
4. 없으면 `ToolError`

이 함수는 `admin_ping`에서 직접 쓰입니다.

## 1-6. `MCPContentTypeCompatibilityMiddleware`

이 미들웨어는 `/mcp` 요청의 `Content-Type`이 `application/octet-stream`으로 오는 경우 `application/json`으로 바꿔 줍니다.

의미:

- 예전 또는 일부 ChatGPT MCP 요청 형식과의 호환성 확보
- 서버가 JSON 요청으로 정상 처리할 수 있도록 보정

즉, 핵심 비즈니스 로직이라기보다 **호환성 패치**에 가깝습니다.

## 1-7. `build_auth`

이 파일에서 가장 중요한 함수 중 하나입니다.

역할:

- 어떤 인증 provider를 쓸지 결정
- 필요한 환경 변수를 읽어 객체 생성

분기별 의미:

### `none`

인증을 끕니다. `None`을 반환합니다.

### `custom`

기본값입니다.  
`ChatGPTCustomOAuthProvider`를 생성합니다.

이때 함께 읽는 값:

- `FASTMCP_ALLOWED_CLIENT_REDIRECT_URIS`
- `FASTMCP_DEV_USERS_FILE`
- `FASTMCP_AUTH_STORAGE_DIR`
- `FASTMCP_JWT_SIGNING_KEY`: provider가 발급할 JWT access/refresh token의 서명 기준이 되는 값

### `github`

FastMCP 내장 GitHub provider를 사용합니다.

### `google`

FastMCP 내장 Google provider를 사용합니다.

### `oidc`

`OIDCProxy`를 사용합니다.

정리하면 `build_auth()`는 "인증 백엔드 선택기"입니다.

## 1-8. `mcp = FastMCP(...)`

여기서 서버 객체가 만들어집니다.  
`auth=build_auth()`이므로 FastMCP 서버는 생성 시점부터 인증 provider와 결합됩니다.

## 1-9. `root_info`

`/`로 들어왔을 때 서버 상태를 JSON으로 보여줍니다.

반환 내용:

- 서버 이름
- MCP 경로
- 인증 활성화 여부
- 현재 provider 이름
- OAuth 메타데이터 URL
- protected resource metadata URL

이 엔드포인트는 디버깅과 확인에 매우 유용합니다.

## 1-10. MCP 도구들

### `greet`

문자열 인사만 반환합니다. 가장 단순한 샘플입니다.

### `get_current_time`

서버 현재 시각을 반환합니다.

### `who_am_i`

현재 access token에서 읽은 정보를 반환합니다.

초심자가 인증 성공 여부를 확인할 때 가장 먼저 써야 할 도구입니다.

### `admin_ping`

`admin` scope가 있는지 검사한 뒤 응답합니다.

이 도구가 중요한 이유는:

- 메타데이터에 scope 선언이 있고
- 서버 내부에서도 실제 scope를 확인한다

는 점을 한 번에 보여주기 때문입니다.

## 1-11. `if __name__ == "__main__":`

마지막 실행 블록입니다.

- `FASTMCP_HOST`
- `FASTMCP_PORT`

를 읽은 뒤 `mcp.run(...)`을 호출합니다.  
이때 `transport="http"`와 JSON 응답 모드를 사용합니다.

## 2. `oauth/chatgpt_oauth.py`

이 파일은 프로젝트의 인증 엔진입니다.

## 2-1. 상수들

맨 위 상수들은 기본 동작을 정의합니다.

- 허용 redirect URI 패턴
- 기본 scope 목록
- 기본 필수 scope
- access token 만료 시간
- refresh token 만료 시간
- authorization code 만료 시간
- pending transaction 만료 시간

즉, 인증 정책의 기본값들이 이곳에 모여 있습니다.

## 2-2. 데이터 모델 클래스들

### `DevUser`

개발용 사용자 모델입니다.

필드:

- `user_id`
- `name`
- `email`
- `scopes`

`claims` 프로퍼티는 JWT 등에 넣을 사용자 클레임을 만들어 줍니다.

### `PendingAuthorization`

아직 끝나지 않은 승인 요청을 저장하는 모델입니다.

들어 있는 정보:

- 어떤 클라이언트가 요청했는가
- 어디로 redirect할 것인가
- 어떤 scope를 요청했는가
- resource는 무엇인가
- 언제 만료되는가

즉, "브라우저 승인 페이지에 도달했지만 아직 승인 버튼을 누르기 전 상태"를 표현합니다.

### `AuthorizationCodeRecord`

authorization code에 사용자 정보를 덧붙인 모델입니다.

### `AccessTokenRecord`

발급된 access token의 서버 측 기록입니다.

토큰 문자열 자체보다 중요한 이유:

- 만료 체크
- client_id 연결
- refresh token과의 연결
- revoke 처리

### `RefreshTokenRecord`

refresh token의 서버 측 기록입니다.

## 2-3. `_hash_token`

토큰을 바로 파일명이나 키로 쓰지 않고 해시합니다.  
보안과 저장 편의성을 동시에 위한 선택입니다.

## 2-4. `_normalize_scopes`

scope 목록이 비어 있으면 fallback을 쓰고, 중복이 있으면 정리합니다.

## 2-5. `JsonCollection`

초심자가 꼭 이해해야 하는 클래스입니다.

역할:

- 하나의 디렉터리를 하나의 간단한 "컬렉션"처럼 사용
- 키를 해시해서 JSON 파일 경로로 변환
- `get`, `put`, `delete` 제공

쉽게 말하면:

> "아주 작은 파일 기반 데이터베이스 래퍼"

입니다.

이 클래스 덕분에 별도 DB 없이도 OAuth 상태를 저장할 수 있습니다.

## 2-6. `ChatGPTCustomOAuthProvider.__init__`

provider 초기화입니다.

이곳에서 하는 일:

1. 유효 scope, 기본 scope, 필수 scope 결정
2. 부모 `OAuthProvider` 초기화
3. 저장 디렉터리 준비
4. redirect URI 허용 패턴 설정
5. JWT 서명 키 결정
6. `clients`, `pending`, `codes`, `access`, `refresh` 저장소 준비
7. 개발용 사용자 파일 검증

특히 JWT 서명 키가 없을 때 base URL 기반 개발용 키를 유도하는 부분은, 학습용 프로젝트답게 편의성을 높인 설계입니다. 다만 운영 환경에서는 고정된 안전한 키를 써야 합니다.

`FASTMCP_JWT_SIGNING_KEY`를 초심자 눈높이로 다시 말하면 "이 서버가 만든 토큰임을 증명하는 도장 재료"에 가깝습니다.

이 값이 중요한 이유:

- `_issue_token_pair()`가 access token과 refresh token을 만들 때 이 기준으로 서명한다.
- `_verify_jwt_token()`이 나중에 들어온 토큰을 검사할 때 같은 기준으로 확인한다.
- 따라서 서버를 다시 띄웠을 때 이 값이 달라지면 예전에 발급한 토큰은 더 이상 신뢰되지 않을 수 있다.

## 2-7. `set_mcp_path`

MCP 경로가 정해지면 resource URL을 바탕으로 JWT issuer를 준비합니다.

이 단계가 필요한 이유는 access token의 audience/resource 같은 맥락을 서버가 알아야 하기 때문입니다.

## 2-8. `get_routes`

이 함수는 "인증 관련 HTTP 라우트들을 어떻게 노출할지"를 구성합니다.

여기서 추가되는 것들:

- OAuth authorization server metadata
- OIDC metadata 별칭 경로
- protected resource metadata 별칭 경로
- `/register`
- `/oauth/approve`

왜 별칭 경로가 많나?

여러 클라이언트가 기대하는 메타데이터 위치가 조금씩 다를 수 있기 때문입니다. 따라서 호환성을 위해 여러 well-known 경로를 잡아 둡니다.

## 2-9. `register_client`

이미 만들어진 클라이언트 정보를 저장하는 함수입니다.

중요 포인트:

- redirect URI가 허용 패턴과 맞는지 검사
- public client로 저장
- `client_secret`은 사용하지 않음

즉, 이 프로젝트는 공개 클라이언트 중심 설계입니다.

## 2-10. `authorize`

승인 시작 단계입니다.

하는 일:

1. client_id 존재 확인
2. resource 일치 여부 확인
3. redirect URI 검증
4. 요청 scope 검증 및 정규화
5. pending transaction 생성
6. 승인 페이지 URL 반환

핵심은 "아직 토큰을 주지 않는다"는 점입니다.  
이 단계는 단지 **사용자 승인 페이지로 보낼 준비**를 하는 단계입니다.

## 2-11. `load_authorization_code`

authorization code가 존재하는지, client가 맞는지, 만료되지 않았는지 확인합니다.

## 2-12. `exchange_authorization_code`

authorization code를 실제 토큰으로 바꾸는 단계입니다.

검사 항목:

- code가 실제 저장소에 있는가
- 이미 사용되지 않았는가
- client_id가 일치하는가
- resource가 일치하는가

통과하면 `_issue_token_pair()`로 넘어갑니다.

## 2-13. `load_refresh_token` / `exchange_refresh_token`

refresh token 갱신 흐름입니다.

특징:

- JWT 자체 검증
- 저장소 기록 확인
- client_id 확인
- 만료 확인
- 요청 scope 축소만 허용
- 기존 토큰 쌍 revoke 후 새 토큰 발급

## 2-14. `load_access_token`

실제 MCP 요청에 포함된 access token을 서버가 이해할 수 있는 `AccessToken` 객체로 바꾸는 단계입니다.

즉, 도구 호출 전에 "이 토큰이 유효한가"를 확인하는 관문입니다.

## 2-15. `revoke_token`

토큰 폐기 함수입니다. access인지 refresh인지 보고 연결된 쌍을 정리합니다.

## 2-16. `_handle_registration`

HTTP `/register` 엔드포인트의 실질 구현입니다.

검사 항목이 꽤 꼼꼼합니다.

- JSON 형식 검증
- grant type 검증
- response type 검증
- scope 유효성 검증
- redirect URI 허용 여부 검증

그리고 새 `client_id`를 발급해 저장합니다.

## 2-17. `_handle_approval`

초심자가 흐름을 이해할 때 가장 직관적인 함수입니다.

GET일 때:

- `txn` 확인
- pending transaction 찾기
- 승인 페이지 HTML 반환

POST일 때:

- 사용자가 선택한 `user_id` 확인
- 사용자 scope가 충분한지 확인
- authorization code 생성
- code 저장
- pending 삭제
- redirect

즉, 이 함수가 "사람이 승인 버튼을 눌렀다"는 사건을 OAuth 흐름으로 변환합니다.

## 2-18. `_get_pending_transaction`

pending transaction을 읽고 만료되었으면 삭제합니다.

## 2-19. `_build_metadata`

클라이언트가 읽는 OAuth 메타데이터를 구성합니다.

특히:

- `token_endpoint_auth_methods_supported = ["none"]`

설정은 공개 클라이언트 구조를 반영합니다.

## 2-20. `_load_dev_users` / `_default_users`

개발용 사용자 목록을 준비합니다.

동작 우선순위:

1. `FASTMCP_DEV_USERS_FILE`
2. 없거나 읽기 실패 시 기본 사용자

이 설계 덕분에 별도 사용자 DB 없이도 승인 흐름을 실험할 수 있습니다.

## 2-21. `_issue_token_pair`

실제 access token과 refresh token을 발급하고 저장소에 기록합니다.

여기서 중요한 점은:

- JWT 발급
- 해시 생성
- access/refresh 저장소 동시 기록
- 서로의 연결 관계 기록

즉, 이 함수가 인증 서버의 "토큰 발급 핵심"입니다.

## 2-22. `_revoke_pair`

access와 refresh를 함께 정리합니다.

## 2-23. `_verify_jwt_token`

JWT 검증을 수행하고, 기대한 토큰 종류(access 또는 refresh)와 맞는지도 확인합니다.

여기서 검증 기준이 되는 것이 앞에서 준비한 `JWTIssuer`, 즉 `FASTMCP_JWT_SIGNING_KEY`로부터 만들어진 서명 키입니다.

## 2-24. `_render_approval_form`

개발용 승인 HTML을 문자열로 직접 만듭니다.

실무에서는 보통 템플릿 엔진이나 프런트엔드 앱을 쓰겠지만, 여기서는 학습용으로 흐름이 눈에 보이도록 단순화했습니다.

## 2-25. `_html_error`

간단한 오류 페이지를 HTML로 렌더링합니다.

## 3. `oauth/fastmcp_oauth.py`

이 파일은 매우 짧지만 학습 가치가 큽니다.

## 3-1. `_parse_scopes`

서버 쪽과 비슷하게 scope 문자열을 리스트로 바꿉니다.

## 3-2. `main`

클라이언트 동작 전체가 이 함수에 들어 있습니다.

순서:

1. `FASTMCP_SERVER_URL` 읽기
2. `FASTMCP_CLIENT_SCOPES` 읽기
3. `OAuth()` 객체 생성
4. `Client(server_url, auth=oauth)` 연결
5. `ping`
6. `get_current_time`
7. `who_am_i`

이 파일의 의미는 "클라이언트는 이렇게 적은 코드로도 OAuth MCP 서버를 사용할 수 있다"를 보여주는 데 있습니다.

## 4. `oauth/dev_users.sample.json`

개발용 사용자 예제 두 명이 있습니다.

- `demo-user`: `mcp:use`
- `admin-user`: `mcp:use`, `admin`

따라서 승인 페이지에서 누구를 고르느냐에 따라 `admin_ping` 성공 여부가 달라집니다.

## 5. `oauth_setup.md`

이 문서는 환경 변수와 provider별 설정 예시를 짧게 정리한 문서입니다.  
이번 `README/` 문서들보다 압축된 요약본에 가깝습니다.

## 6. `RUN.md`

현재 개인 개발 환경에서 서버를 띄울 때 쓴 실행 메모입니다.

특징:

- ngrok 공개 URL 사용
- JWT signing key 지정
- `0.0.0.0:8000` 바인딩

Git에 올라가지 않도록 `.gitignore`에 들어 있습니다.

## 7. `uri.py`

`BASE_URI` 상수 하나만 있는 파일입니다.  
현재 코드 검색 기준으로는 다른 파일에서 import되지 않습니다.

즉, 지금 시점에서는 핵심 실행 경로에 들어가지 않는 파일입니다.

## 8. `requirements.txt`

현재 명시된 직접 의존성은 `fastmcp` 하나입니다.

이 뜻은:

- 프로젝트의 핵심 기능 대부분이 FastMCP 생태계 위에 올라가 있고
- 나머지 의존성은 FastMCP 설치 과정에서 함께 들어오거나 간접 의존성일 가능성이 크다

는 것입니다. 마지막 문장은 **의존성 파일 형태를 보고 내릴 수 있는 합리적 추론**입니다.

## 9. `.gitignore`

실행 중 생기는 파일이나 개인 개발 환경 파일을 Git에서 제외합니다.

대표 예:

- 키 파일
- `.venv`
- `.vscode`
- `__pycache__`
- `.fastmcp`
- `RUN.md`

즉, "코드"와 "로컬 상태"를 분리하려는 의도가 드러납니다.

## 10. 파일별 중요도 우선순위

초심자가 지금 꼭 읽어야 하는 순서로 다시 정리하면:

1. `fastmcp_client.py`
2. `oauth/chatgpt_oauth.py`
3. `oauth/fastmcp_oauth.py`
4. `oauth/dev_users.sample.json`
5. `oauth_setup.md`
6. `RUN.md`
7. `uri.py`

## 다음 문서

다음은 [실행 방법과 실험 가이드](06-run-guide.md)입니다. 여기서는 실제로 어떤 환경 변수로 어떻게 실행하고, 어떤 순서로 관찰하면 좋은지 정리합니다.
