# MCP 서버 폼 개편 스펙

작성일 2026-09-22. liberty-life 세션에서 QueryForge(HTTP MCP)를 ai-cli에 붙이다가 드러난
문제를 근거로 작성. 구현은 ai-cli 리포에서 진행한다.

**구현 상태 (2026-09-22)**: 변경 1 · 2 · 3a · 4 와 i18n 11개 로케일, 잔여물 정리까지 완료.
변경 3b · 3c 는 보류 — 사유는 각 절에 남겼다.

## 배경 — 실제로 무슨 일이 있었나

QueryForge는 Streamable HTTP MCP 서버(`http://127.0.0.1:31571/mcp`, `x-api-key` 헤더 인증)다.
UI로 등록했는데 계속 실패했고, 실패 경로가 폼 설계 문제를 그대로 드러냈다.

1. 사용자가 헤더를 입력했다고 생각했지만 실제로는 빈 칸이었다. placeholder
   (`Authorization=Bearer token` / `X-API-Key=your-key`)가 입력값처럼 읽혔다.
2. 그 전에는 API 키를 **환경 변수 칸**에 넣었다. HTTP 서버인데도 그 칸이 보였기 때문이다.
   서버는 http/sse일 때 `env`를 저장하지 않고 버린다.
3. 결과적으로 헤더 없이 요청 → QueryForge가 `401` → Claude Code가 OAuth 서버로 판단하고
   Dynamic Client Registration 시도 → QueryForge에 `/register`가 없으니 `404` →
   최종 에러 메시지는 `Dynamic Client Registration rejected (HTTP 404)`.

즉 사용자에게 보인 에러가 실제 원인(헤더 누락)과 전혀 연결되지 않았다. 폼이 오입력을
유도했고, 실패했을 때 진단할 방법도 없었다.

### 확인된 사실

- 헤더 이름 대소문자는 무관하다. `x-api-key` / `X-API-Key` / `X-Api-Key` 전부 `200` 실측.
  기존 placeholder가 틀렸던 건 casing이 아니라 **Bearer 예시가 먼저 와서 인증 방식을
  오해하게 만든 것**이다.
- 키를 넣으면 정상 동작한다. `initialize` → `serverInfo: queryforge 0.1.0`,
  `schema(list_tables)` → `liberty_life` 22개 테이블.
- ai-cli는 `CLAUDE_CONFIG_DIR=/Users/linalee/.claude-work`(`.env:7`)를 쓴다. 터미널
  Claude Code의 `~/.claude.json`과 **다른 파일**이다. 터미널에 등록된 MCP는 ai-cli에
  나타나지 않는다. 회귀 테스트할 때 이 점을 혼동하지 말 것.

## 변경 1 — 환경 변수 칸을 stdio 전용으로 ✅

`src/modules/mcp/McpServerFormModal.tsx:342-355`. 현재 조건은 `importMode === 'form'`
하나뿐이라 전송 유형과 무관하게 항상 그려진다. `formData.transport === 'stdio'` 조건을 추가한다.

근거: `server/modules/providers/list/claude/claude-mcp.provider.ts`의 `buildServerConfig`는
stdio일 때만 `env`를 저장하고, http/sse는 `{ type, url, headers }`만 남긴다. 지금 UI는
저장되지 않을 값을 받고 있다.

codex / cursor / opencode 프로바이더도 같은 규칙인지 확인하고 함께 맞출 것
(`server/modules/providers/list/*/`).

**결과**: 네 프로바이더 모두 http/sse에서 `env`를 버리는 것을 확인했다. 폼이 공용이라
UI 조건 한 곳만 고치면 전부 맞는다. 추가로 `createMcpPayloadFromForm`도 http/sse일 때
`env`를 아예 실어 보내지 않게 했다 — 저장되지 않을 값을 요청에 담고 있었다.

## 변경 2 — API Key 전용 입력 + 고급 토글 ✅

http/sse일 때 헤더 입력을 두 단계로 나눈다.

**기본**: `API Key` 단일 입력. `type="password"`, 회색 placeholder로 형식 안내.
저장 시 `headers['x-api-key']`로 매핑한다.

**고급 토글 ON**: 기존 자유 헤더 textarea 노출. Authorization Bearer 방식 서버도 계속
등록 가능해야 한다 — 이 경로를 없애면 회귀다.

구현 시 정해야 할 것:

- **로드 규칙** (확정): 헤더가 `x-api-key` 하나뿐이면(대소문자 무시) API Key 칸에 채우고
  자유 헤더는 비운다. 그 외에는 헤더를 그대로 두고 고급 토글을 켠 상태로 연다.
  `readApiKeyHeader`가 이 판정을 한다.
- **충돌 규칙** (확정): 고급 textarea 우선. 전부 보이는 편집기에 사용자가 직접 적은 값을
  단순 칸에 남은 값이 조용히 덮어쓰지 않게 한다. `mergeApiKeyHeader`가 대소문자 무시로
  비교하므로 중복 키가 생기지 않는다.
- placeholder 순서를 뒤집어 `X-API-Key`를 첫 줄로 올렸고, API Key 칸의 placeholder는
  값처럼 읽히지 않도록 설명문("서버에서 발급한 키를 붙여 넣으세요")으로 바꿨다. 이번 사고의
  직접 원인이 placeholder를 입력값으로 오인한 것이었다.

파싱은 `src/modules/mcp/utils/mcpFormatting.ts:42` `parseKeyValueLines`가 첫 `=` 기준으로
자른다. 값에 `=`가 들어가도 안전하다.

## 변경 3 — 스위치 3종

### 3a. 고급 설정 접기 토글 ✅

변경 2의 자유 헤더 + (stdio의) 환경 변수 + codex 전용 칸을 감싼다. 로컬 UI 상태만 쓴다.
편집으로 열 때 감춰질 값이 이미 들어 있으면 펼친 상태로 연다(`hasAdvancedValues`).

### 3b. DEBUG 등 옵션 플래그 체크박스 — 보류

노출할 플래그 목록이 정해지지 않아 구현하지 않았다.

**열린 질문**: 현재 `DEBUG=true`는 placeholder에 적힌 예시일 뿐 MCP 규격도, ai-cli가
해석하는 값도 아니다. 체크박스로 노출할 플래그 목록이 먼저 정해져야 구현할 수 있다.
(임의로 `DEBUG` 하나를 박아넣지 말 것 — 아무 데도 전달되지 않는다.)

### 3c. 서버 사용/중지 토글 — 보류 (가장 주의할 항목)

아래 위험이 해소되지 않아 이번 범위에서 제외했다. 착수 전에 "Claude Code가 모르는 최상위
키를 보존하는가"를 실측으로 먼저 확인할 것.

Claude Code의 `.claude.json` `mcpServers` 엔트리에는 `enabled` 필드가 없다. `settings.json`의
`enabledMcpjsonServers` / `disabledMcpjsonServers`는 **프로젝트 `.mcp.json` 서버 전용**이라
user scope 서버에는 쓸 수 없다.

따라서 ai-cli 자체 규약이 필요하다. 후보:

- 같은 파일 안에서 `_aiCliDisabledMcpServers` 같은 별도 키로 엔트리를 옮겼다가 복원.
  → Claude Code가 모르는 최상위 키를 덮어쓰지 않고 보존하는지 **먼저 검증할 것.**
  보존하지 않으면 설정이 조용히 날아간다.
- ai-cli 자체 저장소(`server/`쪽 DB나 별도 JSON)에 파킹 후 복원.

어느 쪽이든 "끄기 = 설정 파일에서 제거"이므로, 복원 실패 시 사용자 설정이 사라진다.
되돌리기 경로와 백업을 같이 설계할 것. 참고로 `/Users/linalee/.claude-work/backups/`는
문서 작성 시점에 **존재하지 않았다** — 아래 잔여물 정리를 하면서 새로 만들었다.

## 변경 4 — 연결 테스트 버튼 ✅

`POST /api/providers/:provider/mcp/test`

- body: 폼 현재 값(`{ transport, url, headers }`) 또는 저장된 서버(`{ name, scope, workspacePath }`)
- http/sse: `fetch` POST, 헤더에 사용자 지정 헤더 + `Content-Type: application/json` +
  `Accept: application/json, text/event-stream`, 본문은 `initialize` JSON-RPC
  (`protocolVersion: "2025-06-18"`). 타임아웃 5초.
- 성공 → `result.serverInfo`를 그대로 UI에 (`queryforge 0.1.0 연결됨`)
- 실패는 구분해서 안내:
  - `401`/`403` → "인증 실패 — API Key를 확인하세요" (이번 사고가 여기 해당)
  - `404` → "MCP 엔드포인트가 아닙니다 — URL 경로 확인"
  - ECONNREFUSED → "서버에 연결할 수 없습니다 — 기동 여부 확인"
  - 타임아웃 → 별도 메시지

MCP SDK 의존성은 불필요하다. `@modelcontextprotocol/sdk`가 `package.json`에 없고, Node 22
전역 `fetch`로 충분하다(위 curl 검증과 동일한 요청).

구현은 `server/modules/providers/services/mcp-connection-test.service.ts`. 폼 현재 값과
저장된 서버(`{ name, scope, workspacePath }`) 양쪽을 받는다.

- **stdio 연결 테스트**: 제외했다. 서버가 사용자 지정 command를 spawn하게 되므로 별도
  검토가 필요하다. stdio일 때는 버튼을 숨기고, 엔드포인트도 `MCP_TEST_UNSUPPORTED_TRANSPORT`로
  거절한다.
- **SSRF**: `/api/providers`가 `authenticateToken` 뒤에 있는 것을 확인했다(`server/index.ts:232`).
  더해서 스킴을 http/https로 제한하고, `redirect: 'manual'`로 리다이렉트를 따라가지 않는다
  (따라가면 사용자가 적지도 않은 호스트로 인증 헤더가 새어 나간다). 사설·루프백 주소는
  **일부러 허용**한다 — 로컬 MCP 서버가 이 버튼의 주 사용처다.
- `Content-Type` / `Accept` / `Host` 같은 예약 헤더는 사용자 입력에서 걸러낸다. 덮어쓰면
  인증이 아니라 핸드셰이크가 깨진다.
- 응답은 JSON과 SSE 프레임(`data: {...}`) 양쪽을 푼다. Streamable HTTP 서버가 둘 다 쓴다.

## i18n

로케일 11개를 모두 채워야 한다: `de en es fr it ja ko ru tr zh-CN zh-TW`
(`src/modules/i18n/locales/*/settings.json`).

추가할 키 (`mcpForm` 아래):

- `fields.apiKey`, `fields.apiKeyHelp`, `fields.advanced`, `fields.headersHelp`
- `placeholders.apiKey`
- `actions.testConnection`, `actions.testing`
- `test.success`, `test.authFailed`, `test.notFound`, `test.unreachable`, `test.timeout`
- `test.unknownServer` (serverInfo를 안 주는 서버), `test.failed` (그 외 실패 폴백)

수정할 키:

- `fields.envVars` — 설명에 stdio 전용임을 명시
- `fields.headers` — 고급 설정 하위로 내려가므로 문구 조정

## 검증

- `server/modules/providers/tests/mcp.test.ts`에 연결 테스트 8케이스 추가 (성공/SSE 프레임/
  401/404/ECONNREFUSED/타임아웃/리다이렉트 비추적/stdio·비HTTP 거절). 14/14 통과.
- `src/modules/mcp/tests/mcpApiKeyHeader.test.ts`에 로드·충돌 규칙 9케이스. vitest 520/520 통과.
- oxlint 에러 없음, `npm run typecheck`·`npm run build:client` 통과.
- 실물 회귀: QueryForge(`http://127.0.0.1:31571/mcp`) 상대로 서비스를 직접 호출해 다섯 경로를
  실측했다 — `x-api-key`/`X-API-Key` 둘 다 `queryforge 0.1.0`, 헤더 없음 → `authFailed(401)`,
  잘못된 경로 → `notFound(404)`, 죽은 포트 → `unreachable`. 이번 사고의 그 입력이 이제
  "인증 실패 — API 키를 확인하세요"로 나온다.
- 주의: `npm test` 전체 실행 시 `server/modules/agent/tests/agent.routes.test.ts`가 약 50%
  확률로 실패한다. **이 변경과 무관한 기존 flake** — 손대지 않은 트리에서 6회 중 3회 동일하게
  실패하는 것을 확인했다.
- 남은 확인: UI에서 저장 → **새 세션**에서 `mcp__queryforge__schema` 호출. MCP 목록은
  `claude` 프로세스 기동 시점에 읽히므로 열려 있는 세션에는 반영되지 않는다.

## 정리할 잔여물 ✅

`/Users/linalee/.claude-work/.claude.json`의 `claude-user-stdio` 엔트리는 존재하지 않는
`npx -y my-server`를 가리키는 더미인데, 그 `env.API_KEY`에 실제 QueryForge 키가 들어가 있다
(오입력 흔적). 계속 `CONNECTION_CLOSED`를 내고 있으니 삭제할 것.

삭제 완료. `/Users/linalee/.claude-work/backups/claude.json.<timestamp>.bak`에 원본을 남기고
해당 엔트리만 제거했으며, 나머지 설정이 바이트 단위로 동일한 것을 확인했다(`projects` 31개 유지).

## 열린 질문 정리

1. 3b에서 노출할 플래그 목록 — **미정, 보류**
2. 3c 사용/중지 저장 방식 (별도 키 vs ai-cli 저장소) — **미정, 보류.** 착수 전 "Claude Code가
   모르는 최상위 키를 보존하는가" 실측이 선행 조건
3. stdio 연결 테스트를 1차에 포함할지 — **제외.** stdio일 때 버튼을 숨긴다
4. 변경 1·2를 codex / cursor / opencode 프로바이더에도 적용할지 — **적용됨.** 폼이 공용이고
   네 프로바이더의 `buildServerConfig`가 모두 같은 규칙이라 자동으로 맞는다
