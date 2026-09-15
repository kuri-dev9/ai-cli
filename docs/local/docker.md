# Docker 로 실행하기 — 검토 결과

2026-09-15 조사. 실제로 컨테이너를 띄워 검증했다.

> ## 결정: Docker 를 쓰지 않는다 (2026-09-15)
>
> 배포를 쉽게 하려고 Docker 를 검토했지만, **오히려 install.sh 로 배포하는 쪽이 낫다**는
> 결론으로 그만두었다. 받는 사람의 기존 `claude` 로그인·툴체인·셸을 그대로 쓸 수 있고,
> Dockerfile 을 새로 만들 필요도 없다.
>
> 아래는 그때 조사한 내용이다. 나중에 마음이 바뀌면 다시 조사하지 말고 여기서 출발할 것.

## 결론

| 시나리오 | 판정 | 이유 |
|---|---|---|
| **(A) 이 맥에서 Docker 로** | **된다. 하지만 권하지 않는다** | 장애물은 다 우회 가능하지만 얻는 게 없고 진짜 셸·호스트 툴체인을 잃는다 |
| **(B) 다른 서버/NAS** | **조건부로 된다** | 인증은 깔끔히 풀린다. 진짜 벽은 **"맥의 코드가 그 서버에 없다"** |
| **(C) 남에게 배포** | **지금 상태로는 사실상 안 된다** | Dockerfile 자체가 없고, 파일 경로·툴체인이 사람마다 다르다 |

---

## 저장소의 `docker/` 는 이 용도가 아니다

`docker/` 에 파일 5개가 있지만, Dockerfile 이 `FROM docker/sandbox-templates:claude-code`
로 시작한다. **Docker Sandboxes(`sbx` CLI, microVM) 용 이미지**이고, 그 안에 설치되는 건
`npm install -g @cloudcli-ai/cloudcli` — 즉 **npm 레지스트리의 upstream 원본**이다.

**이 저장소의 한국어 UI 를 포함한 로컬 수정이 전혀 반영되지 않는다.**

`.github/workflows/docker.yml` 도 `workflow_dispatch` 전용이고 Docker Hub 에 태그를
푸시하는 남의 배포 파이프라인이다. **compose 파일도, `.dockerignore` 도, 앱 자체
Dockerfile 도 없다.** 바닥부터 만들어야 한다.

다만 `docker/shared/install-cloudcli.sh` 의 apt 패키지 목록
(`build-essential python3 python3-setuptools jq ripgrep sqlite3 …`)은 참고할 가치가 있다.

---

## 인증 — 예상보다 쉽게 풀린다

### 검증된 사실

**호스트**: 키체인에 자격증명이 있고 `claude auth status` 가 `loggedIn: true`.

**컨테이너(자격증명 없음)**: `{"loggedIn": false, "authMethod": "none"}`, exit=1.
→ 앱이 "미인증" 으로 뜨고 채팅이 안 된다.

**호스트 `~/.claude` 마운트**: 여전히 `loggedIn: false`.
→ **볼륨 마운트로는 인증이 안 따라온다. 실증됨.** 키체인이기 때문이다.

**환경변수**: `CLAUDE_CODE_OAUTH_TOKEN` 과 `ANTHROPIC_API_KEY` 둘 다 먹는다.

**`claude setup-token`**: **1년짜리 토큰**을 발급한다. 브라우저 없는 환경에서도
URL 복붙으로 완주 가능하다. Claude 구독이 필요하다.

**`claude auth login` (컨테이너 안)** — 이게 핵심이다:

```
If the browser didn't open, visit:
https://claude.com/cai/oauth/authorize?...&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback
Paste code here if prompted >
```

**`redirect_uri` 가 `localhost` 가 아니라 `platform.claude.com` 이다.** 컨테이너가
콜백 서버를 띄울 필요가 없다. **컨테이너에 브라우저가 없는 게 문제가 안 된다.**

그리고 **이 앱은 이미 그 흐름을 지원한다**:
- `ProviderLoginModal.tsx:51` — 로그인 명령이 `claude auth login`
- `shell-websocket.service.ts:452-497` — pty 출력에서 URL 을 추출해 브라우저로 푸시
- `shell-websocket.service.ts:331` — `setup-token` / `auth login` 특수 처리

즉 **컨테이너 안에서 웹 UI 의 로그인 모달을 열면 그대로 로그인된다.**

### 함정

> **`claude auth status` 는 존재 검사이지 유효성 검사가 아니다.**
> **더미 토큰**을 넣어도 `loggedIn: true` 가 나온다. 설정 화면은 "연결됨" 인데 실제
> 대화에서 401 이 나는 상황이 가능하다.

### 정리

| 방법 | 난이도 | 비고 |
|---|---|---|
| 호스트에서 `claude setup-token` → `-e CLAUDE_CODE_OAUTH_TOKEN=…` | **쉬움** | 가장 깔끔. 1년에 한 번 갱신 |
| 컨테이너 안에서 웹 UI 로그인 (URL 복붙) | 쉬움 | 앱이 이미 지원. `~/.claude` 볼륨 영속화 필요 |
| `ANTHROPIC_API_KEY` | 쉬움 | **구독을 못 쓰고 API 과금.** 비추천 |
| 호스트 `~/.claude` 마운트 | **안 됨** | 검증 완료 |

---

## 진짜 문제는 셸이다

`shell-websocket.service.ts:402` 가 비 Windows 에서 **무조건 `bash`** 를 띄운다.

컨테이너 안에서는:
- zsh 도, dotfiles 도 없다
- **brew 로 깐 도구가 전부 없다** — `gh`, 언어 런타임, 빌드 도구, 회사 내부 CLI
- **Shell 탭만의 문제가 아니다.** Claude 가 Bash 툴로 실행하는 **모든** 명령이 컨테이너
  안에서 돈다. `npm test`, `cargo build`, `python` — 사용자가 맥에서 쓰던 환경과 다르다.
  툴체인을 전부 다시 깔지 않으면 Claude 가 *"테스트를 돌리려는데 명령이 없다"* 상태에 빠진다.

README 가 Shell 을 **"브라우저 안의 진짜 터미널"** 이라고 하는데, Docker 화하면 그
"진짜" 가 아니게 된다.

---

## 경로 문제 — 실재하지만 해결책이 있다

세션의 프로젝트 귀속은 **transcript JSONL 의 `cwd` 절대경로**로 결정된다
(`claude-session-synchronizer.provider.ts:122`). `~/.claude/projects/` 디렉터리명도
절대경로 슬러그다.

→ **`/workspace` 로 마운트하면 `-workspace` 슬러그가 새로 생기고 기존 세션이 전부 다른
프로젝트로 보인다.**

**해결: 경로를 똑같이 마운트한다.**

```bash
docker run --rm -it \
  -e HOME=/Users/kuri \
  -e CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.claude-oauth-token)" \
  -v /Users/kuri/proj:/Users/kuri/proj \
  -v /Users/kuri/.claude:/Users/kuri/.claude \
  -v /Users/kuri/.claude.json:/Users/kuri/.claude.json \
  -v /Users/kuri/.ssh:/Users/kuri/.ssh:ro \
  -p 3001:3001 \
  ai-cli
```

### 놓치기 쉬운 것들

- **`~/.claude.json` 은 `~/.claude/` 안이 아니라 홈 루트에 따로 있다** (50KB).
  앱이 MCP 설정 소스로 읽는다. 마운트 목록에서 빠뜨리기 딱 좋다.
- **파일 하나를 마운트하면** 호스트가 원자적 교체로 쓸 때 inode 가 끊긴다. 홈 전체를
  마운트하는 게 안전하지만 그러면 격리 의미가 거의 사라진다.
- **`WORKSPACES_ROOT`** (`server/shared/utils.ts:122`) 기본값이 `os.homedir()` 이고
  모든 프로젝트가 그 밑에 있어야 한다. `FORBIDDEN_WORKSPACE_PATHS` 에 `/opt`, `/root`,
  `/tmp`, `/usr`, `/var` 가 있다.
  → **컨테이너 HOME 을 기본값 `/root` 로 두면 프로젝트를 아예 등록할 수 없다.**

### 문제 아닌 것

- **네이티브 모듈**: linux/arm64 에서 `node-pty`, `better-sqlite3`, `bcrypt`, `sharp`
  **4개 전부 빌드·로드 성공**(실측).
- **uid/gid**: macOS 는 virtiofs 가 소유권을 호스트 사용자로 매핑한다. **신경 쓸 필요 없다.**
  **단 Linux 서버에서는 진짜 문제다** — `--user $(id -u):$(id -g)` 필요.

---

## git 자격증명 — 조치 필요

`git.routes.ts` 는 전부 맨 `git` 호출이고 **자격증명 처리 코드가 전혀 없다.**
`GIT_TERMINAL_PROMPT` 설정도 없다. 앰비언트 자격증명에 100% 의존한다.

컨테이너에서:
- macOS `osxkeychain` helper 를 못 쓴다. `~/.gitconfig` 을 그대로 마운트하면
  `credential.helper = osxkeychain` 줄이 Linux 에서 깨진다
- SSH 키 없으면 `git@github.com:` 원격 실패
- HTTPS 원격은 프롬프트 → TTY 없으니 실패하거나 **행(hang)**

**해결**: `.ssh` 마운트 + `GIT_SSH_COMMAND`, 또는 SSH agent 포워딩, 또는 PAT.
어느 쪽이든 **컨테이너용 `.gitconfig` 을 따로 만들어야** 한다.

---

## 그 밖에

- **TLS 없음.** `server/index.ts:85` 가 `http.createServer`. 외부 노출 시 리버스 프록시
  필수 — `docs/nginx-subpath-template.conf` 가 이미 있다.
- **`auth.db` 를 볼륨으로 안 빼면 계정이 날아간다.** 기본 `~/.cloudcli/auth.db`.
  `DATABASE_PATH` 로 named volume 지정할 것.
- **npm 11.19+ 의 install-script 차단**을 Dockerfile 에서도 처리해야 한다. 안 하면
  `node-pty` 바이너리가 안 생기고 `better-sqlite3` 가 빌드 안 돼 **서버가 아예 안 뜬다.**
  `install.sh:66-77` 참고.
- **`.nvmrc` 가 `v22`** 다. 컨테이너는 22 로 맞추는 게 안전하다.
- **`~/.claude` 동시 쓰기**: 컨테이너와 호스트가 같은 파일에 쓰면 경합 가능.
  JSONL append 는 대체로 무해하겠지만 `.claude.json` 같은 원자적 교체 파일은 위험하다. (추측)
- **AGPL**: 네트워크로 제공하면 소스 공개 의무. [`UPSTREAM.md`](./UPSTREAM.md) 참조.

---

## 시나리오별 판단

### (A) 이 맥에서 — 권하지 않는다

**얻는 것**: 격리 — 그런데 **프로젝트 디렉터리를 rw 로 마운트하는 순간 격리의 대부분이
사라진다.** Claude 가 망칠 수 있는 건 여전히 마운트된 전부다.

**잃는 것**: 진짜 셸, 호스트 툴체인, 파일 IO 성능(추측), 키체인 자동 인증,
그리고 이미 잘 돌아가는 `install.sh`.

격리가 목적이라면 직접 Docker 를 쓰기보다 이미 지원되는 `sbx` 쪽이 낫다. 다만 그건
upstream UI 다.

### (B) 다른 서버/NAS — 조건부

**인증은 풀린다**(`setup-token` 또는 웹 UI 로그인).

**파일이 진짜 벽이다.** 맥의 코드가 그 서버에 없고 마운트로 해결되지 않는다.
서버에 직접 clone 하면 **별도의 작업 환경**이 된다. 세션도 안 따라온다.

**판정: "맥의 작업을 어디서든 이어서" 가 아니라 "서버에 별도 작업공간을 만들고 거기
붙는다" 이다.** 이 차이를 받아들일 수 있는지가 결정 포인트다.

추가로 필요: Linux uid/gid 처리, 리버스 프록시 + TLS(필수), 1년 토큰이 서버에 평문
env 로 남는다는 점(서버 보안 = 계정 보안).

### (C) 남에게 배포 — 사실상 안 된다

인증은 의외로 괜찮다(`docker compose up` → 로그인 모달 → URL 복붙).

**진짜 걸림돌**: Dockerfile/compose 부재, 받는 사람마다 다른 파일 경로
(`WORKSPACES_ROOT` 포함), 프로젝트마다 다른 툴체인, git 자격증명, AGPL 의무.

**배포가 목적이라면 Docker 보다 [`install.sh`](../../install.sh) 를 다듬어 배포하는
쪽이 훨씬 현실적이다.** 이미 잘 돌아가고, 받는 사람의 기존 `claude` 로그인·툴체인·셸을
그대로 쓴다.

---

## 다른 기기에서 접속하고 싶은 것뿐이라면

Docker 가 필요 없다. `.env` 한 줄이면 된다.

```
HOST=0.0.0.0
```

그리고 `맥IP:3001` 로 접속한다. 단 **같은 네트워크의 누구나 이 맥에서 명령을 실행할 수
있게 된다.** 신뢰하는 네트워크에서만 할 것.
