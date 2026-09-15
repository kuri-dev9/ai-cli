# 원본 소스 정보

이 소프트웨어는 오픈소스 프로젝트를 **수정한 버전**이다. 원본이 아니다.

## 출처

> **CloudCLI UI (https://github.com/siteboon/claudecodeui)**

- 원저작권: Copyright 2025-2026 **Siteboon AI B.V.** and contributors
- 라이선스: **AGPL-3.0-or-later** (Section 7 추가 조항 포함)
- 전문: 저장소 루트의 [`LICENSE`](../../LICENSE), [`NOTICE`](../../NOTICE)
- 원본 README: [`docs/upstream/README.original.md`](../upstream/README.original.md)

이 고지는 AGPL-3.0 Section 7(b) **Attribution Requirement** 에 따라 유지해야 한다.
지우거나 눈에 띄지 않게 숨기면 라이선스 위반이다.

## 기준 시점

이 사본이 갈라져 나온 지점:

| 항목 | 값 |
|---|---|
| base commit | `5e73a49b89b4f13766fc2e22723297a36e7dcef2` |
| 날짜 | 2026-09-08 |
| 커밋 메시지 | `fix: upstream electron build bug` |
| upstream 버전 | `1.37.3` |
| 클론 방식 | `git clone --depth 1` (shallow — 이 커밋 하나만 있음) |

원격(`origin`)은 **제거했다.** 이 저장소는 upstream 을 향해 push/pull 하지 않는다.

## upstream 변경사항을 가져오려면

원격을 다시 붙였다가 떼는 방식으로 한다. `origin` 이 아니라 `upstream` 이라는
별도 이름을 쓰는 것이 안전하다 — 실수로 우리 저장소에 push 하지 않게 된다.

```bash
cd /Users/kuri/proj/vscode/claude_web

git remote add upstream https://github.com/siteboon/claudecodeui.git
git fetch upstream --depth 50

# 우리가 고친 파일들이 그 사이 어떻게 바뀌었는지 먼저 확인
git diff HEAD upstream/main -- \
  server/modules/providers/list/claude/claude-auth.provider.ts \
  src/modules/i18n/config.ts \
  src/modules/sidebar/ src/modules/onboarding/ \
  tailwind.config.js src/index.css

git remote remove upstream   # 확인이 끝나면 다시 떼어낸다
```

무엇을 어떻게 고쳤는지는 [`local-changes.md`](./local-changes.md) 에 전부 적혀 있다.
그 문서에는 항목마다 "upstream 이 이미 고쳤는지 확인하는 법" 도 함께 적어두었다.

## 재배포할 때 지켜야 할 것

AGPL-3.0 과 Section 7 추가 조항이 요구하는 사항이다.

1. **`LICENSE` 와 `NOTICE` 파일을 반드시 포함한다.** 삭제 금지.
2. **위의 출처 고지를 눈에 띄게 유지한다.** README 에도 남겨두었다.
3. **수정판임을 분명히 밝힌다.** 원본인 것처럼 배포하면 안 된다 (Section 7(c)).
4. **소스를 공개한다.** AGPL 은 네트워크 너머로 서비스를 제공하는 경우에도
   이용자에게 수정된 소스를 제공할 의무를 지운다. 사내망이든 인터넷이든
   남이 이 앱을 쓰게 한다면 소스를 받을 수 있게 해야 한다.
5. **"CloudCLI", "CloudCLI UI", "Siteboon" 상표는 쓰지 않는다** (Section 7(e)).
   출처를 밝히는 용도로만 언급할 수 있다. 앱 이름을 `AI-CLI` 로 바꾼 이유가 이것이다.
