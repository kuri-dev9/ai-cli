# Claude Code CLI 헤드리스 프로토콜 스펙

`claude` CLI를 프로그램에서 구동해 GUI/웹앱을 만들 때 필요한 프로토콜 정리.
**직접 실행해서 검증한 내용**이며, 문서에만 있고 검증하지 못한 것은 그렇게 표시했다.

- 검증 환경: macOS, Claude Code **2.1.236**, 2026-09-15
- 이 저장소(CloudCLI UI)는 이미 공식 **Claude Agents SDK**로 붙어 있어서 당장 쓸 일은
  없다. 이 앱을 깊게 고치거나 직접 만들 때의 설계 자료다.

> **버전 의존성 경고**: 아래 내용 중 상당수는 `--help` 에도 공식 문서에도 없는 것이다.
> CLI 버전이 올라가면 깨질 수 있다. 새 버전에서는 다시 검증할 것.

---

## 0. 결론부터

1. **`--permission-prompt-tool stdio`** — MCP 서버 없이, 이미 열린 stdin/stdout으로 권한
   승인을 주고받을 수 있다. **GUI 승인 버튼의 정답이다.** `--help` 에도 공식 문서에도
   나오지 않는 숨김 플래그다.
2. **`claude-agent-sdk` Python 패키지에 공식 세션 관리 API가 있다.** `list_sessions()`,
   `delete_session()`, `rename_session()` 등. **JSONL을 직접 파싱하지 말 것.**
3. 프로세스를 **살려두고 여러 턴**을 주고받을 수 있다. 턴마다 재시작할 필요 없다.

---

## 1. 양방향 스트리밍

### 기본 형태

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --permission-prompt-tool stdio
```

`--verbose` 는 공식 문서의 모든 예제가 붙이고 있다. 2.1.236에서는 생략해도 하드 에러가
나지 않았지만 **항상 붙이는 것이 안전하다.**

### 입력 (stdin) — NDJSON

한 줄에 JSON 객체 하나, `\n` 종료. 통과 확인된 최소 형태:

```json
{"type":"user","message":{"role":"user","content":"안녕"}}
```

- `content` 는 **plain string** 도 되고 content block 배열도 된다.
- `session_id` 를 넣어도 **무시된다.** CLI가 자체 값을 쓴다.
- 모르는 필드는 무시된다.

> **함정 — 가장 흔한 실수**: 잘못된 JSON 줄 하나가 들어가면 **프로세스가 즉시 exit 1로
> 죽는다.** 뒤에 유효한 줄이 와도 복구되지 않고 stdout에 아무것도 안 나온다.
> 반드시 `json.dumps()` 결과만 쓰고 개행이 섞이지 않게 할 것.

### 출력 (stdout) — 이벤트 타입

| type | 설명 |
|---|---|
| `system` | subtype 으로 분기 (아래) |
| `assistant` | Claude 응답 (text / thinking / tool_use 블록) |
| `user` | tool_result |
| `result` | 턴 종료. **비용·토큰의 단일 진실 원천** |
| `stream_event` | 델타 스트리밍 (partial) |
| `rate_limit_event` | 레이트리밋 상태 |
| `control_request` | **CLI → 클라이언트** (권한 요청 등) |
| `control_response` | 양방향 |
| `control_cancel_request` | 요청 취소 |
| `conversation_reset` | 컨텍스트 리셋 |

`system` 의 subtype: `init`, `status`, `permission_denied`, `api_retry`, `plugin_install`,
`task_started`, `task_progress`, `task_notification`, `task_updated`, `mirror_error`,
`hook_started` / `hook_progress` / `hook_response`(`--include-hook-events` 시).

`system/init` 에 GUI 초기화에 필요한 게 다 들어있다 — `session_id`, `tools`, `model`,
`permissionMode`, `slash_commands`, `agents`, `skills`, `mcp_servers`, `capabilities`.

> **함정**: **턴마다 `system/init` 이 다시 나온다.** 이걸 "세션 시작"으로 처리하면 매 턴
> UI가 리셋된다. **"현재 설정 스냅샷"으로 취급할 것.**

### 실시간 타이핑 효과

`--include-partial-messages` 를 붙이면 `stream_event` 로 API의 raw SSE가 그대로 나온다.

```json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,
 "delta":{"type":"text_delta","text":"안"}},"session_id":"..."}
```

시퀀스: `message_start` → `content_block_start` → `content_block_delta`×N →
`content_block_stop` → `message_delta` → `message_stop`

`.event.delta.type == "text_delta"` 의 `.text` 를 이어붙이면 된다. 툴 입력은
`input_json_delta` 로 온다.

### 멀티턴 — 프로세스 유지

한 프로세스에 메시지를 순차 전송하면 `session_id` 가 동일하게 유지된다. stdin을 닫을
때까지 프로세스가 살아 있다. **턴마다 새로 띄울 필요 없다.**

---

## 2. 권한 처리 (GUI 핵심)

### 승인 수단이 없으면

실패하지 않고 **자동 거부**되며 세션은 계속 진행된다.

- `system/permission_denied` 이벤트 방출
- tool_result 에 `is_error: true`
- `result.permission_denials` 배열에 기록
- exit code는 **0**

참고: `echo` 같은 read-only 명령은 프롬프트 없이 자동 승인된다.

### `--permission-mode` 유효 값

2.1.236의 검증 에러 메시지 원문:

```
Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.
```

| 값 | 의미 |
|---|---|
| `manual` | 기본. 프롬프트 발생 (`default` 의 별칭) |
| `auto` | 분류기가 대부분 자동 판정 |
| `acceptEdits` | 파일 쓰기 + `mkdir/touch/mv/cp` 자동 승인 |
| `plan` | 계획만, 편집 없음 |
| `dontAsk` | 프롬프트 대상은 전부 거부 (락다운용) |
| `bypassPermissions` | 전부 통과 |

> **함정**: 에러 메시지엔 없지만 **`default` 도 실제로 통과한다.** 그리고 `manual` 을
> 넘겨도 `system/init` 에는 **`"default"` 로 보고된다.** GUI에서 표시할 때 매핑이 필요하다.

### `--permission-prompt-tool stdio` — GUI 승인 버튼

**`--help` 에 안 나오지만 존재한다.** 이걸 넘기면 CLI가 이미 열린 stdout으로
`control_request` 를 보내고 stdin으로 응답을 기다린다.

CLI가 보내는 요청:

```json
{"type":"control_request","request_id":"d71e84d0-...",
 "request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
   "input":{"file_path":"/.../out.txt","content":"..."},
   "description":"out.txt",
   "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
   "tool_use_id":"toolu_..."}}
```

승인 응답 (`request_id` 를 그대로 에코):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"d71e84d0-...",
  "response":{"behavior":"allow","updatedInput":{ }}}}
```

거부 응답:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"d71e84d0-...",
  "response":{"behavior":"deny","message":"사용자가 거부함","interrupt":false}}}
```

유용한 필드:

- `updatedInput` — **툴 입력을 GUI에서 수정해서 승인** 가능 (예: 경로 샌드박싱)
- `updatedPermissions` — "이 세션 동안 항상 허용" 구현용
- `permission_suggestions` — CLI가 제안하는 버튼. 위 예시는 **"이 세션에서 편집 항상 허용"**
  버튼에 그대로 대응
- `interrupt: true` — 거부하면서 턴 전체를 중단

> `initialize` 핸드셰이크는 **불필요하다**(검증함). 다만 보내면 응답에 **슬래시 커맨드
> 전체 목록**이 담겨 와서 커맨드 팔레트에 쓸 수 있다.
> `{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize","hooks":null}}`

### `--dangerously-skip-permissions` 는 쓸 필요 없다

GUI라면 권장 순서대로:

1. **`--permission-prompt-tool stdio`** — 진짜 승인 UI. 정답.
2. `--permission-mode acceptEdits` — 편집만 자동, 셸·네트워크는 프롬프트
3. `--allowedTools "Read" "Bash(git status *)"` — prefix 매칭
   - **`*` 앞의 공백이 중요하다.** `Bash(git diff*)` 는 `git diff-index` 까지 매칭된다.
4. `--permission-mode auto`

---

## 3. 세션 관리

### 목록 — CLI엔 없고 Python SDK에 있다

CLI에 세션 목록 서브커맨드는 **없다.** 대신:

```python
from claude_agent_sdk import list_sessions, get_session_messages, delete_session
sessions = list_sessions(directory="/path/to/project")
```

```
SDKSessionInfo(session_id='...', summary='my-session', last_modified=1789456199400,
               file_size=11092, custom_title='my-session', first_prompt='hello',
               git_branch='HEAD', cwd='/...', tag=None, created_at=1789456199364)
```

전체 API:

```python
list_sessions(directory=None, limit=None, offset=0, include_worktrees=True)
get_session_info(session_id, directory=None)
get_session_messages(session_id, directory=None, limit=None, offset=0)
delete_session(session_id, directory=None)
fork_session(session_id, directory=None, up_to_message_id=None, title=None)
rename_session(session_id, title, directory=None)
tag_session(session_id, tag, directory=None)
list_subagents(session_id, directory=None)
project_key_for_directory(directory=None)
```

대화 제목은 `custom_title` → `summary` → `first_prompt` 순으로 폴백하면 된다.

### transcript 경로

```
~/.claude/projects/<project>/<session-id>.jsonl
```

`<project>` = 작업 디렉터리 절대경로의 **모든 비영숫자 문자를 `-` 로 치환**. 선행 `/` 도
`-` 가 되고, 연속된 비영숫자는 각각 `-` 하나씩(축약 없음). 200자를 넘으면 자르고 해시를 붙인다.

**직접 구현하지 말고 `project_key_for_directory()` 를 쓸 것.**

> **첫 줄에 요약/제목은 없다.** 실측한 줄 타입 순서:
> `queue-operation, queue-operation, user, attachment×4, atis-latch, assistant, last-prompt`
>
> 공식 문서 경고 원문: *"The entry format is internal to Claude Code and changes between
> versions, so scripts that parse these files directly can break on any release."*
> → **JSONL 직접 파싱 금지.**

### 재개

- `claude -p --resume <session-id>` — v2.1.223+ 부터 **머신 내 어느 디렉터리에서든** ID로 찾는다
- `--resume` 에 `.jsonl` 절대경로를 직접 넘겨도 된다
- **`-p`/SDK로 만든 세션은 `--continue` 와 `/resume` 피커에서 제외된다.**
  → GUI는 **항상 `--resume <id>`** 를 쓸 것
- `--session-id <uuid>` 로 **ID를 직접 지정**할 수 있다(유효한 UUID 필수).
  → **GUI가 세션 ID를 선발급해서 DB에 먼저 기록하는 설계가 가능하다. 강력 추천.**

> **함정**: `-p` 재개 시 **권한 모드, `--mcp-config`, `--settings`, `--add-dir`,
> `--fallback-model` 이 복원되지 않는다.** 재개할 때마다 전부 다시 넘겨야 한다.

---

## 4. 런타임 제어 — 재시작 없이 바꾸기

stdin으로 control message를 보낸다. **SIGINT 불필요.**

```json
{"type":"control_request","request_id":"<임의 고유값>","request":{"subtype":"interrupt"}}
```

| subtype | 페이로드 | 용도 | 검증 |
|---|---|---|---|
| `interrupt` | — | 정지 버튼 | ✅ |
| `set_permission_mode` | `{"mode":"acceptEdits"}` | 권한 모드 토글 | ✅ |
| `set_model` | `{"model":"haiku"}` | 모델 드롭다운 | ✅ |
| `get_context_usage` | — | 컨텍스트 게이지 (`/context` 와 동일) | ✅ |
| `initialize` | `{"hooks":null}` | 슬래시 커맨드 목록 | ✅ |
| `mcp_status` / `mcp_reconnect` / `mcp_toggle` | — | — | 미검증 |
| `stop_task` / `rewind_files` | — | — | 미검증 |

> **중요**: **interrupt 후에도 프로세스는 살아 있고 다음 턴을 정상 수행한다.** 정지 버튼을
> 눌러도 프로세스를 재시작할 필요가 없다.
> 다만 그 턴의 `result` 는 `subtype: "error_during_execution"`,
> `terminal_reason: "aborted_streaming"`, `is_error: true` 로 나온다.
> **에러가 아니라 정상 취소로 UI 처리할 것.**

`system/init` 의 `capabilities` 배열로 feature detection 할 것.
2.1.236: `["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]`

---

## 5. 비용·토큰

세 곳에서 온다.

1. **`result` (최종, 권위 있음)** — `total_cost_usd`, `usage.*`, `modelUsage`(모델별 분해:
   `costUSD`, `contextWindow`, `maxOutputTokens`, `provider`)
2. `assistant` 이벤트의 `message.usage` — API 호출 단위
3. `stream_event` / `message_delta` — 스트리밍 중 누적

`rate_limit_event` 로 레이트리밋 상태도 온다 (`status`, `resetsAt`, `rateLimitType`,
`overageStatus`). 상단 사용량 배너에 쓰기 좋다.

> 공식 문서 주의 원문: *"Both figures are client-side estimates and can differ from your
> actual bill."* → UI에 추정치임을 명시할 것.

---

## 6. 기타 플래그

| 플래그 | 비고 |
|---|---|
| `--model <alias\|full>` | `opus`, `sonnet`, `haiku`, `fable` 또는 전체 ID |
| `--add-dir <dirs...>` | 파일 접근만 허용. **해당 디렉터리의 `.claude/` 설정은 로드 안 함** |
| `--allowedTools` / `--disallowedTools` | 공백/쉼표 구분 |
| `--tools <names>` | `""` = 전부 비활성, `"default"` = 전부 |
| `--settings <file-or-json>` | 파일 경로 **또는 인라인 JSON 문자열** |
| `--mcp-config <configs...>` | `--strict-mcp-config` 와 함께 쓰면 다른 MCP 설정 무시 |
| `--agents <json>` | 인라인 서브에이전트 정의 |
| `--max-turns <n>` | **`--help` 에 없지만 존재** |
| `--max-budget-usd <n>` | 비용 상한 |
| `--no-session-persistence` | transcript 미저장 |
| `--bare` | 훅·플러그인·CLAUDE.md 전부 스킵. 빠른 시작 |

> **`--cwd` 플래그는 존재하지 않는다.** `subprocess.Popen(..., cwd=...)` 로 지정할 것.

---

## 7. 구현 시 주의사항

- **stdout/stderr 둘 다 전용 리더 스레드로 반드시 드레인할 것.** 안 읽으면 파이프 버퍼가
  차서 CLI가 멈춘다. 문서상 소비자가 느리면 최대 30초까지 기다린다.
- stdin은 매 write 후 **반드시 flush**. 빠지면 교착된다. Popen은 `bufsize=1, text=True`.
- **잘못된 JSON 한 줄 = 프로세스 즉사.** 가장 흔한 실수.
- 종료: `stdin.close()` → 자연 종료. 강제 시 SIGTERM(exit 143).
- exit code: 0 성공 / 1 실패·파싱에러·interrupt / 143 SIGTERM
- stdin 파이프 입력은 **10MB 상한**
- **Homebrew cask 경로에는 버전이 박혀 있다** (`/opt/homebrew/Caskroom/claude-code/2.1.236/claude`).
  업데이트하면 경로가 바뀐다. `/opt/homebrew/bin/claude` 를 쓰거나 `cli_path` 로 명시할 것.

### 환경변수 함정

- `CLAUDE_CONFIG_DIR` 을 바꾸면 **OAuth 로그인 정보가 딸려가지 않아 인증이 깨진다.**
  격리하려면 `ANTHROPIC_API_KEY` 를 함께 넣어야 한다.
- `CLAUDE_CODE_PROJECT_DIR_NAME` 을 쓰면 transcript 저장 위치가 바뀌는데,
  `list_sessions()` 는 derived slug를 찾으므로 **0건을 반환한다.** 둘을 섞어 쓰지 말 것.

---

## 8. Python에서 쓸 때 — SDK vs raw subprocess

```bash
pip install claude-agent-sdk      # 검증 버전 0.2.152
```

**SDK 권장.** 이유:

1. `can_use_tool` 콜백이 GUI 승인에 그대로 맞는다. `async` 콜백이므로 `asyncio.Event` 로
   프런트 응답을 기다리게 하면 그대로 승인 다이얼로그가 된다.
2. 세션 목록/삭제/제목/포크를 공짜로 얻는다. 직접 구현하면 **버전마다 깨지는 내부 JSONL
   포맷**을 떠안는다.
3. NDJSON 파싱, request_id 상관관계, 버퍼 관리를 SDK가 처리한다.
4. 보안 이슈를 이미 처리했다 — 예: `--resume=<value>` 형태로 넘겨서 값에 dash가 들어갈 때
   **플래그 인젝션**을 막는다. 직접 짜면 놓치기 쉽다.

**절충안(추천)**: 대화 스트림은 raw subprocess + `--permission-prompt-tool stdio` 로 직접
다루고(JSON을 파싱 없이 프런트로 그대로 relay), **세션 목록/삭제/제목만 SDK 함수를
import해서 쓴다.** 세션 API는 프로세스와 무관한 순수 함수라 혼용이 안전하다.

---

## 9. 백엔드 설계 스케치

```
FastAPI + WebSocket
  └── SessionManager
        ├── 세션 목록/삭제/제목 : claude_agent_sdk.list_sessions / delete_session / rename_session
        └── ClaudeProcess (세션당 1개, 장기 생존)
              spawn: claude -p
                     --input-format stream-json --output-format stream-json --verbose
                     --include-partial-messages
                     --permission-prompt-tool stdio
                     --session-id <GUI가 발급한 UUID>
                     [--resume <id>] [--model ...] [--add-dir ...]
                     cwd=<프로젝트 경로>          # --cwd 플래그 없음!
              ├── stdout reader ──┬─ control_request/can_use_tool → WS로 승인 다이얼로그
              │                   │    → 프런트 응답 → control_response 를 stdin 에 write
              │                   ├─ stream_event/text_delta → WS로 타이핑 스트림
              │                   ├─ assistant(tool_use)     → 툴 카드 렌더
              │                   ├─ user(tool_result)       → 툴 카드에 결과 채움
              │                   ├─ system/init             → 모델·권한모드 UI 갱신(리셋 아님!)
              │                   └─ result                  → 비용/토큰 갱신, 턴 종료
              ├── stderr reader (반드시 드레인)
              └── stdin writer (json.dumps + "\n" + flush, 단일 lock)
```

---

## 10. 함정 요약

| # | 함정 | 대응 |
|---|---|---|
| 1 | 잘못된 JSON 한 줄 → 프로세스 즉사 | `json.dumps` 만 사용 |
| 2 | 턴마다 `system/init` 재방출 | 세션 시작으로 처리하지 말 것 |
| 3 | `--cwd` 없음 | Popen `cwd=` 사용 |
| 4 | `-p` 재개 시 권한모드·MCP·settings 미복원 | 재개할 때마다 전부 재전달 |
| 5 | `-p` 세션은 `--continue` 피커에서 제외 | 항상 `--resume <id>` |
| 6 | transcript JSONL은 내부 포맷, 릴리스마다 변경 | SDK 세션 API 사용 |
| 7 | `CLAUDE_CODE_PROJECT_DIR_NAME` → `list_sessions` 0건 | 둘 중 하나만 |
| 8 | `CLAUDE_CONFIG_DIR` 변경 → OAuth 인증 소실 | `ANTHROPIC_API_KEY` 병행 |
| 9 | stdout/stderr 미드레인 → CLI 블록 | 리더 스레드 2개 필수 |
| 10 | `--permission-prompt-tool`, `--max-turns` 는 `--help` 에 없음 | 존재하니 그대로 사용 |
| 11 | `manual` 이 init에 `default` 로 보고됨 | GUI 라벨 매핑 |
| 12 | Homebrew cask 경로에 버전 고정 | `/opt/homebrew/bin/claude` 사용 |
| 13 | `Bash(git diff *)` 의 `*` 앞 공백 필수 | 없으면 `git diff-index` 까지 매칭 |
| 14 | 비용은 클라이언트 측 추정치 | UI에 명시 |
| 15 | interrupt 후 `result` 가 `error_during_execution` | 에러 아닌 정상 취소로 처리 |

---

## 참고

- https://code.claude.com/docs/ko/headless
- https://code.claude.com/docs/ko/cli-reference
- https://code.claude.com/docs/ko/sessions
- https://code.claude.com/docs/ko/agent-sdk/python
- https://code.claude.com/docs/ko/permission-modes
