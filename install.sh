#!/usr/bin/env bash
#
# AI-CLI 설치 스크립트
#
#   git clone <저장소> ai-cli && cd ai-cli && ./install.sh
#   ./install.sh --https     # HTTPS 인증서까지 만들고 .env 에 켜 둡니다
#
# 하는 일: Node 확인 → 의존성 설치 → 네이티브 모듈 빌드 승인 → 검증 → .env 생성 → 빌드
#
set -euo pipefail

cd "$(dirname "$0")"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; DIM=$'\033[2m'; NC=$'\033[0m'
info()  { printf "%s[INFO]%s %s\n"  "$BLUE"   "$NC" "$1"; }
ok()    { printf "%s[OK]%s %s\n"    "$GREEN"  "$NC" "$1"; }
warn()  { printf "%s[경고]%s %s\n"  "$YELLOW" "$NC" "$1"; }
fail()  { printf "%s[실패]%s %s\n"  "$RED"    "$NC" "$1" >&2; exit 1; }

MIN_NODE_MAJOR=22

WANT_HTTPS=0
for arg in "$@"; do
  case "$arg" in
    --https) WANT_HTTPS=1 ;;
    -h|--help)
      printf "사용법: ./install.sh [--https]\n\n"
      printf "  --https   로컬 HTTPS 인증서를 만들고 .env 에 HTTPS_ENABLED=true 를 켭니다.\n"
      printf "            폰/태블릿에서 접속할 때 로그인 토큰이 평문으로 흐르지 않게 합니다.\n"
      exit 0 ;;
    *) fail "알 수 없는 옵션: $arg" ;;
  esac
done

printf "\n%s===============================================%s\n" "$DIM" "$NC"
printf "  AI-CLI 설치\n"
printf "%s===============================================%s\n\n" "$DIM" "$NC"

# ---------------------------------------------------------------- 1. 사전 확인
info "필수 도구를 확인합니다"

command -v node >/dev/null 2>&1 || fail "Node.js가 없습니다. https://nodejs.org 에서 v${MIN_NODE_MAJOR} 이상을 설치하세요.
  macOS(Homebrew):  brew install node
  Linux(apt):       curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  fail "Node v${MIN_NODE_MAJOR} 이상이 필요합니다. 현재: $(node -v)"
fi
ok "Node $(node -v)"

command -v npm >/dev/null 2>&1 || fail "npm이 없습니다."
ok "npm v$(npm -v)"

if command -v claude >/dev/null 2>&1; then
  ok "Claude Code CLI 확인: $(claude --version 2>/dev/null | head -1)"
else
  warn "Claude Code CLI(claude)를 PATH에서 찾지 못했습니다."
  warn "이 앱은 claude CLI를 실행해서 동작하므로, 설치 후 'claude' 로그인이 필요합니다."
  warn "  설치: https://code.claude.com/docs"
fi

# 네이티브 모듈(better-sqlite3, node-pty)을 소스에서 빌드해야 할 수 있으므로 컴파일러 확인
if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
  warn "C 컴파일러를 찾지 못했습니다. 네이티브 모듈 빌드가 실패할 수 있습니다."
  case "$(uname -s)" in
    Darwin) warn "  해결: xcode-select --install" ;;
    Linux)  warn "  해결: sudo apt install -y build-essential python3" ;;
  esac
fi

# ---------------------------------------------------------------- 2. 의존성 설치
printf "\n"
info "의존성을 설치합니다 (몇 분 걸릴 수 있습니다)"
npm install --no-fund --no-audit

# ---------------------------------------------------------------- 3. 네이티브 모듈 스크립트 승인
#
# npm 11.19+ 는 보안상 install script 를 기본 차단한다. 그대로 두면 node-pty 에
# 이 플랫폼용 바이너리가 만들어지지 않아 터미널 기능이 죽고, better-sqlite3 가
# 빌드되지 않아 서버가 아예 뜨지 않는다.
printf "\n"
if npm install-scripts ls >/dev/null 2>&1; then
  info "네이티브 모듈 빌드 스크립트를 승인합니다"
  for pkg in @vscode/ripgrep bcrypt better-sqlite3 esbuild fsevents node-pty sharp unrs-resolver; do
    npm install-scripts approve "$pkg" >/dev/null 2>&1 || true
  done
  ok "승인 완료 (electron 계열은 데스크톱 빌드 전용이라 제외했습니다)"
else
  info "이 npm 버전은 install script 승인이 필요 없습니다"
fi

# ---------------------------------------------------------------- 4. 네이티브 모듈 검증
printf "\n"
info "네이티브 모듈을 검증합니다"
node -e '
const mods = ["node-pty", "better-sqlite3", "bcrypt", "sharp"];
let bad = [];
for (const m of mods) {
  try { require(m); console.log("  \x1b[32mOK\x1b[0m   " + m); }
  catch (e) { bad.push(m); console.log("  \x1b[31mFAIL\x1b[0m " + m + " — " + String(e.message).split("\n")[0]); }
}
if (bad.length) {
  console.error("\n네이티브 모듈 " + bad.length + "개가 로드되지 않습니다.");
  console.error("아래를 실행한 뒤 다시 시도하세요:");
  console.error("  npm rebuild " + bad.join(" "));
  process.exit(1);
}
'
ok "네이티브 모듈 정상"

# ---------------------------------------------------------------- 5. .env 생성
printf "\n"
if [ -f .env ]; then
  ok ".env 가 이미 있어 그대로 둡니다"
else
  info ".env 를 생성합니다"
  cp .env.example .env
  # 기본값 0.0.0.0 은 같은 네트워크의 누구나 접속할 수 있다는 뜻이라 localhost 로 잠근다.
  # 외부에서 쓰려면 설치 후 직접 여는 것이 안전하다.
  if grep -q '^HOST=' .env; then
    sed -i.bak 's/^HOST=.*/HOST=127.0.0.1/' .env && rm -f .env.bak
  else
    printf '\nHOST=127.0.0.1\n' >> .env
  fi
  ok ".env 생성 완료 (HOST=127.0.0.1 — 이 컴퓨터에서만 접속)"
fi

PORT="$(grep -E '^SERVER_PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-3001}"

# ------------------------------------------------------- 6. HTTPS (선택 사항)
#
# 기본값은 HTTP 다. 이 맥에서만 쓰면 http://localhost 는 브라우저가 이미 안전한
# 출처로 취급하므로 켤 이유가 없다. --https 는 폰에서 LAN IP 로 붙는 경우를 위한 것.
if [ "$WANT_HTTPS" -eq 1 ]; then
  printf "\n"
  info "HTTPS 인증서를 준비합니다"
  # 이미 인증서가 있으면 스크립트가 그대로 두고 넘어간다. 재설치 때 인증서를
  # 새로 만들어 버리면 폰에 등록해 둔 신뢰 설정이 한 번에 무효가 된다.
  ./scripts/generate-cert.sh

  if grep -q '^HTTPS_ENABLED=' .env; then
    sed -i.bak 's/^HTTPS_ENABLED=.*/HTTPS_ENABLED=true/' .env && rm -f .env.bak
  else
    printf '\nHTTPS_ENABLED=true\n' >> .env
  fi
  ok ".env 에 HTTPS_ENABLED=true 를 설정했습니다"
  SCHEME="https"
else
  SCHEME="http"
fi

# ---------------------------------------------------------------- 7. 빌드
printf "\n"
info "앱을 빌드합니다"
npm run build

# ---------------------------------------------------------------- 완료
printf "\n%s===============================================%s\n" "$DIM" "$NC"
printf "  %s설치가 끝났습니다%s\n" "$GREEN" "$NC"
printf "%s===============================================%s\n\n" "$DIM" "$NC"
printf "실행:\n"
printf "  %snpm run server%s\n\n" "$BLUE" "$NC"
printf "접속:\n"
printf "  %s%s://localhost:%s%s\n\n" "$BLUE" "$SCHEME" "$PORT" "$NC"
printf "%s처음 실행하면:%s\n" "$YELLOW" "$NC"
printf "  1. 로컬 계정을 하나 만듭니다 (이 컴퓨터의 auth.db 에만 저장됩니다)\n"
printf "  2. 설정(⚙) 에서 사용할 도구를 켜세요. 기본값은 전부 꺼짐입니다.\n"
printf "  3. claude 로그인이 안 돼 있으면 터미널에서 'claude' 를 한 번 실행해 로그인하세요.\n\n"
printf "%s다른 기기에서 접속하려면 .env 의 HOST 를 0.0.0.0 으로 바꾸세요.%s\n" "$DIM" "$NC"
printf "%s단, 같은 네트워크의 누구나 이 컴퓨터에서 명령을 실행할 수 있게 됩니다.%s\n\n" "$DIM" "$NC"

if [ "$WANT_HTTPS" -eq 0 ]; then
  printf "%s폰/태블릿에서 쓸 계획이라면 HTTPS 를 고려하세요 (평문이면 로그인 토큰이 노출됩니다):%s\n" "$DIM" "$NC"
  printf "%s  ./scripts/generate-cert.sh  →  .env 에 HTTPS_ENABLED=true%s\n\n" "$DIM" "$NC"
fi
