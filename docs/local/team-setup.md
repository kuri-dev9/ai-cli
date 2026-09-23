# 팀원 설치 가이드

AI-CLI를 처음 설치하는 사람을 위한 문서입니다. 순서대로 따라가면 됩니다.

> **원격 맥(ssh로만 접근하는 서버)에 올리실 계획이라면
> [5. 원격 맥에 올리는 경우](#5-원격-맥에-올리는-경우)를 반드시 먼저 읽으세요.**
> 이 경우에만 필요한 설정이 있고, 모르면 원인을 찾기 매우 어렵습니다.

---

## 0. 사전 준비

`install.sh`가 **확인은 하지만 막아주지는 않는 것들**이 있습니다. 먼저 갖춰두세요.

| 항목 | 확인 | 없을 때 |
|---|---|---|
| Node.js v22 이상 | `node -v` | [nodejs.org](https://nodejs.org) / `brew install node` |
| Claude Code CLI | `claude --version` | `npm i -g @anthropic-ai/claude-code` |
| Claude 계정 | — | Pro 또는 Max 구독이 필요합니다 |
| 빌드 도구 | `cc --version` | macOS: `xcode-select --install`<br>Linux: `sudo apt install -y build-essential python3` |

Node는 버전이 낮으면 `install.sh`가 멈춥니다. 하지만 **Claude CLI와 빌드 도구는 없어도
경고만 찍고 설치가 계속 진행됩니다.** 설치가 성공한 것처럼 끝나고 나중에 엉뚱한 곳에서
터지므로, 위 네 가지는 미리 확인하세요.

네이티브 모듈(`better-sqlite3`, `node-pty`)을 소스에서 빌드하기 때문에 C 컴파일러가 필요합니다.

---

## 1. Claude Code 로그인

터미널에서 한 번 실행해 로그인합니다.

```bash
claude
```

이미 터미널에서 Claude Code를 쓰고 계시면 이 단계는 건너뛰어도 됩니다.

### 계정을 분리하고 싶다면 (선택)

개인 계정과 업무 계정을 나눠 쓰려면 설정 디렉터리를 분리합니다.

```bash
CLAUDE_CONFIG_DIR=$HOME/.claude-work claude
```

로그인 후 `.env`에도 **같은 값을 절대 경로로** 넣어야 합니다.

```bash
echo "CLAUDE_CONFIG_DIR=$HOME/.claude-work" >> .env
```

> **`~/.claude-work`처럼 틸드(`~`)로 쓰지 마세요.** 서버는 `~`를 풀어서 세션 목록을
> 읽지만, 이 값은 Claude CLI 자식 프로세스에 그대로 전달되어 엉뚱한 경로를 만들 수
> 있습니다. `$HOME`을 쓰거나 `/Users/이름/.claude-work`로 직접 적으세요.

한쪽만 설정하면 **세션 목록은 보이는데 대화만 안 되는** 상태가 됩니다.

---

## 2. 설치

```bash
git clone https://github.com/kuri-dev9/ai-cli.git ai-cli
cd ai-cli
./install.sh
```

Node 확인 → 의존성 설치 → 네이티브 모듈 빌드 승인 → 검증 → `.env` 생성 → 빌드까지
알아서 합니다. 몇 분 걸립니다.

`.env`는 `.env.example`을 복사해서 만들어지며, **`HOST=127.0.0.1`로 잠깁니다.**
이 컴퓨터에서만 접속된다는 뜻입니다.

> `install.sh`가 마지막에 `npm run server`로 실행하라고 안내하지만, **`./run.sh`를
> 쓰세요.** watchdog이 같이 떠서 서버가 죽으면 자동으로 되살려 줍니다.

---

## 3. 실행

```bash
./run.sh start
```

브라우저에서 **http://localhost:18200** 으로 접속합니다.

| 명령 | 하는 일 |
|---|---|
| `./run.sh start` | 켠다 (watchdog 포함, 터미널을 닫아도 계속 돈다) |
| `./run.sh stop` | 끈다 |
| `./run.sh restart` | 빌드하고 껐다 켠다 |
| `./run.sh status` | 서버·watchdog·응답 상태 |
| `./run.sh logs` | 로그를 따라 본다 (Ctrl+C로 빠져나옴) |

---

## 4. 첫 접속 후

여기서 막히는 분이 많습니다. 세 가지를 하셔야 합니다.

1. **로컬 계정을 하나 만듭니다.** 이 컴퓨터의 `~/.cloudcli/auth.db`에만 저장되고
   외부로 나가지 않습니다.
2. **설정(⚙) > 에이전트에서 도구를 켭니다.** 기본값이 **전부 꺼짐**이라, 켜지 않으면
   Claude가 파일을 읽지도 고치지도 못합니다. 고장이 아니라 의도된 안전장치입니다.
3. 텔레그램 연동을 쓰실 거면 **설정 > 텔레그램**에서 합니다. `.env`가 아닙니다.

### 다른 기기에서 접속하려면

`.env`의 `HOST`를 `0.0.0.0`으로 바꾸고 재시작하면 `맥IP:18200`으로 붙을 수 있습니다.

> **주의.** 접속할 수 있는 사람은 이 컴퓨터에서 파일을 읽고 고치고 셸 명령까지 실행할
> 수 있습니다. 신뢰하는 네트워크에서만 여세요. 폰에서 쓰실 거면 HTTPS도 같이
> 검토하세요 ([README의 HTTPS 항목](../../README.md#https-선택-사항)).

---

## 5. 원격 맥에 올리는 경우

**ssh로만 접근하는 맥에 설치한다면 이 섹션이 필수입니다.**

### 무엇이 문제인가

macOS의 Claude Code는 로그인 자격증명을 **키체인**에 저장합니다(`~/.claude/.credentials.json`
파일은 만들어지지 않습니다). 그런데 login 키체인은 **맥 화면에서 직접 로그인할 때만
열리고, ssh 세션은 그 잠금 해제를 물려받지 못합니다.**

그래서 ssh로 붙어 `./run.sh restart`를 하면, 그때부터 서버가 자격증명을 못 읽습니다.

```
Claude Code returned an error result: Not logged in · Please run /login
```

**로그인이 풀린 게 아닙니다.** 토큰은 키체인에 멀쩡히 있는데 꺼낼 수가 없는 것입니다.
그래서 재로그인을 해도 해결되지 않습니다.

한동안 멀쩡하다가 갑자기 터지는 것도 이 때문입니다. 맥 화면에서 한 번 띄워두면 이후
재시작을 해도 그 세션의 계보 안에 머물러 계속 동작하다가, **ssh에서 재시작하는 순간
계보를 벗어나면서 끊깁니다.**

### 해결 — 토큰을 발급해 `.env`에 둡니다

키체인을 아예 보지 않게 만들면 됩니다.

```bash
# 키체인이 잠겨 있으면 토큰 발급도 실패할 수 있으므로 먼저 풀어줍니다
security unlock-keychain ~/Library/Keychains/login.keychain-db

claude setup-token
# 계정을 분리했다면: CLAUDE_CONFIG_DIR=$HOME/.claude-work claude setup-token
```

브라우저에서 승인하고 코드를 붙여넣으면, **그 다음에 `sk-ant-oat01-`로 시작하는 토큰이
출력됩니다.** 이 값을 `.env`에 넣습니다.

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

```bash
chmod 600 .env          # 토큰이 평문으로 들어가므로 권한을 좁힙니다
./run.sh restart
```

설정(⚙) > 에이전트의 연결 상태가 **`OAuth Token (long-lived)(으)로 로그인됨`**으로
나오면 정상입니다. 이제 어느 세션에서 재시작하든, 맥을 재부팅하든 영향을 받지 않습니다.

### 이때 흔히 하는 실수 세 가지

**① 인증 코드를 토큰으로 착각하기**

| | 모양 | 정체 |
|---|---|---|
| 붙여**넣는** 값 | `xxxx#xxxx` (가운데 `#`) | 일회용 인증 코드 |
| 그 뒤에 **출력되는** 값 | `sk-ant-oat01-...` | `.env`에 넣을 토큰 |

코드를 넣고 엔터를 친 뒤 **한 줄 더 출력될 때까지 기다리세요.** 코드를 그대로 넣으면
`401 Invalid bearer token`이 납니다. 확인은 이렇게 합니다. `1`이 나와야 정상입니다.

```bash
grep -c '^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat' .env
```

**② 값 뒤에 주석 달기**

`.env`를 읽는 `server/load-env.ts`는 **인라인 주석을 걷어내지 않습니다.** 아래처럼 쓰면
`# 인증용` 까지 토큰 값에 포함됩니다.

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx   # 인증용   ← 이렇게 쓰지 마세요
```

설명은 윗줄에 따로 쓰세요.

**③ `.zshrc`에 넣기**

`.env`에 넣으세요. `.zshrc`는 두 가지 이유로 맞지 않습니다.

- **비대화형 셸에서는 로드되지 않습니다.** watchdog의 자동 재시작이나 재부팅 경로로
  서버가 뜰 때 값이 비어 있을 수 있습니다.
- **그 맥의 모든 `claude`가 그 토큰으로 돌아갑니다.** 터미널에서 개인 계정으로 쓰던
  것까지 전부 바뀌어, 계정을 분리한 의미가 없어집니다.

---

## 6. 업데이트

```bash
git pull
./install.sh        # .env 는 그대로 보존됩니다
```

의존성이 바뀌었을 수 있으므로 `install.sh`를 다시 돌리는 편이 안전합니다.
소스만 바뀐 게 확실하면 `./run.sh restart`로도 됩니다.

> `./run.sh restart -n`은 **빌드를 건너뜁니다.** 고친 내용이 반영되지 않은 채 예전
> 빌드가 뜨므로, 이유가 없으면 쓰지 마세요.

---

## 7. 문제가 생기면

### UI는 "연결됨"인데 대화만 안 될 때

연결 상태에 **이메일 대신 `macOS Keychain`이 떠 있다면 실제로는 인증에 실패한
상태입니다.** 이 표시는 "키체인에 항목이 있다"만 확인한 결과라, 값을 꺼낼 수 있는지는
검증하지 않습니다. [5번 섹션](#5-원격-맥에-올리는-경우)으로 가세요.

정상일 때는 이메일과 구독 종류가 뜨거나, 토큰 방식이면 `OAuth Token (long-lived)`으로
표시됩니다.

### `401 Invalid bearer token`

토큰 값이 잘못됐습니다. 위의 [실수 ①·②](#이때-흔히-하는-실수-세-가지)를 확인하세요.

### 세션 목록은 보이는데 대화만 안 될 때

`CLAUDE_CONFIG_DIR`이 로그인한 디렉터리와 다를 때 나타납니다. 로그인할 때 쓴 값과
`.env`의 값이 같은지, 틸드(`~`) 대신 절대 경로인지 확인하세요.

### 네이티브 모듈 오류 (`node-pty`, `better-sqlite3`)

npm 11.19 이상은 보안상 install script를 기본 차단합니다.

```bash
for p in @vscode/ripgrep bcrypt better-sqlite3 esbuild fsevents node-pty sharp unrs-resolver; do
  npm install-scripts approve "$p"
done
npm rebuild
```

### 그 밖에

```bash
./run.sh status       # 서버·watchdog·응답 상태
./run.sh logs server  # 서버 로그
```

로그는 `logs/`에 쌓이고 10MB를 넘으면 회전합니다.
