# 이 설치본에 가한 수정

upstream(siteboon/claudecodeui `1.37.3`)에서 클론한 뒤 로컬에서 고친 내용 전부.
**upstream을 업데이트(`git pull`)하면 이 수정들이 충돌하거나 사라질 수 있다.** 그때
이 문서를 보고 다시 적용하면 된다.

수정 시점: 2026-09-15 / 환경: macOS (Apple Silicon), Node v26.8.2, Claude Code 2.1.236

---

## 요약

| # | 수정 | 파일 | 이유 |
|---|---|---|---|
| 1 | 키체인 인증 폴백 | `server/modules/providers/list/claude/claude-auth.provider.ts` | macOS에서 로그인돼 있는데 "not authenticated"로 표시됨 |
| 2 | provider 표시 토글 | `src/shared/providerVisibility.ts` (신규) + 사이드바·설정·채팅 | 안 쓰는 CLI 가 목록과 지난 대화에 계속 끼어듦. 설정에서 켜고 끈다 |
| 3 | UI 전체 한국어화 | `src/modules/i18n/**` | 한국어 번역이 36% 비어 있었고 git 패널은 아예 없었음 |
| 4 | 앱 이름 `CloudCLI` → `AI-CLI` | 표시 문자열 여러 곳 + 로케일 | 리브랜딩. 라이선스상 상표 사용권이 없어 오히려 바꾸는 쪽이 맞다 |
| 5 | Claude 앱 스타일 테마 | `tailwind.config.js`, `src/index.css`, `index.html` | 색·폰트를 Claude 데스크톱 앱 톤으로 |
| 6 | 사이드바 저장소 배지 | `src/modules/sidebar/**`, `src/modules/onboarding/**` | upstream star 배지를 내 저장소로 교체 |
| 7 | 하단 링크 2개 삭제 | `SidebarFooter.tsx`, `SidebarCollapsed.tsx` | "문제 신고"·"커뮤니티 참여"가 upstream 으로 감 |
| 8 | 배포 준비 | `install.sh`(신규), `README.md`, `docs/` | 다른 사람이 clone 해서 쓸 수 있도록 |
| 9 | CLI 로그인 방식 교체 | `src/modules/provider-auth/ProviderLoginModal.tsx` | 로그인만 하려는데 폴더 신뢰 프롬프트가 뜨고 위험한 플래그가 붙어 있었다 |
| 10 | 프로젝트 행에 마지막 대화 시각 | `sessions.db.ts`, 사이드바 | 잘린 경로는 쓸모없고, 언제 마지막으로 대화했는지가 궁금하다 |
| 11 | 모델 선택 아코디언 | `ModelGroupList.tsx` | 다른 AI 를 보려면 한참 스크롤해야 했다 |
| 12 | 글꼴을 설정에서 선택 | `fontSettings.ts`(신규), `AppearanceSettingsTab` | 제목 세리프를 내가 정할 게 아니었다 |
| 13 | 모바일 홈 화면 이름 | `public/manifest.json`, `index.html` | 홈 화면에 추가하면 CloudCLI 로 떴다 |
| 14 | https 옵션 | `https-config.ts`(신규), `generate-cert.sh`(신규) | 폰에서 평문으로 붙으면 토큰이 노출된다 |
| 15 | 커밋 이름과 github 계정 분리 | `githubAccount.ts`(신규) | 배지 때문에 커밋 이름을 계정명으로 바꿔야 했다 |
| 16 | `CLAUDE_CONFIG_DIR` 지원 | `server/shared/utils.ts` + Claude provider 전반 | 환경변수로 Claude 설정 폴더를 옮기면 대화가 빈 화면으로 떴다 |

수정 1·2 는 **기존 동작을 없애지 않고 폴백/필터로만 얹었다.** 설정값을 지우면 원래
동작으로 돌아간다.

> **원본 출처와 라이선스 의무는 [`UPSTREAM.md`](./UPSTREAM.md) 에 따로 정리했다.**
> upstream 원격(`origin`)은 제거했고, 기준 커밋은 `5e73a49b` (2026-09-08, v1.37.3) 이다.

---

## 수정 1 — macOS 키체인 인증 인식

### 증상

온보딩의 "Connect Your AI Agents" 화면과 설정 > Agents 탭에서 Claude Code가 이렇게 떴다.

```
Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.
```

그런데 터미널에서는 멀쩡히 동작한다.

```
$ claude -p "Reply with exactly: PONG"
PONG        [exit=0]
```

### 원인

`claude-auth.provider.ts` 의 `checkCredentials()` 가 자격증명을 찾는 곳은 세 군데뿐이다.

1. 환경변수 (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`)
2. `~/.claude/settings.json` 의 `env` 블록
3. `~/.claude/.credentials.json` 파일

**macOS에서 Claude Code는 자격증명을 키체인에 넣는다.** 위 세 경로 어디에도 없어서
로그인 상태인데도 미인증으로 판정됐다. 원본 코드에는 `keychain` / `security` 문자열이
하나도 없다.

```
$ ls ~/.claude/.credentials.json
No such file or directory

$ security find-generic-password -s "Claude Code-credentials"
attributes: 0x00000007 <blob>="Claude Code-credentials"     # ← 키체인에 있음
```

### 해결 — 1순위는 CLI 에게 직접 묻기

나중에 **`claude auth status` 라는 전용 명령**이 있다는 걸 알게 되어 이걸 1순위로 넣었다.
CLI 가 자기 자격증명을 어디에 두든 정확한 답을 주고, 이메일과 구독 종류까지 알려준다.
토큰 값은 출력하지 않는다.

```console
$ claude auth status
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "email": "...",
  "subscriptionType": "max"
}
```

`getStatus()` 의 판정 순서는 이렇게 된다.

1. 환경변수 / `settings.json` / `.credentials.json` (원래 로직, 빠름)
2. **`claude auth status`** (`checkCliAuthStatus()`) — 정확하고 이메일까지 얻는다
3. macOS 키체인 항목 존재 확인 (`hasKeychainCredentials()`) — CLI 호출이 실패할 때의 보루

키체인 확인도 그대로 남겨두었다.

```ts
private hasKeychainCredentials(): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }
  try {
    const result = spawn.sync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      { stdio: 'ignore', timeout: 5000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}
```

**의도적으로 `-w` 를 붙이지 않았다.** 이게 이 수정의 핵심이다.

- `-w` 를 붙이면 비밀번호(토큰)가 평문으로 출력된다. 붙이지 않으면 **항목의 존재 여부만**
  확인되고 값은 나오지 않는다. 토큰을 읽을 이유가 없으므로 읽지 않는다.
- 값을 읽으려 하면 macOS가 **키체인 접근 승인 팝업**을 띄운다. 존재 확인만 하면 안 뜬다.

만료 여부는 판정하지 않는다. **토큰 갱신은 CLI가 알아서 하므로**, 항목이 있으면 로그인된
것으로 본다.

### 검증

```bash
node --input-type=module -e "
const m = await import('./dist-server/server/modules/providers/list/claude/claude-auth.provider.js');
console.log(await new m.ClaudeProviderAuth().getStatus());
"
```

```json
{ "installed": true, "provider": "claude", "authenticated": true,
  "email": "macOS Keychain", "method": "keychain" }
```

### upstream이 고쳤는지 확인하는 법

업데이트 후 이 파일에 `keychain` 또는 `security` 문자열이 생겼다면 upstream이 직접
해결한 것이므로, 우리 패치는 버리고 upstream 것을 쓰면 된다.

```bash
grep -n "keychain\|security" server/modules/providers/list/claude/claude-auth.provider.ts
```

---

## 수정 2 — 표시할 CLI provider 를 설정에서 켜고 끄기

### 배경

이 앱은 Claude Code / Cursor CLI / Codex / OpenCode 를 **모두 지원하는 멀티 CLI 도구**다.
안 쓰는 CLI 가 온보딩 화면, 모델 선택 목록, **그리고 사이드바의 지난 대화 목록에까지**
계속 끼어든다.

이 맥에는 Codex CLI 가 설치돼 로그인까지 돼 있어서 앱이 그걸 자동 감지했다.
**앱이 뭔가 가져간 게 아니라 원래 있던 걸 읽은 것이다.**

### 설정으로는 불가능했다

`server/`, `src/`, `docs/`, `.env.example`, README 를 전부 뒤졌지만 provider 를 끄는
환경변수·설정 파일·UI 는 **존재하지 않았다.**

### 1차 시도와 그 한계 (기록용)

처음에는 `.env` 의 `VITE_ENABLED_PROVIDERS` 를 읽는 `src/shared/enabledProviders.ts` 로
만들었다. 그런데 **Vite 는 `import.meta.env` 를 빌드 시점에 코드로 인라인**하므로
값을 바꿀 때마다 `npm run build:client` 를 돌려야 했다. 설정 화면에서 못 바꾼다.

**그래서 런타임 사용자 설정으로 옮겼다.** `enabledProviders.ts` 와
`VITE_ENABLED_PROVIDERS` 는 삭제했다.

### 현재 구조

**신규 파일**

| 파일 | 역할 |
|---|---|
| `src/shared/providerVisibility.ts` | 순수 모듈. `ALL_PROVIDERS`, `readDisabledProviders`, `isProviderEnabled`, `canDisableProvider`, `setProviderEnabled`, `isVisibleProvider`, `hasHiddenProviders` |
| `src/shared/hooks/useEnabledProviders.ts` | `subscribeToUserPreferences` 구독 훅 |
| `src/modules/sidebar/utils/…/getVisibleSessions()` | 세션 목록 필터 (기존 `getAllSessions` 캐시 위에 얹음) |

**"끈 목록"(`disabledProviders`)으로 저장한다.** 켠 목록으로 저장하면 나중에 provider 가
추가됐을 때 기존 사용자의 저장값에 그 이름이 없어 **자동으로 숨겨진다.** 끈 목록이면
기본이 "전부 켬" 이라 그 문제가 없다.

저장 위치는 기존 preference 저장소(`auth.db`). **백엔드는 수정하지 않았다.**

### 꺼진 provider 가 선택돼 있으면

**저장값은 남기되 읽을 때만 가린다.** `readSelectedProvider()` 가 대체값을 돌려주지만
**저장값 자체는 쓰지 않는다.** 읽는 김에 덮어쓰면 잠깐 껐다 켠 뒤 원래 선택이 영영
사라지기 때문이다. 다시 켜면 선택이 그대로 돌아온다(테스트로 고정).

### 어디까지 가려지나

| 화면 | 동작 |
|---|---|
| 채팅 CLI/모델 선택 | 사라짐 |
| 온보딩 provider 카드 | 사라짐 |
| **사이드바 지난 대화 목록** | **사라짐** |
| 대화 검색 (제목·본문) | 사라짐 |
| 커맨드 팔레트(⌘K) | 사라짐 |
| 프로젝트 목록 | **그대로 남김** (아래 참조) |
| 설정 > 에이전트 탭 | **그대로 남김.** 흐리게 + 취소선 처리 |

**프로젝트를 숨기지 않는 이유**: 프로젝트는 provider 산출물이 아니라 작업 폴더다.
지난 대화가 전부 Codex 였다는 이유로 워크스페이스가 사라지면 **거기서 새 Claude 대화를
시작할 방법이 없어진다.** 화면에서 가리는 것과 접근을 끊는 것은 다른 얘기다.

대신 **개수 배지**를 고쳤다. 원래 서버가 준 전체 개수를 쓰는데, 그대로 두면 "12" 를
누르고 펼쳤을 때 빈 화면이 나온다. 거르는 중일 때만 실제로 보이는 개수를 쓴다.

**설정 탭에서 숨기지 않는 이유**: 다시 켜야 하니까. 대신 로고를 흐리게(`grayscale`),
이름에 취소선, 인증 점 대신 `EyeOff` 아이콘으로 구분한다.

### 세션 목록 — 서버 페이지네이션과 클라이언트 필터

두 목록 모두 **서버에서 페이지네이션**된다.

```
GET /api/providers/sessions/recent?limit=40&offset=N
GET /api/projects/:id/sessions?limit=20&offset=N
```

백엔드를 건드리지 않기로 했으므로 클라이언트에서 거르되, **"상태가 아니라 렌더만
거른다"** 로 offset 문제를 피했다. 다음 offset 은 원본 배열 길이에서 계산되는데,
원본 state 를 그대로 두고 **파생 memo 에서만** 거르므로 offset 산술이 흔들리지 않는다.

남는 문제 하나: **한 페이지가 통째로 꺼진 provider 면 화면이 빈 채로 "더 보기" 버튼만
남는다.** Codex 대화가 많은 상태에서 Codex 를 끄면 실제로 생기는 상황이라, 보여줄 행이
하나라도 생길 때까지 다음 페이지를 자동으로 잇는 effect 를 넣었다. 같은 offset 재진입을
ref 로 막아 서버가 빈 페이지를 주더라도 무한 루프가 나지 않는다.

### 전부 끄기 방지

앱이 잠기므로 2중으로 막았다.

1. **UI**: 마지막 하나 남은 provider 의 토글은 `disabled`. 아래에 안내 한 줄.
2. **모델**: `setProviderEnabled()` 가 `canDisableProvider()` 로 검사해 거절. UI 를
   우회해도 안전하다.

읽기 방어책도 넣었다. 저장값이 배열이 아니거나 모르는 이름이 섞이면 걸러내고,
**넷을 전부 끈 값이면 통째로 무시**한다. 손상된 값 하나로 앱이 잠기면 안 된다.

### 빠질 뻔한 함정

**provider 컬럼이 생기기 전의 옛 세션은 `provider` 가 비어 있다.** 이걸 "알 수 없음"
으로 취급해 감췄다면, Claude 만 켜 둔 사용자의 지난 대화가 통째로 사라졌을 것이다.
빈 값은 `claude` 로 정규화한다(테스트로 고정).

### 범위 — 화면에서만 가리는 것이다

**백엔드는 그대로 네 provider 를 전부 지원한다.** 의도적이다.

- `server/modules/providers/provider.registry.ts` — 4개 등록, 그대로
- `server/modules/providers/provider.routes.ts` 의 `parseProvider()` — 4개 화이트리스트, 그대로

API 를 직접 호출하면 꺼진 provider 도 동작한다. 나중에 다른 AI 를 쓰고 싶으면
**설정에서 토글만 켜면 된다.**

---

## 수정 3 — UI 전체 한국어화

### 상태

한국어 로케일이 이미 있었지만 **1,616개 키 중 585개(36%)가 비어 있었다.** 특히:

- `git.json` 은 **파일 자체가 없었다**(188키). `config.ts` 에서도 `git` 네임스페이스가
  영어에만 등록돼 있어서, 어떤 언어를 골라도 소스 관리 패널은 영어로 나왔다.
- `auth.json` 은 33% 만 번역돼 있었다. 온보딩의 "Connect Your AI Agents" 화면이 여기다.

### 한 일

- 누락된 585키를 전부 번역해 채웠다. **기존 번역 1,031개는 그대로 보존**했다.
- `ko/git.json` 을 새로 만들고 `config.ts` 에 `koGit` 을 import·등록했다.
- 기본 언어를 `'en'` → `'ko'` 로 바꿨다 (`getSavedLanguage()` 의 폴백).
  사용자가 **설정 > Appearance** 에서 고른 값(`userLanguage`)이 이 기본값보다 우선한다.

번역 말투는 기존 번역을 따랐다: 존댓말, 버튼·라벨은 명사형("저장", "취소"),
제품명·도구 식별자(`Claude Code`, `MCP`, `Read`, `Bash`, `Shell`)는 영문 유지.

### 다른 언어

`ja`, `de`, `zh-CN` 등 나머지 10개 언어에는 여전히 `git` 네임스페이스가 없다.
i18next 폴백으로 영어가 나오므로 화면이 깨지지는 않는다. 손대지 않았다.

---

## 수정 4 — 앱 이름 `CloudCLI` → `AI-CLI`

### 라이선스상 문제없다 — 오히려 권장된다

`LICENSE` 의 AGPL 7조 추가 조항이 이렇게 요구한다.

- **7(e) No Trademark Rights** — "CloudCLI", "CloudCLI UI", "Siteboon" 상표 사용권은 주지 않는다
- **7(c) Prohibition of Misrepresentation** — 수정판은 **반드시 수정됐다고 명시**해야 하고
  원본인 것처럼 배포해선 안 된다

즉 이름을 그대로 두고 배포하는 쪽이 위반이다. 바꾸는 것이 맞다.

### 바꾼 것 / 남긴 것

**바꿨다** — 이 앱 자신을 가리키는 표시 문자열:

| 위치 | 내용 |
|---|---|
| `src/shared/utils.ts` | `DEFAULT_PAGE_TITLE` (브라우저 탭 제목) |
| `src/modules/chat/utils/pageTitleNotification.ts` | 탭 제목 알림 fallback |
| `src/modules/auth/AuthLoadingScreen.tsx`, `AuthScreenLayout.tsx` | 로고 alt, 화면 텍스트 |
| `src/modules/settings/tabs/AboutTab.tsx` | 워드마크 |
| `src/modules/mcp/McpServers.tsx`, `chat/modals/ModelLibraryPanel.tsx` | i18n defaultValue |
| `src/modules/sidebar/SidebarFooter.tsx` | 하단 브랜드 줄 (링크도 제거) |
| 로케일 11개 언어 | `auth:login.description`, `login.footerText`, `misc.openSource`, `common:mainContent.loading`, `settings:mcpServers.managed.hint`, `sidebar:app.title` — 41건 |

**남겼다** — 바꾸면 안 되는 것:

- **저작권·출처 고지** — AGPL 7(b) 가 유지를 **의무**로 요구한다.
  `AboutTab.tsx` 에는 "이 소프트웨어는 CloudCLI UI(...)를 기반으로 수정한 버전입니다"
  문구를 **새로 추가**했다.
- **기술 식별자** — `@cloudcli-ai/cloudcli` 패키지명, `cloudcli-claude-watch` 같은 MCP
  서버 id, `CLOUDCLI_WORDMARK_FONT_FAMILY` 상수명. 바꾸면 기존 데이터를 못 읽는다.
- **원저작자 회사의 제품·서비스명** — `CloudCLI Pro`, `CloudCLI Hosted`, `cloudcli.ai`
  URL. 실제로 그 회사 서비스다.
- **서드파티 플러그인명** — `PRISM CloudCLI`.
- **개발자용 JSDoc 주석** — 화면에 안 보인다. 굳이 건드릴 이유가 없다.

---

## 수정 5 — Claude 앱 스타일 테마

### 구조

이 저장소는 **shadcn/ui 스타일 CSS 변수**로 테마를 관리한다. `src/index.css` 의
`:root` / `.dark` 블록에 HSL 삼중값으로 토큰이 있고 `tailwind.config.js` 가
`hsl(var(--token))` 으로 매핑한다. 다크 모드는 `darkMode: ["class"]` 방식
(`src/shared/context/ThemeContext.tsx` 가 `.dark` 클래스를 토글).

**토큰 값만 바꿨다. 이름은 하나도 바꾸지 않았고 컴포넌트는 전혀 건드리지 않았다.**

### 주요 토큰

| 토큰 | 라이트 | 다크 |
|---|---|---|
| `--background` | `#F5F3EE` 크림 | `#1F1E1D` |
| `--card` / `--popover` | `#FEFDFB` | `#262624` |
| `--foreground` | `#1F1E1C` | `#F5F4EE` |
| `--muted-foreground` | `#6B6862` | `#A3A096` |
| `--primary` / `--ring` | **`#C96442`** (파랑→주황) | **`#D97757`** |
| `--border` / `--input` | `#E8E4DC` | `#3A3833` |

### 타이포그래피

`@layer base` 에 `h1, h2, h3 { @apply font-serif; }` 를 추가했다. base 레이어라
우선순위가 가장 낮아 컴포넌트 클래스를 덮어쓰지 않으면서 제목 87곳이 세리프가 된다.

- serif: `'Source Serif 4', 'Noto Serif KR', Georgia, Cambria, 'Times New Roman', serif`
- sans: `Inter, Pretendard, -apple-system, ..., 'Apple SD Gothic Neo', 'Malgun Gothic', ...`

Google Fonts CDN 을 쓰지만(원래부터 쓰고 있었다) 시스템 폰트 폴백이 충분해서
오프라인·폐쇄망에서는 조용히 시스템 폰트로 degrade 될 뿐 깨지지 않는다.

채팅 본문도 `font-serif` 를 쓰므로 Merriweather → Source Serif 4 로 바뀐다. 의도한 것이다.

### 알려진 대비 이슈

라이트 모드의 `--primary` (`#C96442`) 는 **작은 글자에 쓰이면 3.5:1** 로 WCAG AA(4.5:1)에
못 미친다. UI 컴포넌트·큰 글자 기준(3:1)은 통과하고, 주황을 본문 글자색으로 쓰는 곳이
거의 없어 브랜드 색을 그대로 유지했다.

AA 가 필요하면 명도만 낮추면 된다:

```css
--primary: 15 56% 45%;   /* #B35332 — 크림 위 4.5:1, 흰 글자 5.0:1 */
```

나머지는 전부 AA 통과다. 라이트 본문 15.0:1, 다크 본문 14.8:1, 보조 텍스트 5.0~6.4:1.

---

## 수정 6 — 사이드바 git 신원 배지

### 바뀐 것

upstream 의 **"GitHub / Star / 13.7k" 배지**를 지우고, 그 자리에 **설정 > Git 에 저장된
사용자 이름**을 표시한다. 누르면 그 사람의 GitHub 프로필이 새 탭에서 열린다.

- 삭제: `GitHubStarBadge.tsx`, `hooks/useGitHubStars.ts` (GitHub API 로 star 수를 가져오던 훅)
- 신규: `sidebar/GitIdentityBadge.tsx`, `sidebar/hooks/useGitIdentity.ts`

### 값의 출처

설정 화면과 **같은 곳을 읽는다** — `GET /api/user/git-config`. 온보딩 첫 단계에서
입력하고 **설정 > Git** 에서 고치는 그 값이다. 배지는 읽기만 한다.

별도 저장소를 새로 만들지 않은 것이 요점이다. 처음에는 "저장소 URL" 이라는 필드를
온보딩에 새로 추가했지만, 이미 있는 git 설정을 쓰는 것이 맞아서 **그 구조는 전부
걷어냈다**(`src/shared/userRepository.ts`, `useUserRepository.ts`,
`UserRepositoryBadge.tsx` 삭제, `userSettings.ts` 의 `userRepositoryUrl` 키 제거).

### 링크를 거는 조건

설정의 "Git 이름" 은 커밋에 찍히는 표시 이름이라 `홍길동` 같은 아무 문자열이나
들어갈 수 있다. 그래서 **GitHub 사용자명 규칙에 맞을 때만** 링크를 건다.

```
/^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$/
```

영숫자와 하이픈만, 하이픈으로 시작·끝날 수 없고 연속 하이픈도 안 되며 39자 이하.
맞지 않으면 이름만 보여주고 링크는 걸지 않는다. 없는 주소로 보내는 것보다 낫다.

git 이름을 아직 설정하지 않았으면 배지를 **아예 그리지 않는다.** 로고 바로 아래에
설정 안내가 상주하면 거슬리기 때문이다.

### 설정에서 바꾸면 즉시 반영

`useGitSettings.ts` 의 저장이 성공하면 `git-config:updated` 이벤트를 쏘고, 배지가
그걸 듣고 다시 읽는다. 설정 모달을 닫지 않아도 배지가 따라 바뀐다.

---

## 수정 7 — 하단 링크 2개 삭제

`SidebarFooter.tsx` 와 `SidebarCollapsed.tsx` 에서 제거했다.

- **"문제 신고"** → `https://github.com/siteboon/claudecodeui/issues/new`
- **"커뮤니티 참여"** → `https://discord.gg/buxwujPNRE`

둘 다 upstream 프로젝트로 가는 링크라 이 설치본에는 맞지 않는다. 데스크톱·모바일·접힌
사이드바 세 군데에 다 있었다. 함께 쓰이지 않게 된 상수와 `DiscordIcon` 컴포넌트,
`Bug` import 도 정리했다. **"설정" 항목은 남겼다.**

로케일의 `actions.reportIssue` / `actions.joinCommunity` / `actions.starOnGithub` 키는
11개 언어에 모두 있어서 **지우지 않고 그대로 뒀다.** 쓰이지 않을 뿐 해가 없고,
일부 언어만 지우면 오히려 불일치가 생긴다.

---

## 배포 준비

### `install.sh`

받는 사람이 `git clone` 후 한 번 실행하면 되도록 만들었다.

Node v22+ 확인 → `claude` CLI 존재 확인(없으면 경고) → C 컴파일러 확인 →
`npm install` → **네이티브 모듈 install script 승인** → 모듈 로드 검증 →
`.env` 생성(`HOST=127.0.0.1` 로 잠금) → 빌드 → 실행 안내.

아래 "설치 과정에서 겪은 문제" 를 스크립트가 알아서 처리한다.

### `README.md` 교체

원본 README 는 upstream 홍보물이라 우리 것으로 갈아끼웠다.
**원본은 [`docs/upstream/README.original.md`](../upstream/README.original.md) 에 보존했다.**

새 README 에는 AGPL 이 요구하는 출처 고지를 눈에 띄게 넣었다.

### upstream 원격 제거

```bash
git remote remove origin
```

기준 커밋과 다시 붙이는 방법은 [`UPSTREAM.md`](./UPSTREAM.md) 에 있다.

---

## 수정 9 — CLI 로그인 방식 교체

### 증상

설정에서 "재로그인" 을 누르면 터미널 창이 열리면서 **폴더 신뢰 확인 프롬프트**가 먼저 떴다.

```
Quick safety check: Is this a project you created or one you trust?
  1. Yes, I trust this folder
> 2. No, exit
```

로그인만 하려는데 작업 폴더를 신뢰하겠냐고 묻는 것이라 맥락이 맞지 않는다.

### 원인

`ProviderLoginModal.tsx` 가 실행하던 명령:

```
claude --dangerously-skip-permissions /login
```

**대화형 세션을 통째로 띄우고 슬래시 명령을 치는 방식**이었다. 세션을 시작하니
폴더 신뢰 확인이 뜨는 것이 당연하고, 게다가 권한 검사를 전부 끄는
`--dangerously-skip-permissions` 까지 붙어 있었다.

### 해결

```
claude auth login
```

**인증 전용 서브커맨드**다. 세션을 시작하지 않으므로 폴더 신뢰 프롬프트가 뜨지 않고,
위험한 플래그도 필요 없다. 화면도 훨씬 짧고 깔끔해진다.

`claude auth` 에는 `login` / `logout` / `status` 가 있다. `status` 는 수정 1 에서
인증 상태 판정에 쓰고 있다.

---

## 수정 10~15 — 쓰면서 드러난 것들

앱을 실제로 써 보면서 나온 요청들이다. 각각의 자세한 근거는 커밋 메시지에 있다.

### 10. 프로젝트 행에 마지막 대화 시각

잘린 경로(`...1105c/scratchpad/work6`)를 빼고 `4 · 2hr` 로 바꿨다. 전체 경로는 툴팁에 남는다.

**데이터 출처가 문제였다.** 프로젝트 목록은 세션을 **첫 페이지(20개)만** 싣고 오는데,
그게 전부 꺼 둔 provider 의 세션이면 화면에 보이는 세션이 0개라 시각을 구할 수 없다.
실제 대화는 21번째부터 있는데도 빈 값이 나온다. 그래서 백엔드에 집계를 넣었다.

```sql
SELECT project_path, provider, MAX(datetime(COALESCE(updated_at, created_at)))
FROM sessions WHERE project_path IS NOT NULL AND isArchived = 0
GROUP BY project_path, provider
```

프로젝트마다 스캔하지 않고 목록 전체에 질의 한 번이다. **provider 별로 쪼갠 이유**는
꺼 둔 CLI 의 시각이 새어 나가지 않게 클라이언트가 걸러내야 하기 때문이다.

화면에서는 이 집계와 지금 들고 있는 세션 목록의 최댓값을 **합친다.** 집계만 쓰면 방금
주고받은 대화가 다음 목록 요청까지 반영되지 않고, 세션만 쓰면 위의 페이지네이션 구멍이 생긴다.

### 11. 모델 선택 아코디언

**한 번에 하나만 열린다.** 단순 접기로 하면 여러 개를 동시에 펼칠 수 있어 "한참 스크롤"
문제가 되돌아온다. 처음 열 때는 지금 쓰는 provider 가 펼쳐져 있다.

- **검색하면 접힌 그룹도 강제로 펼친다.** 안 그러면 검색이 무용지물이다.
- 검색 중에는 개수를 감춘다. 표시할 수 있는 숫자는 전체 개수뿐인데 아래 걸린 줄 수와 어긋난다.
- CLI 를 하나만 켜 뒀으면 접는 줄을 아예 만들지 않는다.

원래 코드에 `"N hidden — click to show"` 라는 하드코딩 영문 더미 줄이 있었다. cmdk 가 빈
heading 을 감추는 것을 우회하려던 것인데, 접는 줄을 목록 항목으로 바꾸면서 없어졌다.

### 12. 글꼴을 설정에서 선택

테마를 바꾸며 제목에 세리프를 박아 뒀는데 **그건 내가 정할 게 아니었다.**

CSS 변수 세 개(`--app-font-sans`, `--app-font-heading`, `--app-font-scale`)로 빼고
**설정 > 외관 > 글꼴**에서 고르게 했다. 제목 기본값은 "본문과 동일" 이다.

- 하드코딩 `font-serif` 는 전수 조사해 0건으로 만들었다. 단 **코드블록·터미널의 고정폭
  60여 곳은 일부러 남겼다** — 본문 글꼴을 따라가면 코드가 안 읽힌다.
- `index.html` 의 정적 폰트 link 를 걷어내고 런타임 주입으로 바꿨다. 정적 링크가 남아
  있으면 "시스템 기본" 을 고른 사용자도 쓰지 않는 웹폰트를 계속 받는다.
- `html` 의 `font-size` 를 배율로 잡아 **rem 기반 여백까지** 같이 커진다.
- **모든 글꼴 스택에 한글 폴백이 있는지 테스트로 강제**했다.

### 13. 모바일 홈 화면 이름

홈 화면에 추가하면 `CloudCLI UI` 로 저장됐다. 리브랜딩에서 `manifest.json` 과
`index.html` 의 `apple-mobile-web-app-title` 을 빠뜨렸다. 스플래시 색도 흰색이라
테마와 어긋나 있었다.

### 14. https 옵션

기본값은 http 그대로이고 `HTTPS_ENABLED=true` 로 켜는 옵트인이다.

**판단이 한 번 뒤집혔다.** 처음에는 "자체 서명이면 service worker 가 막혀 푸시 알림과
PWA 설치를 잃는다" 고 봤는데, 조사해 보니 **`http://192.168.x.x` 는 애초에 secure
context 가 아니라 폰에서는 지금도 service worker 가 안 돈다.** 즉 자체 서명으로 바꿔도
잃는 것이 없고 TLS 만 얻는다.

`mkcert` 로 CA 를 폰에 한 번 설치하면 경고가 사라지고 **오히려 지금 안 되던 푸시 알림과
PWA 설치가 살아난다.**

- 맥에서만 쓴다면 켤 이유가 없다. `http://localhost` 는 이미 secure context 다.
- 인증서 유효기간은 **397일**이다. Apple 은 398일을 넘는 인증서를 iOS·Safari 에서
  거부하므로, 10년짜리로 만들면 "맥에서는 되는데 폰에서만 안 되는" 상황이 된다.
- SAN 에 IP 는 `IP.n`, 호스트명은 `DNS.n` 으로 넣어야 한다. IP 를 DNS 항목에 넣으면
  브라우저가 무시한다.
- 인증서를 못 읽으면 **http 로 폴백하지 않고 종료한다.** 암호화됐다고 믿는 채 평문으로
  도는 것이 가장 나쁜 실패다.

WebSocket 은 프런트 수정이 필요 없었다. 이미 `window.location.protocol` 로 ws/wss 를
파생하고 있다.

### 15. 커밋 이름과 GitHub 계정 분리

사이드바 배지를 만들며 "Git 이름" 을 그대로 GitHub 계정으로 썼는데 **틀린 가정이었다.**
`user.name` 은 커밋에 찍히는 작성자 이름이라 실명이나 회사 표기를 쓰는 경우가 많다.
배지 하나 때문에 커밋 작성자 이름까지 계정명으로 바꿔야 하는 상황이 됐다.

설정 > Git 에 **"GitHub 사용자명"** 을 선택 입력으로 추가했다. 커밋 정보와 달리 표시용
이므로 git config 가 아니라 앱 preference 에 저장한다. 비워 두면 예전처럼 커밋 이름이
GitHub 계정 형식일 때만 그걸 쓴다(하위호환).

> 이때 `saveGitConfig` 의 `useCallback` 의존성에 `githubUsername` 을 빠뜨려서 stale
> closure 로 **첫 렌더의 빈 값이 저장되는** 버그가 있었다. lint 도 테스트도 잡지 못하는
> 종류라 직접 확인해야 했다.

---

## 수정 16 — `CLAUDE_CONFIG_DIR` 지원

### 증상

UI 에서 Claude 세션을 열면 메시지가 하나도 안 뜨고 "대화 계속하기" 플레이스홀더와
`0 / 160K 토큰` 만 보였다. 대화는 정상적으로 진행됐고 transcript 파일도 디스크에
멀쩡히 있었다.

### 원인

Claude Code 는 `CLAUDE_CONFIG_DIR` 이 설정되면 `~/.claude` 대신 그 경로를 통째로
쓴다. 그런데 코드 전체에 이 환경변수 참조가 **0건**이었고, 대신
`path.join(os.homedir(), '.claude')` 가 10곳에 하드코딩돼 있었다.

그래서 세션 동기화가 `~/.claude/projects` 만 훑고 실제 파일이 있는
`$CLAUDE_CONFIG_DIR/projects` 는 보지 못했다. `sessions` 테이블의 `jsonl_path` 가
NULL 로 남고, 조회 단계에서 `if (!jsonlPath) return []` 에 걸려 빈 배열이 돌아갔다.
`provider_session_id` 는 정확히 캡처돼 있었다 — 런타임은 멀쩡했고 **경로 해석만**
실패한 것이다.

Codex 세션이 멀쩡했던 이유는 `~/.codex/sessions` 가 하드코딩 경로와 일치하기 때문이다.

### 병합하지 않고 단일 루트로 갔다

두 루트(`~/.claude` 와 `$CLAUDE_CONFIG_DIR`)를 모두 스캔해 합치는 선택지가 있었지만
**버렸다.** `claude-runtime.provider.js` 가 SDK 서브프로세스에
`env: { ...process.env }` 를 그대로 넘기므로, 실제로 대화를 실행하는 CLI 는
`CLAUDE_CONFIG_DIR` 한 곳만 본다. 다른 루트의 세션을 목록에 띄워봐야 눌렀을 때
CLI 가 그 id 를 찾지 못한다 — **열 수 없는 대화로 목록만 채우는 셈**이다.

원칙은 하나다: **UI 가 보여주는 범위 = CLI 가 실제로 쓰는 범위.**

### 해결

`server/shared/utils.ts` 에 헬퍼 2개를 두고 모든 경로를 경유시켰다.

```ts
getClaudeHomeDirectory(homeDirectory?)  // CLAUDE_CONFIG_DIR ?? <home>/.claude
getClaudeConfigFilePath(homeDirectory?) // .claude.json 전용
```

`.claude.json` 에 별도 헬퍼가 필요한 이유: 이 파일은 기본값일 때 `.claude` **안이
아니라 옆에** 있다(`~/.claude.json`). `CLAUDE_CONFIG_DIR` 이 설정됐을 때만 안으로
들어간다. 그냥 join 하면 기본 환경에서 회귀가 난다.

환경변수는 **호출할 때마다** 읽는다. 모듈 평가 시점에 잡아두면 값이 얼어붙어서
테스트에서 교체할 수 없다. 같은 이유로 `ClaudeSessionSynchronizer.claudeHome` 은
필드에서 getter 로, `PROVIDER_WATCH_PATHS` 는 상수에서 함수로 바꿨다.

### 빠질 뻔한 함정 3가지

**1. 경로만 고치면 기존 대화는 여전히 빈 화면이다.**
`findFilesRecursivelyCreatedAfter` 는 `birthtime > last_scanned_at` 인 파일만 담는다.
새 루트의 transcript 들은 이미 저장된 스캔 커서보다 오래됐으므로 증분 스캔이 그냥
건너뛴다. 그래서 `app_config` 의 `claude_home_directory` 에 루트를 기록해두고,
값이 달라지면 커서를 무시하고 **1회 전체 재스캔**을 돌린다. 스키마 변경은 없다.

**2. 옛 루트의 세션 행이 저절로 사라지지 않는다.**
기존 orphan 정리는 "파일이 사라진 행"만 지우는데, 옛 `~/.claude` 의 파일들은 멀쩡히
존재한다. 그래서 정리 규칙에 "활성 루트 밖의 Claude 행은 삭제"를 추가했다.
**DB 행만 지운다. transcript 파일은 건드리지 않으므로** 환경변수를 되돌리면 다시
잡힌다. 루트가 존재하지 않을 때는(오타·미마운트) 이 규칙을 적용하지 않는다 —
기존의 "디렉터리가 있을 때만 삭제" 가드와 같은 이유다.

**3. 테스트가 개발자의 진짜 설정 폴더를 긁는다.**
테스트들은 import 전에 `HOME` 을 fixture 로 바꿔 격리하는데, `CLAUDE_CONFIG_DIR` 은
셸 환경변수라 그걸 뚫고 살아남는다. 영향받는 테스트 5개에서 이 변수를 지웠다.

### 고친 파일

세션 표시에 직접 영향:
- `claude-session-synchronizer.provider.ts`, `sessions-watcher.service.ts`
- `provider-token-usage.service.ts`, `session-synchronizer.service.ts`
- `sessions.db.ts` (정리 규칙이 provider 를 알아야 해서 조회에 컬럼 추가)

같은 원인으로 설정·인증·스킬도 못 읽던 곳:
- `claude-auth.provider.ts`, `claude-skills.provider.ts`, `claude-mcp.provider.ts`
- `claude-runtime.provider.js` (MCP 설정 로드 — 원래 보고에 없던 곳)
- `taskmaster.service.ts`, `agent.routes.ts`, `cli.service.ts`

`<workspace>/.claude/skills` 처럼 **프로젝트 로컬** 경로는 그대로 뒀다. 이건
설정 폴더가 아니라 작업 폴더 기준이라 환경변수와 무관하다.

### 검증

환경변수가 없으면 기존 동작(`~/.claude` 단독)과 완전히 동일하다. 테스트로 못 박았다.

실제 환경(`CLAUDE_CONFIG_DIR=/Users/linalee/.claude-work`)에서:

```
processedByProvider: { claude: 3, codex: 54, cursor: 0, opencode: 0 }
prunedOrphans: 11
failures: []
```

NULL 이던 `jsonl_path` 가 모두 채워졌고, 옛 루트 행 11개가 정리됐으며, Codex 54개는
그대로다. watcher 도 새 루트의 쓰기를 즉시 잡는다.

---

## 설치 과정에서 겪은 문제

### npm 11.19+ 가 네이티브 모듈 빌드를 차단한다

`npm install` 후 이런 경고가 나온다.

```
npm warn install-scripts 11 packages have install scripts not yet covered by allowScripts:
  bcrypt, better-sqlite3, node-pty, esbuild, sharp, @vscode/ripgrep, fsevents, ...
```

보안상 install script가 기본 차단된 것이다. **그냥 두면 앱이 깨진다.** 특히
`node-pty` 에 darwin-arm64 바이너리가 안 만들어져서 터미널 기능이 죽는다.

```bash
for p in @vscode/ripgrep bcrypt better-sqlite3 esbuild fsevents node-pty sharp unrs-resolver; do
  npm install-scripts approve "$p"
done
```

`electron`, `electron-winstaller` 는 데스크톱 빌드용이라 승인하지 않았다. 웹으로만 쓸
거라면 필요 없다. `npm run desktop` 을 쓰고 싶으면 그때 승인하면 된다.

네이티브 모듈이 제대로 빌드됐는지 확인:

```bash
node -e "
const t=(n,f)=>{try{f();console.log('OK  ',n)}catch(e){console.log('FAIL',n,e.message.split('\n')[0])}};
t('node-pty',()=>require('node-pty'));
t('better-sqlite3',()=>require('better-sqlite3'));
t('bcrypt',()=>require('bcrypt'));
t('sharp',()=>require('sharp'));
"
```

`npm install` 을 다시 하면 이 승인이 초기화될 수 있다. 그러면 위 루프를 다시 돌린다.

### Node 버전 — 테스트가 전부 깨진다

프로젝트 `.nvmrc` 는 `v22` 인데 `v26.8.2` 로 설치했다. 앱 빌드와 실행은 문제없지만
**테스트 스위트가 396개 중 142개 깨졌다.**

원인:

```
ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
```

**Node 26 부터 런타임에 전역 `localStorage` 가 생겼다.** 그런데 `--localstorage-file`
플래그 없이 실행하면 그 전역이 `undefined` 인 채로 자리만 차지한다. 그 바람에 jsdom 이
만들어주는 localStorage 가 가려져서, 저장소를 쓰는 테스트가 한꺼번에 무너진다.
`window.localStorage` 까지 같이 `undefined` 가 된다.

jsdom 자체는 멀쩡하다. 직접 띄워보면 localStorage 를 정상적으로 준다:

```bash
node -e "const {JSDOM}=require('jsdom'); const d=new JSDOM('',{url:'http://localhost'});
         console.log(typeof d.window.localStorage)"   # → object
```

**해결**: `vitest.setup.ts` 에 전역이 없을 때만 동작하는 localStorage/sessionStorage
폴리필을 넣었다. Node 22 에서는 전역이 이미 정상이므로 이 폴리필은 건너뛴다.

Node 22 로 내려서 쓴다면 이 폴리필은 필요 없지만, 있어도 해가 없다.

### 테스트가 `.env` 에 휘둘리는 문제

`vitest.config.ts` 에는 원래 이런 주석과 함께 `VITE_IS_PLATFORM` 을 고정하는 코드가 있다.

> *Pinned so the suite does not silently change shape with a developer's local `.env`*

우리가 `.env` 에 `VITE_ENABLED_PROVIDERS=claude` 를 넣으면서 정확히 그 상황이 생겼다.
`selectedProvider.ts` 가 저장된 값을 `ENABLED_PROVIDERS` 로 검증하는데, claude 만
켜져 있으니 테스트가 `cursor` 를 저장해도 `claude` 로 되돌아와 9건이 실패했다.

같은 선례를 따라 `vitest.config.ts` 의 `env` 에 네 provider 를 모두 켠 값을 고정했다.
테스트는 필터가 없는 기본 동작을 검증해야 하기 때문이다.

### 검증 결과

Node v26.8.2 기준, 위 두 수정을 적용한 상태:

| 항목 | 결과 |
|---|---|
| 프런트 테스트 (`npx vitest run`) | **396 / 396 통과** (56 파일) |
| 백엔드 테스트 (`npm test`) | **415 통과, 0 실패** (1 skipped) |
| 타입체크 (프런트/백엔드) | 에러 없음 |
| `npx oxlint src/` | **에러 0건** (warning 은 기존 코드의 것) |
| `npm run build` | 성공 |

---

## 수정 파일 전체 목록

```
신규  src/shared/enabledProviders.ts
신규  docs/local/*                                       (이 문서들)
수정  server/modules/providers/list/claude/claude-auth.provider.ts
수정  server/shared/utils.ts                             (CLAUDE_CONFIG_DIR 헬퍼)
수정  server/modules/providers/** , taskmaster, agent, cli  (수정 16 — 목록은 해당 절)
신규  server/modules/providers/tests/claude-config-dir.test.ts
수정  src/modules/onboarding/AgentConnectionsStep.tsx
수정  src/modules/chat/transcript/ProviderSelectionEmptyState.tsx
수정  src/modules/chat/hooks/useChatProviderState.ts
수정  src/shared/selectedProvider.ts
수정  src/modules/settings/tabs/agents-settings/AgentsSettingsTab.tsx
수정  .env.example                                       (VITE_ENABLED_PROVIDERS 주석)
생성  .env                                               (git 추적 안 됨)
```

`package.json` / `package-lock.json` 변경은 `npm install-scripts approve` 가 남긴
것이라 우리가 의도한 수정이 아니다.

현재 상태 확인:

```bash
git status --short
git diff --stat
```

---

## 코드 스타일 참고

이 저장소 루트의 `AGENTS.md` 는 `server/` 와 `src/` 에 각각 별도 아키텍처 표준을
따르라고 지시한다.

- 백엔드: `.agents/skills/backend-module-standards/SKILL.md`
- 프런트: `.agents/skills/frontend-module-standards/SKILL.md`

이 저장소를 더 고칠 일이 있으면 해당 문서를 먼저 읽을 것. 위 수정들은 기존 코드 구조를
그대로 따르는 최소 변경이라 별도로 적용하지 않았다.

주석은 한국어로 달았다(프로젝트 규칙). upstream에 PR을 보낼 생각이라면 영어로 바꿔야 한다.
