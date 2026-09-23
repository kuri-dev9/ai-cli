# 로컬 설치 문서 (한국어)

이 디렉터리는 **이 설치본에만 해당하는** 문서 모음이다. upstream(siteboon/claudecodeui)
저장소에는 없는 파일이고, 우리가 직접 만들었다. upstream을 업데이트해도 여기 내용은
덮어써지지 않는다.

## 이게 뭔가

`/Users/kuri/proj/vscode/ai-cli` 은 **AI-CLI** 다. Claude Code CLI를 브라우저
GUI로 감싸주는 앱으로, 오픈소스 **CloudCLI UI**(구 claudecodeui)를 클론해 수정한 것이다.

- upstream: https://github.com/siteboon/claudecodeui
- 라이선스: AGPL-3.0-or-later
- 클론 시점 버전: `1.37.3`

터미널 대신 브라우저에서 Claude Code를 쓰기 위해 설치했다. VSCode나 터미널 UI는
쓰고 싶지 않다는 요구에서 출발했다.

## 문서 목록

| 문서 | 내용 |
|---|---|
| [`team-setup.md`](./team-setup.md) | **팀원 설치 가이드.** 사전 준비부터 첫 실행까지. 원격 맥(ssh 전용)에 올릴 때 필요한 설정도 여기 있다 |
| [`local-changes.md`](./local-changes.md) | **이 설치본에 가한 수정 전부.** upstream 업데이트 시 재적용 가이드 포함 |
| [`UPSTREAM.md`](./UPSTREAM.md) | **원본 출처, 기준 커밋, 라이선스 의무.** 재배포하기 전에 반드시 읽을 것 |
| [`claude-cli-headless.md`](./claude-cli-headless.md) | Claude Code CLI 헤드리스 프로토콜 스펙. 직접 GUI를 만들거나 이 앱을 깊게 고칠 때의 설계 자료 |
| [`ollama-and-multi-llm.md`](./ollama-and-multi-llm.md) | Ollama 로컬 모델 연동, 여러 LLM 을 병렬·직렬로 조합하는 방법. **조사만 했고 아직 적용하지 않았다** |
| [`docker.md`](./docker.md) | Docker 로 실행할 수 있는지 검토한 결과. 실제 컨테이너로 검증했다. **적용하지 않았다** |

원본 README 는 [`../upstream/README.original.md`](../upstream/README.original.md) 에 보존해두었다.

## 빠른 실행

```bash
cd /Users/kuri/proj/vscode/ai-cli
npm run server           # http://localhost:3001
```

개발 모드(핫 리로드, 프런트 5173 + API 3001):

```bash
npm run dev
```

소스를 고친 뒤에는 재빌드가 필요하다.

```bash
npm run build            # 프런트 + 백엔드 전부
npm run build:client     # 프런트만 (.env 의 VITE_* 값을 바꿨을 때)
npm run build:server     # 백엔드만
```

## 접속 범위

`.env` 의 `HOST` 가 **`127.0.0.1`** 로 잠겨 있다. 이 맥에서만 접속된다.

폰이나 태블릿에서 쓰려면 `0.0.0.0` 으로 바꾸고 `맥IP:3001` 로 접속한다. 다만 그러면
**같은 네트워크에 있는 누구나 이 맥에서 Claude Code를 실행할 수 있게 된다.** 파일을
읽고 쓰고 셸 명령까지 돌릴 수 있으므로, 신뢰하는 네트워크에서만 열 것.

## 알아둘 것

- 이 앱은 `~/.claude` 를 **터미널 Claude Code와 그대로 공유한다.** 별도 저장소가 아니다.
  UI에서 MCP 서버나 권한을 바꾸면 `~/.claude` 에 직접 써지고, 터미널 쪽에도 즉시 반영된다.
  세션 목록도 `~/.claude/projects/` 를 그대로 읽는다.
- **도구는 기본적으로 전부 꺼져 있다.** 의도된 안전장치다. 기어 아이콘 → 도구 설정에서
  필요한 것만 켜야 Claude가 파일을 읽고 쓸 수 있다.
- 로그인 계정은 이 맥의 로컬 `auth.db` 에만 저장된다. 외부로 나가지 않는다.
