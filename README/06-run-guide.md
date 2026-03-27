# 실행 방법과 실험 가이드

이 문서는 "이 프로젝트를 직접 띄워서 흐름을 확인하는 방법"을 설명합니다.

## 1. 기본 전제

현재 저장소는 Python 가상환경 `.venv`가 이미 있다고 가정하는 흔적이 있습니다.  
실행 예시도 `.venv/bin/python`을 사용합니다.

현재 확인된 개발 방식은 다음과 같습니다.

- WSL2 안에서 FastMCP 서버 실행
- `ngrok`로 포트 포워딩하여 공개 URL 생성
- ChatGPT는 그 공개 URL을 통해 MCP/OAuth 메타데이터와 서버에 접근

그리고 장기적으로는 개발이 어느 정도 완료되면 이 서버를 **AWS EC2에 배포**하는 흐름을 염두에 두고 있습니다.

필수 직접 의존성:

```bash
pip install -r requirements.txt
```

## 2. 가장 쉬운 실험 순서

처음에는 `custom` provider로 시작하는 것이 좋습니다. 이유는 이 모드가 가장 많은 내부 로직을 보여주기 때문입니다.

권장 실험 순서:

1. 서버 실행
2. 브라우저 기반 OAuth 클라이언트 실행
3. 승인 페이지에서 사용자 선택
4. `who_am_i` 결과 확인
5. 필요하면 `admin` scope 사용자로 다시 시도

## 3. 로컬에서 `custom` provider 실행

기본 실행은 이미 `custom`입니다. 따라서 `FASTMCP_OAUTH_PROVIDER`를 따로 주지 않아도 됩니다.

```bash
FASTMCP_BASE_URL=http://127.0.0.1:8000 \
FASTMCP_HOST=127.0.0.1 \
FASTMCP_PORT=8000 \
FASTMCP_DEV_USERS_FILE=oauth/dev_users.sample.json \
.venv/bin/python fastmcp_client.py
```

설명:

- `FASTMCP_BASE_URL`: OAuth 메타데이터가 참조할 서버 기준 주소
- `FASTMCP_HOST`: 실제 바인딩 주소
- `FASTMCP_PORT`: 실제 바인딩 포트
- `FASTMCP_DEV_USERS_FILE`: 승인 화면에 보여줄 개발용 사용자 목록

## 4. 테스트 클라이언트 실행

다른 터미널에서:

```bash
FASTMCP_SERVER_URL=http://127.0.0.1:8000/mcp \
FASTMCP_CLIENT_SCOPES="mcp:use" \
.venv/bin/python oauth/fastmcp_oauth.py
```

이 스크립트는 보통 브라우저 인증 과정을 유도합니다.

승인 후 기대 결과:

- `ping` 성공
- `get_current_time` 결과 출력
- `who_am_i`에 인증 정보 출력

## 5. `admin` scope 실험

`admin_ping`까지 시험해 보고 싶다면, 클라이언트 scope를 더 넓게 요청할 수 있습니다.

```bash
FASTMCP_SERVER_URL=http://127.0.0.1:8000/mcp \
FASTMCP_CLIENT_SCOPES="mcp:use admin" \
.venv/bin/python oauth/fastmcp_oauth.py
```

그리고 승인 페이지에서는 반드시 `admin-user`를 선택해야 합니다.  
`demo-user`는 `admin` scope가 없어서 승인 단계에서 막힙니다.

## 6. 인증 없이 서버만 보고 싶을 때

```bash
FASTMCP_OAUTH_PROVIDER=none \
FASTMCP_HOST=127.0.0.1 \
FASTMCP_PORT=8000 \
.venv/bin/python fastmcp_client.py
```

이 모드에서는:

- OAuth 메타데이터가 비활성화된다
- `who_am_i`는 인증되지 않았다고 나온다
- 전체적인 MCP 서버 구조만 보기 좋다

## 7. ChatGPT 연결용 공개 URL이 필요한 경우

ChatGPT는 여러분 로컬 주소를 직접 볼 수 없으므로 공개 URL이 필요합니다.  
예를 들어 ngrok 같은 터널을 쓰면 `https://...` 주소가 생깁니다.

현재 프로젝트는 바로 이 방식, 즉 **WSL2에서 서버를 띄우고 ngrok 공개 URL을 ChatGPT에 연결하는 방식**으로 테스트 중입니다.

이때 핵심은 `FASTMCP_BASE_URL`을 공개 주소로 맞추는 것입니다.

예:

```bash
FASTMCP_BASE_URL=https://YOUR_PUBLIC_URL \
FASTMCP_JWT_SIGNING_KEY=YOUR_FIXED_KEY \
FASTMCP_HOST=0.0.0.0 \
FASTMCP_PORT=8000 \
FASTMCP_DEV_USERS_FILE=oauth/dev_users.sample.json \
.venv/bin/python fastmcp_client.py
```

왜 `0.0.0.0`을 쓰나?

- 로컬 머신의 외부 인터페이스에서도 접속 가능해야 터널링 도구가 연결하기 쉽기 때문입니다.

왜 `https://`가 중요하나?

- 원격 클라이언트가 신뢰 가능한 공개 엔드포인트를 기대하기 때문입니다.

### 왜 `FASTMCP_JWT_SIGNING_KEY`도 거의 필수에 가까운가

이 값은 서버가 발급하는 JWT access token, refresh token에 서명하고, 나중에 그 토큰이 진짜 자신이 만든 것인지 검증할 때 쓰는 비밀 재료입니다.

쉽게 말하면:

- `FASTMCP_BASE_URL`은 "어디로 접속할지"
- `FASTMCP_JWT_SIGNING_KEY`는 "무엇을 믿을지"

를 정합니다.

특히 공개 URL로 ChatGPT와 연결할 때 이 값을 명시해 두는 편이 좋은 이유:

- 서버 재시작 후에도 토큰 검증 기준이 흔들리지 않습니다.
- access token과 refresh token의 서명 기준이 고정됩니다.
- 나중에 서버를 여러 인스턴스로 늘릴 경우에도 같은 값을 쓰면 동일한 토큰을 검증할 수 있습니다.

주의할 점:

- 이 값이 바뀌면 이전에 발급한 토큰은 무효가 될 수 있습니다.
- 너무 짧거나 예측 가능한 문자열은 좋지 않습니다.
- Git에 올리는 파일에 하드코딩하지 않는 편이 안전합니다.

이 프로젝트의 `custom` provider는 값을 생략하면 base URL 기반 개발용 키를 유도합니다. 다만 이것은 개발 편의를 위한 기본 동작이고, 지금처럼 ngrok 공개 주소로 실제 연결을 시험할 때는 명시적으로 넣는 편이 더 안전하고 동작도 예측하기 쉽습니다.

### 이후 AWS EC2로 옮길 때의 의미

현재의 ngrok 방식은 개발 속도가 빠르다는 장점이 있습니다. 반면 이후 AWS EC2에 올리면 다음이 더 자연스러워집니다.

- 고정된 실행 환경 유지
- 공개 주소를 매번 다시 바꾸지 않아도 됨
- 장기간 켜 둔 서버 운영이 쉬움
- ChatGPT나 다른 클라이언트가 접근할 안정적인 배포 환경 확보

즉, 지금 문서의 실행 예시는 "개발 및 실험 단계"에 맞춘 것이고, 나중에 EC2로 옮길 때도 핵심 개념은 같습니다.

- `FASTMCP_BASE_URL`은 실제 공개 주소로 바뀐다
- `FASTMCP_JWT_SIGNING_KEY`는 계속 안정적으로 유지되어야 한다
- OAuth 메타데이터와 redirect/resource 판단은 새 배포 주소 기준으로 다시 맞아야 한다

## 8. provider별 환경 변수 요약

### `custom`

자주 쓰는 변수:

- `FASTMCP_BASE_URL`
- `FASTMCP_AUTH_STORAGE_DIR`
- `FASTMCP_ALLOWED_CLIENT_REDIRECT_URIS`
- `FASTMCP_DEV_USERS_FILE`
- `FASTMCP_JWT_SIGNING_KEY`: access/refresh token 서명과 검증 기준이 되는 핵심 값

### `github`

추가로 필요:

- `FASTMCP_GITHUB_CLIENT_ID`
- `FASTMCP_GITHUB_CLIENT_SECRET`

### `google`

추가로 필요:

- `FASTMCP_GOOGLE_CLIENT_ID`
- `FASTMCP_GOOGLE_CLIENT_SECRET`
- `FASTMCP_GOOGLE_REQUIRED_SCOPES`

### `oidc`

추가로 필요:

- `FASTMCP_OIDC_CONFIG_URL`
- `FASTMCP_OIDC_CLIENT_ID`
- `FASTMCP_OIDC_CLIENT_SECRET`
- `FASTMCP_OIDC_AUDIENCE`
- `FASTMCP_OIDC_REQUIRED_SCOPES`

## 9. 실행 후 어디를 확인하면 좋나

### 루트 엔드포인트

브라우저나 `curl`로 `/`를 보면 서버 상태를 확인할 수 있습니다.

기대 확인 항목:

- `auth_enabled`
- `auth_provider`
- `mcp_path`

### 승인 페이지

인증 흐름 중 `/oauth/approve?txn=...`로 이동하면 개발용 승인 페이지가 보입니다.

### `who_am_i`

가장 중요한 관찰 지점입니다.

이 도구에서:

- `client_id`
- `scopes`
- `claims`
- `resource`

를 보면 인증이 제대로 되었는지 빠르게 알 수 있습니다.

## 10. 자주 막히는 지점

### 브라우저가 열렸는데 승인 후 진행이 안 된다

가능한 원인:

- redirect URI가 허용 목록에 없음
- `FASTMCP_BASE_URL`이 실제 접속 주소와 다름
- pending transaction이 만료됨

### `admin`을 요청했는데 승인에서 막힌다

가능한 원인:

- `demo-user`를 선택했음
- 개발용 사용자 JSON에 `admin` scope가 없음

### ChatGPT 연결이 안 된다

가능한 원인:

- 로컬 주소를 `FASTMCP_BASE_URL`로 넣음
- 공개 URL이 `https://`가 아님
- ChatGPT가 읽을 well-known 엔드포인트가 올바른 공개 주소를 기준으로 생성되지 않음

## 11. 관찰 실험 추천

초심자라면 아래 실험을 순서대로 해 보면 학습 효과가 큽니다.

### 실험 A. `mcp:use`만 요청

- `demo-user`로 승인
- `who_am_i` 확인

목표:

- 기본 인증 성공 구조 이해

### 실험 B. `admin`까지 요청

- `demo-user`로 시도해서 실패
- `admin-user`로 시도해서 성공

목표:

- scope가 왜 필요한지 체감

### 실험 C. `none` 모드

- 인증 없이 서버 실행
- `who_am_i` 결과 비교

목표:

- 인증이 붙은 상태와 없는 상태 차이 이해

## 12. 문서와 코드 함께 보는 팁

실행 중 아래를 같이 보면 좋습니다.

- [`fastmcp_client.py`](../fastmcp_client.py)
- [`oauth/chatgpt_oauth.py`](../oauth/chatgpt_oauth.py)
- [`oauth/dev_users.sample.json`](../oauth/dev_users.sample.json)

특히 승인 페이지에서 사용자를 고를 때 `dev_users.sample.json`과 `_handle_approval()`를 함께 보면 흐름이 바로 연결됩니다.
