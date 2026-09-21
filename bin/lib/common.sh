#!/usr/bin/env bash
#
# 운영 스크립트 공통 유틸.
#
#   run.sh 와 bin/watchdog.sh 가 source 해서 쓴다. 단독 실행용이 아니다.
#
# macOS 기본 bash 3.2 에서도 돌아야 하므로 연관배열(declare -A)이나
# ${var^^} 같은 4.x 문법은 쓰지 않는다.

set -uo pipefail

# ---------------------------------------------------------------- 경로
# 이 파일 기준으로 프로젝트 루트를 찾는다. 어디서 실행하든 같은 곳을 가리킨다.
COMMON_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$COMMON_SH_DIR/../.." && pwd)"

LOG_DIR="$PROJECT_ROOT/logs"
# 숨김 폴더인 이유: 예전 이름은 `run` 이었는데, 쉘에서 `run` 까지 치고 탭을
# 누르면 `run.sh` 와 붙어서 매번 한 글자를 더 쳐야 했다. 사람이 부르는 이름은
# `run.sh` 하나여야 한다.
RUN_DIR="$PROJECT_ROOT/.run"

SERVER_LOG="$LOG_DIR/server.log"
WATCHDOG_LOG="$LOG_DIR/watchdog.log"
SERVER_PID_FILE="$RUN_DIR/server.pid"
WATCHDOG_PID_FILE="$RUN_DIR/watchdog.pid"

# ---------------------------------------------------------------- 로그 설정
LOG_MAX_BYTES="${LOG_MAX_BYTES:-10485760}"   # 10 MiB
LOG_KEEP="${LOG_KEEP:-3}"                    # .1 .2 .3 까지 보관

# ---------------------------------------------------------------- 색
if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''; C_OFF=''
fi

info() { printf "%s[INFO]%s %s\n"  "$C_BLUE"   "$C_OFF" "$1"; }
ok()   { printf "%s[OK]%s %s\n"    "$C_GREEN"  "$C_OFF" "$1"; }
warn() { printf "%s[경고]%s %s\n"  "$C_YELLOW" "$C_OFF" "$1"; }
fail() { printf "%s[실패]%s %s\n"  "$C_RED"    "$C_OFF" "$1" >&2; }

ensure_dirs() {
  mkdir -p "$LOG_DIR" "$RUN_DIR"
}

# ---------------------------------------------------------------- .env 읽기
#
# .env 를 source 하지 않는다. 값에 공백이나 따옴표가 있으면 셸이 해석해버리고,
# 악의적이지 않은 오타 하나로도 스크립트가 엉뚱하게 동작할 수 있다.
# 필요한 키만 골라서 문자열로 읽는다.
env_value() {
  local key="$1" default="${2:-}"
  local file="$PROJECT_ROOT/.env"
  [ -f "$file" ] || { printf '%s' "$default"; return; }

  local line
  line="$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -1)"
  [ -n "$line" ] || { printf '%s' "$default"; return; }

  local value="${line#*=}"
  value="${value%%$'\r'}"                       # CRLF 로 저장된 경우
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  value="${value%\"}"; value="${value#\"}"      # 따옴표 벗기기
  value="${value%\'}"; value="${value#\'}"
  [ -n "$value" ] || value="$default"
  printf '%s' "$value"
}

server_port()   { env_value SERVER_PORT 18200; }
server_host()   { env_value HOST 127.0.0.1; }
https_enabled() { [ "$(env_value HTTPS_ENABLED false)" = "true" ]; }

# 헬스체크에 쓸 주소. 0.0.0.0 은 접속 대상 주소가 아니라 "모든 인터페이스" 라는
# 뜻이므로, 확인은 항상 루프백으로 한다.
health_url() {
  local scheme="http"
  https_enabled && scheme="https"
  printf '%s://127.0.0.1:%s/health' "$scheme" "$(server_port)"
}

# ---------------------------------------------------------------- 로그 회전
#
# mv 가 아니라 복사 후 비우기(copytruncate)로 돌린다. 서버가 이미 열어 둔
# 파일을 mv 하면 파일 서술자가 옮겨진 파일을 계속 따라가서, 새 로그가 회전된
# 파일에 쌓이고 현재 로그는 영영 비어 있게 된다.
rotate_log() {
  local file="$1"
  [ -f "$file" ] || return 0

  local size
  size="$(file_size "$file")"
  [ "$size" -ge "$LOG_MAX_BYTES" ] || return 0

  rm -f "$file.$LOG_KEEP"
  local i=$((LOG_KEEP - 1))
  while [ "$i" -ge 1 ]; do
    [ -f "$file.$i" ] && mv -f "$file.$i" "$file.$((i + 1))"
    i=$((i - 1))
  done

  cp "$file" "$file.1" && : > "$file"
}

file_size() {
  # macOS(stat -f) 와 GNU(stat -c) 를 모두 지원한다.
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
}

rotate_all_logs() {
  rotate_log "$SERVER_LOG"
  rotate_log "$WATCHDOG_LOG"
}

log_line() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1"
}

# ---------------------------------------------------------------- 프로세스
read_pid() {
  local file="$1"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null)"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s' "$pid"
}

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# PID 파일이 있어도 그 프로세스가 죽었을 수 있고, 재부팅 후 같은 번호를 다른
# 프로그램이 쓰고 있을 수도 있다. 살아 있는지까지 확인해서 답한다.
process_running() {
  local pid
  pid="$(read_pid "$1")" || return 1
  pid_alive "$pid"
}

stop_pid_file() {
  local file="$1" label="$2" timeout="${3:-15}"
  local pid
  pid="$(read_pid "$file")" || { rm -f "$file"; return 1; }

  if ! pid_alive "$pid"; then
    rm -f "$file"
    return 1
  fi

  kill "$pid" 2>/dev/null
  local waited=0
  while pid_alive "$pid" && [ "$waited" -lt "$timeout" ]; do
    sleep 1
    waited=$((waited + 1))
  done

  if pid_alive "$pid"; then
    warn "$label 가 ${timeout}초 안에 끝나지 않아 강제 종료합니다 (pid $pid)"
    kill -9 "$pid" 2>/dev/null
    sleep 1
  fi

  rm -f "$file"
  return 0
}

# PID 파일이 지워졌거나 어긋나면 stop 으로 영영 못 끄는 프로세스가 남는다.
# 경로까지 일치하는 것만 골라 정리한다. 다른 프로젝트의 같은 이름 스크립트나
# 무관한 node 프로세스를 건드리지 않기 위해 절대경로로 맞춘다.
stop_stray() {
  local pattern="$1" label="$2"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null | tr '\n' ' ')"
  [ -n "$pids" ] || return 1

  local pid killed=0
  for pid in $pids; do
    # 자기 자신과 부모는 건드리지 않는다.
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    kill "$pid" 2>/dev/null && killed=1
  done
  [ "$killed" -eq 1 ] || return 1

  sleep 2
  pids="$(pgrep -f "$pattern" 2>/dev/null | tr '\n' ' ')"
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    kill -9 "$pid" 2>/dev/null
  done
  warn "$label 의 PID 파일이 없어 이름으로 찾아 정리했습니다"
  return 0
}

# ---------------------------------------------------------------- 헬스체크
#
# 포트가 열려 있는지만 보면 부족하다. 프로세스가 살아는 있는데 이벤트 루프가
# 막혀 응답을 못 하는 상태를 못 잡는다. 실제로 /health 가 200 을 주는지 본다.
health_check() {
  local timeout="${1:-5}"
  local args=(-s -o /dev/null -w '%{http_code}' --max-time "$timeout")
  # 자체 서명 인증서를 쓰는 경우가 있으므로 루프백 확인에서는 검증을 건너뛴다.
  https_enabled && args+=(-k)

  local code
  code="$(curl "${args[@]}" "$(health_url)" 2>/dev/null)"
  [ "$code" = "200" ]
}

build_exists() {
  [ -f "$PROJECT_ROOT/dist-server/server/index.js" ] && [ -d "$PROJECT_ROOT/dist" ]
}
