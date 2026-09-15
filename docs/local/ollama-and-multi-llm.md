# Ollama 로컬 모델 · 여러 LLM 조합

2026-09-15 조사. **아직 적용하지 않았다.** 하고 싶어질 때 보는 문서다.

---

## 1. Ollama 로 로컬 모델 쓰기 — 된다. 코드 수정 0

### 왜 쉬운가

세 가지가 이미 갖춰져 있다.

1. **Ollama 가 Anthropic / OpenAI 호환 API 를 네이티브로 제공한다.** 예전처럼 LiteLLM
   같은 변환 프록시를 끼울 필요가 없어졌다.
2. **이 앱은 환경변수를 CLI 자식 프로세스에 통째로 넘긴다.**
   `claude-runtime.provider.js:225` 주석에 명시돼 있다 —
   *"Forward all host env vars (e.g. `ANTHROPIC_BASE_URL`) to the subprocess."*
3. **커스텀 모델을 추가하는 UI 와 DB 가 이미 있다.** 모델 라이브러리의
   "Manage models → Add a custom model" 이고, 안내 문구가
   *"provider CLI 가 받는 식별자를 그대로 쓰라"* 다. 설계 자체가 임의 모델 ID 를 허용한다.

### 방법 A — opencode 로 (권장)

**provider 가 분리돼 있어서 Claude 는 Claude 대로 두고 Ollama 만 따로 쓸 수 있다.**

`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": { "qwen3.5": { "name": "qwen3.5" } }
    }
  }
}
```

그다음 앱의 모델 라이브러리에서 커스텀 모델 `id = ollama/qwen3.5` 를 추가한다.
런타임이 `opencode run --model ollama/qwen3.5` 로 그대로 넘긴다.

주의 두 가지:

- 큐레이션 카탈로그에 `ollama/*` 항목이 없어서 **자동으로는 목록에 안 뜬다.**
  커스텀 모델 추가가 필수다(커스텀 모델은 이 필터를 우회한다).
- 인증 체크가 `~/.local/share/opencode/auth.json` 이나 환경변수만 보므로 Ollama 전용
  설치는 설정 화면에 **"OpenCode not configured"** 로 뜰 수 있다. 표시용일 뿐 채팅을
  막지는 않는다. (추측 — 코드 경로상 막지 않는 것이 맞지만 실행 검증은 하지 않았다.)

### 방법 B — claude 로 (전역)

`.env` 에 두 줄:

```
ANTHROPIC_BASE_URL=http://localhost:11434
ANTHROPIC_AUTH_TOKEN=ollama
```

그리고 claude 커스텀 모델을 추가한다.

> **치명적 한계**: `.env` 는 **서버 프로세스 전역**이다. per-세션 오버라이드 자리가
> 코드에 없다. 이걸 켜는 순간 **앱의 모든 Claude 세션이 Ollama 로 간다.**
> 진짜 Claude 와 섞어 쓰려면 코드 수정이 필요하다.

부수 효과(작음): effort 가 안 붙고, 컨텍스트 윈도우 표시가 부정확해진다.

### 방법 C — codex 로

`~/.codex/config.toml` 에 `[model_providers.*]` + `base_url`. Codex 는 `ollama` 를
내장 provider ID 로 예약하므로 **커스텀 이름을 따로 써야 한다**(예: `ollama-launch`).

per-세션 전환이 오히려 쉽다: `@openai/codex-sdk` 의 `CodexOptions` 에 `baseUrl`,
`apiKey`, `config`, `env` 가 있는데 `codex-runtime.provider.ts` 가 `new Codex()` 를
**옵션 없이** 호출한다. 여기에 분기를 넣으면 세션별 전환이 된다. 수십 줄 규모.

### cursor-agent — 사실상 불가

Cursor 는 커스텀 모델도 **Cursor 서버를 경유**해서 `localhost` 를 못 본다. 공개 HTTPS
터널이 필요하고 에이전트 모드에서 불안정하다는 보고가 많다. 권장하지 않는다.

### 모델 선택 주의

Ollama 문서도 *"Basic chat and file edits work with compatible models"* 라고만 한다.
**툴 콜 능력이 좋은 모델**(qwen3-coder 계열)을 골라야 하고 **컨텍스트 64k 이상**이
필요하다. 아무 모델이나 쓰면 파일 편집이 제대로 안 된다.

### 작업량

| 목표 | 작업 | 규모 |
|---|---|---|
| opencode + Ollama | `opencode.json` + UI 에서 커스텀 모델 추가 | 코드 0, 30분~1시간 |
| claude + Ollama (전역) | `.env` 2줄 + 커스텀 모델 | 코드 0, 10분 |
| codex + Ollama (전역) | `config.toml` + 커스텀 모델 | 코드 0, 30분 |
| claude/codex 를 **세션별로** 전환 | per-세션 env/baseUrl 주입 분기 | 코드 수정, 중간 |

---

## 2. 여러 LLM 을 병렬/직렬로 조합

### Agent Teams 는 안 된다 (확정)

[공식 문서](https://code.claude.com/docs/en/agent-teams) 원문:

> *"Spawning teammates also requires an interactive session. In non-interactive mode
> with the `-p` flag, **including Agent SDK sessions**, Claude doesn't spawn teammates."*

이 앱은 `@anthropic-ai/claude-agent-sdk` 로 붙으므로 **원천적으로 불가능하다.**

### 그런데 subagents 는 된다

**헤드리스에서도 정상 동작하고, 이 앱이 이미 렌더링하도록 만들어져 있다.**
`claude-runtime.provider.js:378, 465, 949` 가 `parent_tool_use_id` 를 추출해 subagent
트래픽을 그룹핑하고, 전용 테스트(`tests/claude-subagent-echo.test.ts`)까지 있다.

즉 `.claude/agents/*.md` 에 서브에이전트를 정의하면 **오늘 바로 병렬 실행되고 UI 에도
제대로 나온다.**

한계: subagent 모델은 **Anthropic 모델 중에서만** 고를 수 있다. Codex 나 로컬 모델을
subagent 로 쓸 수는 없다.

### 앱에 이미 있는 재료

| 모듈 | 역할 | 쓸모 |
|---|---|---|
| `POST /api/agent` | 외부용 HTTP API. `{provider, model, message, projectPath, sessionId, stream, createBranch, createPR}` 를 받아 헤드리스 실행 후 SSE 스트리밍 | **파이프라인의 핵심.** 외부 스크립트가 CLI 를 골라 작업을 던질 수 있다 |
| `chat-run-registry.service.ts` | run 을 세션 id 기준 Map 으로 관리 | **세션 단위 동시 실행이 이미 가능** |
| `runDetachedChatTurn()` | 클라이언트 소켓 없이 턴을 실행하고 끝날 때까지 await | 직렬 파이프라인 프리미티브 |
| `worktrees/` + Git 탭 | worktree 생성/머지/삭제 UI | **파일 충돌 회피 수단** |

**없는 것**: 하나의 요청을 여러 provider 에 자동 분배하거나, A 의 결과를 B 에 자동으로
넘기는 로직은 저장소 어디에도 없다.

프런트는 채팅 탭이 한 번에 세션 1개만 보여주지만, **`/session/:sessionId` 딥링크가 있어서
브라우저 창 2개를 나란히 띄우면 세션 2개를 동시에 볼 수 있다.** WebSocket 도
`chat.subscribe { sessions: [...] }` 로 복수 세션 구독을 이미 받는다.

### 구현안 — 노력 대비 효용 순

#### 안 A — 세션 병렬 + 사람이 조율 · **코드 0**

worktree 를 작업별로 만들고, 각각 세션을 열고, 브라우저 창을 나란히 띄운다.
예: 창1 = Claude(설계, main), 창2 = Codex(구현, `wt-impl`), 창3 = opencode+Ollama(리뷰).

- **한계**: 컨텍스트 공유가 안 된다. 사람이 결과를 복붙해야 한다.
- **장점**: **파일 충돌이 worktree 로 구조적으로 해결**되고 토큰 비용을 사람이 통제한다.
- **평가**: 지금 당장 얻는 효용이 가장 크다. 며칠 써보고 어디가 아픈지 확인한 뒤 B/C 로 갈 것.

#### 안 B — Claude subagents 정의 · **코드 0**

`.claude/agents/` 에 역할별 서브에이전트(`designer.md`, `reviewer.md`, `security-critic.md`)를
만들고 "세 관점으로 동시에 검토해줘" 라고 시킨다.

- **한계**: **Claude 안에서만.** 다른 CLI 와는 못 섞는다. 토큰 비용이 에이전트 수에
  비례해 선형 증가. subagent 가 같은 파일을 만지면 덮어쓰기 위험.
- **평가**: "병렬 탐색/리뷰" 목적이면 투입 대비 효과가 압도적이다.

#### 안 C — 외부 스크립트가 `POST /api/agent` 로 파이프라인 · **작음**

설정 > API 키에서 키를 발급받고 스크립트가 순서대로/동시에 호출한다.

```
1. POST /api/agent {provider:"claude",   message:"설계해줘", projectPath, stream:false}
2. POST /api/agent {provider:"codex",    message:"위 설계대로 구현: " + 1의결과, projectPath}
3. POST /api/agent {provider:"opencode", model:"ollama/qwen3.5", message:"리뷰: " + diff}
```

`stream:false` 면 결과를 JSON 으로 모아 돌려준다. `Promise.all` 이면 병렬, 순차 await 면 직렬.

- **위험**:
  - **항상 `bypassPermissions` 로 돈다.** 권한 승인 UI 를 못 거치므로 신뢰하는
    프롬프트에만 쓸 것.
  - 컨텍스트 공유는 "이전 결과를 다음 프롬프트에 붙이기" 수준.
  - 병렬 시 같은 `projectPath` 를 쓰면 **파일 충돌이 실제로 난다.** worktree 로 나눌 것.
  - 토큰 비용이 단계 수만큼 곱해진다.
- **평가**: **"서로 다른 CLI 조합" 이라는 요구를 실제로 충족하는 가장 싼 방법.**
  저장소를 건드리지 않아 upstream 업데이트 충돌도 없다.

#### 안 D — 앱 내장 오케스트레이터 · **크다 (1~2주)**

`server/modules/orchestrator/` 신설. 워크플로를 DB 에 저장하고 `runDetachedChatTurn()` 을
엮어 DAG 실행기를 만든다. 프런트에 워크플로 편집기 + 결과 비교 뷰.

- **평가**: A~C 로 워크플로가 안정화된 뒤에 검토할 것. **먼저 만들면 거의 확실히
  헛수고가 된다.**

---

## 출처

- [OpenCode — Ollama 공식 문서](https://docs.ollama.com/integrations/opencode)
- [Codex CLI — Ollama 공식 문서](https://docs.ollama.com/integrations/codex)
- [Claude Code — Ollama 공식 문서](https://docs.ollama.com/integrations/claude-code)
- [Claude Code — Agent teams (헤드리스 제약)](https://code.claude.com/docs/en/agent-teams)
