# 같은 AI 의 계정 여러 개 — 설계

2026-10-30 작성. **설계 단계다. 아직 구현하지 않았다.**

UI 에서 로그인해 Claude·Codex 계정을 여러 개 등록하고, 대화(와 룸 참가자)마다 어느
계정으로 돌릴지 고르게 한다.

---

## 1. 지금 상태

| | Claude | Codex |
|---|---|---|
| UI 로그인 | 있음. 내장 셸에서 `claude auth login` (`ProviderLoginModal.tsx`) | 있음. `codex login` |
| 로그인 저장 위치 | 서버 전체에 하나 — 키체인 또는 `$CLAUDE_CONFIG_DIR` | 서버 전체에 하나 — `~/.codex/auth.json` |
| 계정 분리 | `.env` 의 `CLAUDE_CONFIG_DIR` 또는 `CLAUDE_CODE_OAUTH_TOKEN` 으로 **서버당 하나** | 없음. `~/.codex` 하드코딩 (10곳) |
| 바꾸는 법 | `.env` 수정 후 재시작 | 다시 로그인 (덮어씀) |

즉 "로그인" 은 계정을 **교체**할 뿐 **추가**하지 못한다.

---

## 2. 목표 / 비목표

**목표 (1단계)**

1. 설정 화면에서 Claude·Codex 계정을 이름을 붙여 여러 개 등록·삭제한다. 로그인은 UI 에서 끝난다.
2. 새 대화를 열 때, 그리고 대화 도중에 계정을 고를 수 있다.
3. 룸 참가자를 초대할 때 계정을 고른다 (같은 Claude 셋을 서로 다른 계정에).
4. 사용량·한도 화면이 계정별로 나온다.
5. 계정을 하나도 등록하지 않으면 **지금과 똑같이** 동작한다 (기본 계정 = 현재 로그인).

**비목표**

- 계정 간 자동 전환(한도에 걸리면 다음 계정으로). **하지 않기로 했다** — §8-3.
- Cursor·OpenCode·Gemini. 구조는 열어 두되 1단계는 Claude·Codex 만.
- 앱 로그인 사용자(`auth.db`)와 AI 계정의 연결. 계정은 서버 전역 자원으로 둔다.

---

## 3. 핵심 결정 — "인증만 바꾸고, 세션 저장소는 하나로"

계정을 나누는 방법은 두 가지다.

### 안 A. 계정마다 설정 폴더를 통째로 나눈다

`CLAUDE_CONFIG_DIR=~/.ai-cli/accounts/<id>/claude`, `CODEX_HOME=.../codex` 로 돌린다.

- 장점: CLI 가 공식 지원하는 방식. 계정끼리 완전히 격리된다.
- **단점: 대화 기록(transcript)이 계정 폴더 안에 생긴다.** 세션이 계정에 묶여 버려,
  - 대화 도중 계정을 바꾸면 새 계정 쪽에는 그 대화가 없다 → 이어 갈 수 없다.
  - 세션 동기화·감시·토큰 사용량·검색이 모든 계정 폴더를 돌아야 한다. 코어 diff 가 커진다.
  - 스킬·MCP·settings.json 도 계정마다 따로 생겨 "계정을 바꿨더니 MCP 가 없다" 가 된다.

### 안 B. 세션 저장소는 하나, 인증 정보만 계정별로 (채택)

**Claude**: `claude setup-token` 으로 발급한 장기 토큰을 계정마다 저장하고, 실행할 때
`CLAUDE_CODE_OAUTH_TOKEN` 환경변수로만 넘긴다. `~/.claude`(transcript, 스킬, MCP)는 그대로 공유한다.

- 이미 검증된 경로다. 지금도 `.env` 의 `CLAUDE_CODE_OAUTH_TOKEN` 으로 돌리는 팀원이 있고
  (`team-setup.md` §5), `claude-auth.provider.ts` 도 이 값을 인식한다.
- 대화 도중 계정을 바꿔도 transcript 는 같은 자리에 있으니 그대로 이어진다.

**Codex**: Codex 에는 ChatGPT 로그인을 환경변수로 넘기는 길이 없다 (`CODEX_API_KEY` 는 API 키
과금용). 그래서 계정마다 `CODEX_HOME` 을 두되, **`auth.json` 만 그 계정 것이고 나머지는
`~/.codex` 를 가리키는 심볼릭 링크**로 채운다.

```
~/.ai-cli/accounts/<id>/codex/
  auth.json        ← 이 계정의 로그인 (실파일)
  sessions   → ~/.codex/sessions     (링크)
  config.toml→ ~/.codex/config.toml
  skills     → ~/.codex/skills
  ...              (그 밖의 항목도 링크)
```

- **검증이 필요하다 (PoC-1).** Codex 가 `CODEX_HOME` 안의 상태 DB(`state_*.sqlite` 등)로 스레드를
  찾는다면, 링크로 공유했을 때 다른 계정이 만든 스레드를 resume 하지 못하거나 DB 잠금이 충돌할
  수 있다. PoC 에서 "계정 A 로 만든 스레드를 계정 B 로 resume" 과 "두 계정 동시 실행" 을 확인한다.
- **`auth.json` 을 다른 계정 폴더로 복사하지 않는다.** ChatGPT 로그인의 refresh token 은 쓰면
  바뀌는(rotating) 방식이라, 복사본 쪽이 먼저 갱신하면 원본 로그인이 끊길 수 있다. 계정 폴더마다
  반드시 `codex login` 을 따로 한다. 같은 계정을 두 번 등록하는 것도 이렇게 하면 안전하다.
- PoC 가 실패하면 Codex 만 안 A 로 간다 — 세션이 계정에 묶이고, 대화 도중 계정 변경은 Codex
  에서만 막는다.

> 결론: 계정 = "인증 정보 한 벌". 세션은 계정과 느슨하게 연결되고(마지막에 쓴 계정을 기억할
> 뿐), 저장소는 하나다.

---

## 4. 데이터

### 4.1 계정 저장소 — 앱 DB 가 아니라 파일

`~/.ai-cli/accounts/` (권한 700)

```
accounts.json          # [{ id, provider, label, createdAt, kind }]
preferences.json       # { lastUsed: { claude: <id>, codex: <id> },
                       #   projectDefaults: { "<project_path>": { claude: <id>, codex: <id> } } }
<id>/claude.token      # Claude: sk-ant-oat01-... (권한 600)
<id>/codex/auth.json   # Codex: codex login 결과 (권한 600)
```

- 토큰을 SQLite 에 넣지 않는다. 백업·로그·DB 덤프로 새어 나갈 길을 줄이고, 업스트림 스키마도 건드리지 않는다.
- `id` 는 `default` 를 예약한다 — "지금 서버에 로그인된 그대로" 를 뜻하며 파일이 없다.
  설정 화면에서는 "기본 계정(현재 로그인)" 처럼 다른 계정과 나란히 보이고 이름도 붙일 수 있다.
- `preferences.json` 의 두 값은 §5.3 의 계정 결정에 쓴다. 프로젝트별 기본값도 `projects`
  테이블이 아니라 여기 둔다 — 업스트림 스키마를 건드리지 않는다.

### 4.2 세션·참가자가 계정을 가리키는 법

- `sessions.account_id TEXT NULL` — 이 대화가 마지막으로 쓴 계정. **NULL 이면 `default`** —
  계정 기능 이전의 대화는 모두 지금 로그인된 계정에 귀속된다 (§8-1 결정). 마이그레이션은 하지 않는다.
- `room_participants.account_id TEXT NULL` — 이 참가자가 쓸 계정.

코어 스키마에 컬럼 두 개가 는다. 대안은 별도 테이블(`session_accounts(session_id, account_id)`)로
빼는 것이다. **별도 테이블을 권장한다** — 업스트림이 `sessions` 를 바꿀 때 충돌이 나지 않는다.
룸은 이미 우리 쪽 기능이라 `room_participants` 에 바로 둔다.

---

## 5. 흐름

### 5.1 계정 추가 (UI 로그인)

설정 > 에이전트 > (Claude) > **계정 추가**

1. 이름을 입력한다 ("업무", "개인 2" …).
2. **Claude**: 내장 셸이 `claude setup-token` 을 임시 `CLAUDE_CONFIG_DIR` 로 실행한다
   (기존 로그인에 손대지 않으려고). 브라우저 승인 → 코드 붙여넣기 → 출력된 `sk-ant-oat01-…`
   을 **서버가 PTY 출력에서 잡아** `<id>/claude.token` 에 저장한다. 못 잡으면 붙여넣기 칸을 연다.
   임시 폴더는 지운다.
3. **Codex**: 내장 셸이 `CODEX_HOME=<id>/codex codex login` 을 실행한다 (원격이면
   `--device-auth`). 끝나면 §3 의 링크를 채운다.
4. 저장 직후 인증 확인(아래 5.4)을 한 번 돌려 "○○ 로 로그인됨" 을 보여 준다.

### 5.2 실행할 때

provider runtime 이 SDK 를 띄우기 직전에 **계정 → 환경변수**를 덧붙인다.

| provider | 덧붙이는 env | 넣는 자리 |
|---|---|---|
| Claude | `CLAUDE_CODE_OAUTH_TOKEN=<token>` | `claude-runtime.provider.js` 의 `sdkOptions.env` |
| Codex | `CODEX_HOME=<id>/codex` | `codex-runtime.provider.ts` 의 `new Codex({ env })` (SDK 가 `env` 옵션을 받는다), app-server 클라이언트의 `spawn` env |

코어에 넣는 것은 **"run 옵션의 `accountId` 를 env 로 바꿔 주는 함수 하나를 호출"** 하는
한 줄씩이다. 계정 해석은 별도 모듈(`server/modules/accounts/`)이 맡는다.

### 5.3 어느 계정으로 돌릴지 정하기

**이어 가는 대화**는 그 대화의 계정을 그대로 쓴다.

요청에 실린 `accountId` → 룸 참가자의 `account_id` → 세션의 `account_id` → (없으면 `default`)

**새 대화**는 늘 사용자가 고를 수 있고, 미리 골라져 있는 값은 이렇게 정한다 (§8-2 결정).

1. 이 프로젝트에 기본 계정이 지정돼 있으면 그것
2. 없으면 이 provider 로 **마지막에 쓴 계정** (`preferences.lastUsed`)
3. 그것도 없으면 `default`

- "마지막에 쓴 계정" 은 사용자가 계정을 골라 **실제로 보냈을 때** 갱신한다. 메뉴를 열었다 닫는 것만으로는 바뀌지 않는다.
  룸 참가자의 실행은 갱신하지 않는다 — 참가자 셋을 다른 계정에 나눴다고 다음 새 대화의 기본값이 흔들리면 안 된다.
- 프로젝트 기본 계정은 프로젝트 설정(또는 계정 칩 메뉴의 "이 프로젝트의 기본으로")에서 고른다. 비워 두면 2번으로 내려간다.
- 채팅 입력창의 모델 메뉴 옆에 계정 칩을 둔다 (그 provider 의 계정이 2개 이상일 때만 보인다).
- 대화 도중 바꾸면 다음 차례부터 새 계정으로 돈다. 맥락은 그대로다 (§3 안 B 덕분).
- 룸 초대 모달의 계정 선택도 같은 규칙으로 미리 골라 둔다.

### 5.4 인증 상태·사용량

- `provider-auth.service` 의 상태 확인을 계정 단위로 돌릴 수 있게 한다 (계정의 env 로 확인).
- 사용량: Claude 는 `claude-usage.service` 가 키체인 대신 계정 토큰으로 usage API 를 부른다.
  Codex 는 `codex-rate-limit.service` 가 `~/.codex/auth.json` 대신 계정의 `auth.json` 을 읽는다.
- 사용량 화면은 provider 아래에 계정별 행을 둔다.

---

## 6. 코어 diff 예상 (업스트림 머지 부담)

| 파일 | 변경 | 크기 |
|---|---|---|
| `claude-runtime.provider.js` | env 에 계정 env 병합 | 1~3줄 |
| `codex-runtime.provider.ts` | `new Codex({ env })` | 1~3줄 |
| `codex-app-server.client.ts` | spawn env | 1줄 |
| `provider-runtime.service.ts` | 옵션의 `accountId` 를 그대로 전달 | 없음일 수도 |
| `claude-usage` · `codex-rate-limit` · `*-auth.provider` | "자격 증명 읽는 곳" 을 주입 가능하게 | 각 5~15줄 |
| `ProviderLoginModal.tsx` · 셸 서비스 | 로그인 명령에 env 를 실을 수 있게 | 10줄 안팎 |
| 채팅 입력창 | 계정 칩 자리 하나 | 10줄 안팎 |

나머지 — 계정 저장소, 로그인 오케스트레이션, 설정 화면, 계정 칩 컴포넌트 — 는 전부 새 모듈
(`server/modules/accounts/`, `src/modules/accounts/`)에 둔다.

**`~/.codex` 하드코딩 10곳은 고치지 않는다.** 안 B 에서는 세션·스킬·MCP 가 계속 `~/.codex`
에 있으므로 그대로 맞다. 바꿔야 하는 것은 `auth.json` 을 읽는 두 곳(`codex-auth`, `codex-rate-limit`)뿐이다.

---

## 7. 단계

| 단계 | 내용 | 끝났다고 볼 기준 |
|---|---|---|
| PoC-1 | Codex `CODEX_HOME` + 링크 공유: 교차 resume, 동시 실행 | 계정 A 스레드를 B 로 이어 쓰고, 두 계정이 동시에 돌아도 깨지지 않음 |
| PoC-2 | Claude `setup-token` PTY 출력에서 토큰 잡기 | UI 에서 토큰 발급까지 끝남 |
| 1 | 계정 저장소 + 실행 env 주입 + 설정 화면 + 새 대화 계정 선택 (Claude) | 두 Claude 계정으로 각각 대화, 도중 전환, 새 대화가 프로젝트 기본/마지막 계정으로 미리 골라짐 |
| 2 | Codex 계정 | 같은 기준 (PoC-1 결과에 따라 전환 제약 포함) |
| 3 | 룸 참가자 계정 지정 | 초대 모달·참가자 설정에서 계정 선택 |
| 4 | 계정별 사용량·인증 상태 | 사용량 화면에 계정별 행 |

---

## 8. 결정한 것 / 열어 둔 질문

**결정 (2026-10-30)**

1. **기존 대화의 계정** — 계정 기능 이전의 대화는 모두 지금 로그인된 계정(`default`)에 귀속한다.
2. **새 대화의 기본 계정** — 늘 사용자가 고를 수 있다. 미리 골라 두는 값은 프로젝트 기본 계정 →
   마지막에 쓴 계정 → `default` 순서다 (§5.3).
3. **한도에 걸리면 다음 계정으로 자동 전환** — 하지 않는다. 쓸모는 있지만 지금 할 일이 아니다.

**열어 둔 질문**

1. **원격 접속**: 다른 PC 에서 이 서버 UI 로 접속해 로그인할 때, Claude 는 코드 붙여넣기라 되고
   Codex 는 `--device-auth` 로 된다. 둘 다 PoC 에서 같이 확인한다.

---

## 9. 주의 — 구독 약관

Claude Pro/Max·ChatGPT 구독은 **개인 사용 기준**이다. 서로 다른 사람의 계정을 한 서버에 등록해
각자 쓰거나(팀 공유 서버), 한 사람이 개인·업무 계정을 나눠 쓰는 것과, **한 사람이 같은 서비스의
계정 여러 개로 한도를 돌려 막는 것은 성격이 다르다.** 뒤쪽은 약관 위반 소지가 있다. 자동 전환을
하지 않기로 한 것(§8-3)도 이 점에서 맞다. 나중에 다시 꺼낸다면 "팀원별 계정" 시나리오에 맞춰 설계한다.

---

## 10. 근거로 본 코드

- `server/shared/utils.ts` — `getClaudeHomeDirectory`, `getClaudeKeychainServiceName` (설정 폴더별 키체인 항목)
- `server/modules/providers/list/claude/claude-runtime.provider.js:224` — `sdkOptions.env = { ...process.env, … }`
- `server/modules/providers/list/claude/claude-auth.provider.ts:186` — `CLAUDE_CODE_OAUTH_TOKEN` 인식
- `server/modules/providers/list/codex/codex-runtime.provider.ts:371` — `new Codex()` (SDK `CodexOptions.env` 지원)
- `server/modules/providers/services/claude-usage.service.ts`, `codex-rate-limit.service.ts:117` — 자격 증명을 직접 읽는 곳
- `src/modules/provider-auth/ProviderLoginModal.tsx` — 로그인 명령
- `docs/local/team-setup.md` §5 — `setup-token` 운영 경험과 흔한 실수
