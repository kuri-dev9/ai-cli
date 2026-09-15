# AI-CLI

**Claude Code를 브라우저에서 쓰는 웹 UI.**

터미널 대신 브라우저에서 Claude Code로 작업합니다. 기존에 터미널에서 쓰던 세션이
그대로 보이고, 이어서 대화할 수 있습니다. 같은 네트워크라면 폰이나 태블릿에서도 접속됩니다.

> 이 소프트웨어는 **CloudCLI UI (https://github.com/siteboon/claudecodeui)** 를 기반으로
> 수정한 버전입니다. 원본이 아닙니다. 자세한 내용은 [출처 및 라이선스](#출처-및-라이선스)를 보세요.

---

## 무엇을 할 수 있나

- **채팅** — Claude Code와 대화. 도구 호출이 카드로 보이고, 응답이 실시간으로 흐릅니다
- **세션 관리** — `~/.claude` 의 기존 세션을 자동으로 찾아 목록으로 보여줍니다. 클릭하면 이어서 대화
- **파일 탐색기** — 문법 강조가 되는 파일 트리. 바로 편집 가능
- **소스 관리** — 변경사항 확인, 스테이지, 커밋, 브랜치 전환
- **Shell** — 브라우저 안의 진짜 터미널
- **설정** — 모델, 권한, MCP 서버를 UI에서 관리. `~/.claude` 에 직접 반영됩니다
- **한국어** — 인터페이스 전체가 한국어입니다 (설정에서 다른 언어로 바꿀 수 있습니다)

터미널 Claude Code와 **같은 설정을 공유합니다.** 별도 저장소가 아니라, UI에서 바꾸면
`~/.claude` 에 그대로 써지고 터미널 쪽에도 즉시 반영됩니다.

---

## 필요한 것

| | |
|---|---|
| **Node.js** | v22 이상 |
| **Claude Code CLI** | 설치 후 로그인된 상태 ([설치 안내](https://code.claude.com/docs)) |
| **OS** | macOS, Linux |
| 빌드 도구 | macOS: `xcode-select --install` / Linux: `build-essential`, `python3` |

네이티브 모듈(`better-sqlite3`, `node-pty`)을 빌드해야 해서 C 컴파일러가 필요합니다.

---

## 설치

```bash
git clone <이 저장소 주소> ai-cli
cd ai-cli
./install.sh
```

스크립트가 Node 버전 확인 → 의존성 설치 → 네이티브 모듈 빌드 승인 → 검증 → `.env` 생성
→ 빌드까지 알아서 합니다.

## 실행

```bash
npm run server
```

브라우저에서 **http://localhost:3001**

### 처음 실행하면

1. **로컬 계정을 하나 만듭니다.** 이 컴퓨터의 `auth.db` 에만 저장되고 외부로 나가지 않습니다.
2. **설정(⚙) 에서 사용할 도구를 켜세요.** 기본값은 **전부 꺼짐**입니다. 안 켜면 Claude가
   파일을 읽거나 고치지 못합니다. 의도된 안전장치입니다.
3. `claude` 로그인이 안 돼 있으면 터미널에서 `claude` 를 한 번 실행해 로그인하세요.

---

## 설정

`.env` 파일에서 바꿉니다.

### 접속 범위

```
HOST=127.0.0.1     # 이 컴퓨터에서만 (기본값)
HOST=0.0.0.0       # 같은 네트워크의 다른 기기에서도
```

> **`0.0.0.0` 으로 열 때 주의.** 접속할 수 있는 사람은 이 컴퓨터에서 파일을 읽고 고치고
> 셸 명령까지 실행할 수 있게 됩니다. 신뢰하는 네트워크에서만 여세요.

폰에서 쓰려면 `0.0.0.0` 으로 바꾸고 `맥IP:3001` 로 접속합니다.

### 표시할 CLI

이 앱은 Claude Code 외에 Cursor CLI, Codex, OpenCode 도 지원합니다. 기본값은 네 개
전부 켜짐이고, **설정 > 에이전트 > (CLI 선택) > 계정** 의 "이 CLI 사용" 토글로
개별로 끄고 켤 수 있습니다.

끈 CLI 는 채팅의 CLI 선택 목록과 온보딩 화면에서 사라집니다. 설정의 에이전트 탭에는
흐리게 계속 남아 있어서 언제든 다시 켤 수 있고, 마지막으로 남은 하나는 끌 수 없습니다.

> 이 설정은 다른 사용자 설정과 함께 `auth.db` 에 저장됩니다. **재빌드가 필요 없고**
> 바로 반영됩니다.

### 포트

```
SERVER_PORT=3001
```

### HTTPS (선택 사항)

기본값은 HTTP 입니다. **이 컴퓨터에서만 쓴다면 켤 필요가 없습니다** — 브라우저는
`http://localhost` 를 이미 안전한 출처(secure context)로 취급합니다.

폰/태블릿에서 `http://192.168.x.x` 로 붙는 경우에만 의미가 있습니다. 평문이라
같은 네트워크에서 트래픽을 보면 **로그인 토큰이 그대로 노출**됩니다.

```bash
./scripts/generate-cert.sh     # certs/server.key, certs/server.crt 생성
```

그리고 `.env` 에:

```
HTTPS_ENABLED=true
```

서버를 다시 시작하면 `https://` 로 뜹니다. WebSocket 은 페이지 프로토콜을 따라가므로
자동으로 `wss://` 가 됩니다 — 따로 설정할 것이 없습니다.

인증서 경로를 옮기려면 `HTTPS_KEY_PATH`, `HTTPS_CERT_PATH` 를 설정하세요. 켜 놓고
인증서를 읽지 못하면 서버는 **HTTP 로 폴백하지 않고 에러를 내며 멈춥니다.**
암호화됐다고 착각한 채 평문으로 도는 쪽이 더 위험하기 때문입니다.

#### 어느 방법으로 인증서를 만들지

`generate-cert.sh` 는 `mkcert` 가 깔려 있으면 그걸 쓰고, 없으면 `openssl` 로
자체 서명 인증서를 만듭니다. 둘은 대가가 꽤 다릅니다.

| | openssl (자체 서명) | mkcert (로컬 CA) |
|---|---|---|
| 준비 | 없음 | `brew install mkcert` + 폰에 CA 설치 |
| 브라우저 경고 | 접속할 때마다 통과 | 없음 |
| service worker | **등록 안 됨** | 정상 |
| 웹 푸시 알림 | **안 됨** | 정상 |
| 홈 화면 PWA 설치 | **막힘** | 정상 |

브라우저는 인증서 오류가 난 페이지에서 service worker 등록을 거부합니다
(`An SSL certificate error occurred when fetching the script`). 경고를 클릭해서
통과해도 마찬가지입니다. 그래서 **자체 서명으로는 PWA 기능이 죽습니다.**

> 다만 지금 `http://192.168.x.x` 로 쓰고 있다면 service worker 는 **이미**
> 동작하지 않습니다(평문은 secure context 가 아님). 즉 자체 서명으로 바꿔도
> 잃는 것은 없고, TLS 만 얻습니다.

폰에서 PWA 로 쓰고 싶다면 mkcert 쪽을 고르세요. CA 를 한 번 설치하면 경고도 없고
지금보다 **오히려 기능이 늘어납니다**:

```bash
brew install mkcert
./scripts/generate-cert.sh --force
mkcert -CAROOT          # 이 폴더의 rootCA.pem 을 폰으로 보내 설치
```

- iOS: 프로파일 설치 후 **설정 > 일반 > 정보 > 인증서 신뢰 설정** 에서 켜야 합니다
- Android: **설정 > 보안 > 인증서 설치 > CA 인증서**

인증서 파일(`certs/`)은 `.gitignore` 에 있어 커밋되지 않습니다.

---

## 개발

```bash
npm run dev            # 핫 리로드 (프런트 5173 + API 3001)
npm run build          # 전체 빌드
npm run build:client   # 프런트만 (.env 의 VITE_* 를 바꿨을 때)
npm run build:server   # 백엔드만
npx tsc --noEmit -p tsconfig.json          # 프런트 타입체크
npx tsc --noEmit -p server/tsconfig.json   # 백엔드 타입체크
```

원본에서 무엇을 어떻게 고쳤는지는 [`docs/local/local-changes.md`](docs/local/local-changes.md)
에 전부 적혀 있습니다.

---

## 문제가 생기면

**네이티브 모듈 오류 (`node-pty`, `better-sqlite3` 관련)**

npm 11.19 이상은 보안상 install script 를 기본 차단합니다. 그래서 네이티브 모듈이
빌드되지 않을 수 있습니다.

```bash
for p in @vscode/ripgrep bcrypt better-sqlite3 esbuild fsevents node-pty sharp unrs-resolver; do
  npm install-scripts approve "$p"
done
npm rebuild
```

**Claude가 "인증되지 않음" 으로 나올 때**

터미널에서 `claude -p "hi"` 가 되는지 먼저 확인하세요. 되는데도 UI에서 안 되면
[`docs/local/local-changes.md`](docs/local/local-changes.md) 의 키체인 관련 항목을 보세요.

**세션이 안 보일 때**

`~/.claude/projects/` 에 세션 파일이 있는지 확인하세요. 이 앱은 그 디렉터리를 읽습니다.

---

## 출처 및 라이선스

이 소프트웨어는 아래 프로젝트를 **수정한 버전**입니다. 원본이 아닙니다.

> **CloudCLI UI (https://github.com/siteboon/claudecodeui)**
> Copyright 2025-2026 Siteboon AI B.V. and contributors

**라이선스: GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**,
Section 7 추가 조항 포함. 전문은 [`LICENSE`](LICENSE) 와 [`NOTICE`](NOTICE) 에 있습니다.

재배포하거나 네트워크 서비스로 제공한다면 **수정된 소스를 이용자에게 제공할 의무**가
있습니다. 자세한 조건과 기준 커밋은 [`docs/local/UPSTREAM.md`](docs/local/UPSTREAM.md) 를 보세요.

"CloudCLI", "Siteboon" 은 원저작자의 이름이며, 이 프로젝트는 해당 상표를 사용하지 않습니다.
출처를 밝히는 용도로만 언급합니다.
