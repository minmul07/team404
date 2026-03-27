# FastMCP OAuth MCP Server 설명서

이 저장소는 **FastMCP로 만든 MCP 서버**에 **OAuth 인증**을 붙이고, 특히 **ChatGPT 커넥터가 이해할 수 있는 형태의 커스텀 OAuth 공급자**까지 직접 구현한 예제 프로젝트입니다.

중요한 점은 이 프로젝트가 단순히 "MCP 도구 몇 개를 제공하는 서버"가 아니라, 다음 두 문제를 함께 다룬다는 것입니다.

1. MCP 서버를 어떻게 띄우는가
2. 인증이 필요한 MCP 서버를 ChatGPT 같은 클라이언트와 어떻게 연결하는가

그래서 문서를 하나의 긴 README로 몰아넣기보다, 초심자가 순서대로 읽을 수 있게 `README/` 아래에 나누어 정리했습니다.

## 이 문서의 목표

- MCP가 낯선 학부생도 프로젝트의 큰 그림을 이해할 수 있게 한다.
- OAuth를 처음 보는 사람도 "왜 이런 파일과 엔드포인트가 필요한지"를 따라올 수 있게 한다.
- 실제 코드가 어느 순서로 실행되는지, 어떤 파일이 어떤 책임을 가지는지 연결해서 보여준다.

## 먼저 읽는 순서

1. [프로젝트 한눈에 보기](README/01-overview.md)
2. [MCP와 OAuth 기초](README/02-mcp-oauth-basics.md)
3. [프로젝트 구조](README/03-project-structure.md)
4. [인증과 요청 흐름 추적](README/04-auth-flow.md)
5. [파일별 상세 해설](README/05-file-walkthrough.md)
6. [실행 방법과 실험 가이드](README/06-run-guide.md)

## 아주 짧은 요약

- 서버 진입점은 `fastmcp_client.py`입니다.
- 기본 인증 모드는 `custom`이며, 이때 `oauth/chatgpt_oauth.py`가 사실상 작은 OAuth 서버 역할까지 같이 수행합니다.
- `oauth/fastmcp_oauth.py`는 브라우저 인증 흐름을 시험해보는 간단한 클라이언트입니다.
- `greet`, `get_current_time`, `who_am_i`, `admin_ping` 네 개의 MCP 도구가 제공됩니다.
- `admin_ping`는 `admin` scope가 있어야 통과합니다.
- 런타임 상태는 보통 `.fastmcp/` 아래에 저장됩니다.
- `FASTMCP_JWT_SIGNING_KEY`는 서버가 발급하는 JWT access/refresh token을 서명하고 나중에 검증할 때 쓰는 핵심 비밀 재료입니다.

## 이 저장소를 한 문장으로 말하면

> "FastMCP 서버에 OAuth를 붙이고, ChatGPT가 접속할 수 있도록 필요한 인증 메타데이터, 동적 클라이언트 등록, 승인 페이지, 토큰 발급 흐름까지 한 프로젝트 안에서 실험하는 저장소"

## 파일 빠른 지도

- [`fastmcp_client.py`](fastmcp_client.py): 서버 시작점, OAuth provider 선택, MCP 도구 등록
- [`oauth/chatgpt_oauth.py`](oauth/chatgpt_oauth.py): ChatGPT 호환 커스텀 OAuth provider 구현
- [`oauth/fastmcp_oauth.py`](oauth/fastmcp_oauth.py): OAuth 로그인 플로우 테스트용 클라이언트
- [`oauth/dev_users.sample.json`](oauth/dev_users.sample.json): 개발용 승인 사용자 예시
- [`oauth_setup.md`](oauth_setup.md): 환경 변수 중심의 짧은 설정 메모
- [`RUN.md`](RUN.md): 개인 로컬 실행 메모, `.gitignore`에 포함되어 Git 추적 제외
- [`uri.py`](uri.py): 현재 코드에서 사용되지 않는 공개 URL 상수

## 빠르게 실험하고 싶다면

가장 간단한 로컬 실행은 아래 두 단계입니다.

```bash
FASTMCP_BASE_URL=http://127.0.0.1:8000 \
FASTMCP_HOST=127.0.0.1 \
FASTMCP_PORT=8000 \
FASTMCP_DEV_USERS_FILE=oauth/dev_users.sample.json \
.venv/bin/python fastmcp_client.py
```

다른 터미널에서:

```bash
FASTMCP_SERVER_URL=http://127.0.0.1:8000/mcp \
FASTMCP_CLIENT_SCOPES="mcp:use" \
.venv/bin/python oauth/fastmcp_oauth.py
```

브라우저 승인 화면이 열리면 사용자를 하나 선택하고 승인하면 됩니다.

자세한 실행 배경과 공개 URL이 왜 필요한지는 [실행 방법과 실험 가이드](README/06-run-guide.md)를 보면 됩니다.

## 현재 개발 환경과 이후 배포 계획

현재는 **WSL2 환경에서 FastMCP 서버를 실행**하고, 그 서버의 포트를 **ngrok으로 외부에 공개**해서 ChatGPT 연동을 시험하고 있습니다.

즉, 현재 개발 흐름은 대략 아래와 같습니다.

```text
WSL2 안의 Python 서버
-> localhost/0.0.0.0:8000
-> ngrok 공개 URL
-> ChatGPT가 해당 공개 URL로 접속
```

이 방식은 개발 단계에서 빠르게 실험하기에 좋습니다. 다만 최종 형태는 아니고, 개발이 어느 정도 완료되면 **AWS EC2에 서버를 배포**해서 더 일반적인 상시 실행 환경으로 옮기는 것을 목표로 하고 있습니다.

그래서 문서를 읽을 때도 다음처럼 구분해서 보면 됩니다.

- 현재: WSL2 + ngrok 기반 개발/실험 환경
- 이후: AWS EC2 기반 실제 배포 환경

## 왜 `FASTMCP_JWT_SIGNING_KEY`가 중요한가

`FASTMCP_BASE_URL`이 "클라이언트가 어디로 접속해야 하는가"를 정하는 값이라면, `FASTMCP_JWT_SIGNING_KEY`는 "서버가 발급한 토큰을 무엇으로 믿을 것인가"를 정하는 값입니다.

이 프로젝트에서 이 값은 다음 역할을 합니다.

- access token 서명
- refresh token 서명
- 이후 들어온 token 검증

즉, 서버는 이 키를 바탕으로 "내가 발급한 토큰이 맞다"를 확인합니다.

초심자 기준으로는 아래처럼 이해하면 됩니다.

- `FASTMCP_BASE_URL`: 주소 문제
- `FASTMCP_JWT_SIGNING_KEY`: 신뢰 문제

왜 실전에서 중요하나:

- 이 값이 바뀌면 이전에 발급한 토큰은 검증에 실패할 수 있습니다.
- 서버를 여러 대 띄운다면 같은 토큰을 서로 검증할 수 있도록 같은 값을 공유해야 합니다.
- 값을 생략하면 이 프로젝트의 `custom` provider는 base URL 기반 개발용 키를 유도하지만, 공개 URL로 실제 연동할 때는 고정된 강한 값을 명시하는 편이 안전하고 예측 가능합니다.

관련 설명은 [실행 방법과 실험 가이드](README/06-run-guide.md)와 [파일별 상세 해설](README/05-file-walkthrough.md)에도 추가해 두었습니다.

## 문서를 읽으며 같이 보면 좋은 질문

- MCP 서버와 OAuth 서버가 이 프로젝트에서는 왜 한 프로세스 안에 같이 들어 있나?
- `custom`, `github`, `google`, `oidc`, `none` 중 무엇이 어떻게 다른가?
- ChatGPT가 접속하려면 왜 `/.well-known/...` 같은 메타데이터 URL이 필요한가?
- 왜 `admin_ping`는 메타데이터뿐 아니라 런타임에서도 scope를 다시 검사하나?
- `.fastmcp/custom-oauth/access`, `codes`, `pending` 폴더에는 무엇이 저장되나?

## 보조 문서

- 설정 요약만 빠르게 보고 싶다면 [oauth_setup.md](oauth_setup.md)
- 프로젝트를 처음부터 이해하려면 `README/` 아래 문서들이 더 적합합니다.
