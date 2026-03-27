# FastMCP OAuth 기본 구현

이 프로젝트는 FastMCP 공식 문서의 OAuth 클라이언트 / OAuth Proxy 패턴을 기준으로 구성했다.

관련 문서:

- https://gofastmcp.com/clients/auth/oauth
- https://gofastmcp.com/servers/auth/oauth-proxy
- https://gofastmcp.com/integrations/github
- https://gofastmcp.com/integrations/google
- https://gofastmcp.com/integrations/chatgpt

## 파일

- `fastmcp_client.py`
  서버. `github`, `google`, `oidc` 세 가지 OAuth 구성을 지원한다.
- `fastmcp_oauth.py`
  브라우저 기반 OAuth 로그인 플로우를 테스트하는 클라이언트 예제다.

## 왜 ChatGPT 같은 MCP 클라이언트에서 쓸 수 있나

FastMCP의 `OAuthProxy` 계열은 MCP 클라이언트가 기대하는 동적 등록 / 리디렉션 구조를 서버 쪽에서 제공한다. 그래서 GitHub, Google, 일반 OIDC 공급자처럼 원래는 고정 redirect URI와 사전 등록 앱을 요구하는 시스템도 MCP 클라이언트에서 사용할 수 있다.

중요한 전제는 서버가 외부에서 접근 가능한 HTTP URL에 배포되어 있어야 한다는 점이다. ChatGPT에 붙일 때는 `FASTMCP_BASE_URL`을 `https://...` 형태의 공개 주소로 설정해야 한다.

## 공통 환경 변수

```bash
export FASTMCP_BASE_URL=http://127.0.0.1:8000
export FASTMCP_HOST=127.0.0.1
export FASTMCP_PORT=8000
export FASTMCP_REDIRECT_PATH=/auth/callback
export FASTMCP_AUTH_STORAGE_DIR=.fastmcp/oauth-proxy
```

로컬 브라우저 테스트는 위 설정이면 충분하지만, ChatGPT 같은 원격 MCP 클라이언트에 연결할 때는 `FASTMCP_BASE_URL`을 인터넷에서 접근 가능한 공개 URL로 바꿔야 한다.

OAuth 공급자 콘솔의 redirect URI는 다음과 정확히 일치해야 한다.

```text
http://127.0.0.1:8000/auth/callback
```

## 1. GitHub Provider

```bash
export FASTMCP_OAUTH_PROVIDER=github
export FASTMCP_GITHUB_CLIENT_ID=YOUR_GITHUB_CLIENT_ID
export FASTMCP_GITHUB_CLIENT_SECRET=YOUR_GITHUB_CLIENT_SECRET
export FASTMCP_CLIENT_SCOPES="read:user user:email"
```

GitHub OAuth App 설정:

- Homepage URL: `http://127.0.0.1:8000`
- Authorization callback URL: `http://127.0.0.1:8000/auth/callback`

## 2. Google Provider

```bash
export FASTMCP_OAUTH_PROVIDER=google
export FASTMCP_GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
export FASTMCP_GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET
export FASTMCP_GOOGLE_REQUIRED_SCOPES="openid https://www.googleapis.com/auth/userinfo.email"
export FASTMCP_CLIENT_SCOPES="openid https://www.googleapis.com/auth/userinfo.email"
```

Google OAuth Client 설정:

- Authorized JavaScript origin: `http://127.0.0.1:8000`
- Authorized redirect URI: `http://127.0.0.1:8000/auth/callback`

## 3. Generic OIDC Provider

Auth0, Azure AD, Cognito, Keycloak 같은 OIDC 공급자는 이 구성이 기본 골격이다.

```bash
export FASTMCP_OAUTH_PROVIDER=oidc
export FASTMCP_OIDC_CONFIG_URL=https://YOUR_PROVIDER/.well-known/openid-configuration
export FASTMCP_OIDC_CLIENT_ID=YOUR_CLIENT_ID
export FASTMCP_OIDC_CLIENT_SECRET=YOUR_CLIENT_SECRET
export FASTMCP_OIDC_AUDIENCE=YOUR_API_AUDIENCE
export FASTMCP_OIDC_REQUIRED_SCOPES="openid profile email"
export FASTMCP_CLIENT_SCOPES="openid profile email"
```

## 실행

서버:

```bash
.venv/bin/python fastmcp_client.py
```

클라이언트:

```bash
.venv/bin/python fastmcp_oauth.py
```

첫 실행 시 브라우저가 열리고 로그인 / 동의가 끝나면 `who_am_i` 결과에서 토큰 claim을 확인할 수 있다.

## 제공 도구

- `greet`
- `get_current_time`
- `who_am_i`
- `admin_ping`

`admin_ping`는 `admin` scope가 있을 때만 호출 가능하다.

## 주의

- 이 저장소의 현재 가상환경에는 `fastmcp`가 설치되어 있지 않아 바로 실행 검증은 못 했다.
- FastMCP 3.1.1 기준으로 OAuth Proxy는 내부 상태 저장소가 필요하다. 이 구현은 기본값을 프로젝트 내부 `.fastmcp/oauth-proxy`로 잡아 샌드박스와 배포 환경 모두에서 예측 가능하게 동작하도록 했다.
- 운영 환경에서는 `FASTMCP_JWT_SIGNING_KEY`를 고정 값으로 지정하는 편이 안전하다.
