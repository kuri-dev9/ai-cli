#!/usr/bin/env bash
#
# AI-CLI 실행기. 평소에는 이것만 쓰면 된다.
#
#   ./run.sh              서버를 켠다 (watchdog 포함)
#   ./run.sh stop         끈다
#   ./run.sh restart      빌드하고 껐다 켠다
#   ./run.sh restart -n   빌드 없이 껐다 켠다
#   ./run.sh build        빌드만 한다
#   ./run.sh status       상태를 본다
#   ./run.sh logs         로그를 따라 본다 (Ctrl+C 로 빠져나옴)
#   ./run.sh logs server  서버 로그만
#   ./run.sh logs watchdog watchdog 로그만
#   ./run.sh foreground   터미널을 잡고 실행 (watchdog 없음, 디버깅용)
#
# 처음 설치는 ./install.sh 를 먼저 한 번 돌린다.

set -uo pipefail

# shellcheck source=bin/lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bin/lib/common.sh"

usage() {
  sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'
}

access_urls() {
  local scheme="http"
  https_enabled && scheme="https"
  local port host
  port="$(server_port)"
  host="$(server_host)"

  printf "  %s%s://localhost:%s%s\n" "$C_BLUE" "$scheme" "$port" "$C_OFF"

  # 0.0.0.0 으로 열었으면 다른 기기에서도 붙을 수 있다. 그 주소를 알려준다.
  if [ "$host" = "0.0.0.0" ]; then
    local ip=''
    for iface in en0 en1 en2; do
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null)" && [ -n "$ip" ] && break
    done
    [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [ -n "$ip" ]; then
      printf "  %s%s://%s:%s%s  %s(같은 네트워크의 다른 기기)%s\n" \
        "$C_BLUE" "$scheme" "$ip" "$port" "$C_OFF" "$C_DIM" "$C_OFF"
    fi
  fi
}

# 빌드 산출물을 다시 만든다.
#
# `restart` 가 이걸 먼저 부르는 이유: run.sh 는 dist-server/ 를 실행하는데,
# 소스를 고치고 재시작만 하면 예전 빌드가 그대로 뜬다. 고친 것이 반영된 줄
# 알고 한참을 헤매게 되는 종류의 함정이라, 기본값을 안전한 쪽에 둔다.
#
# 출력은 파일로 보낸다. 성공하면 볼 일이 없고, 실패했을 때 터미널을 거슬러
# 올라가는 것보다 파일 하나를 보는 편이 낫다.
cmd_build() {
  ensure_dirs

  info "빌드합니다 (npm run build)"
  if (cd "$PROJECT_ROOT" && npm run build) > "$BUILD_LOG" 2>&1; then
    ok "빌드 완료"
    return 0
  fi

  fail "빌드에 실패했습니다"
  printf "\n"
  tail -n 25 "$BUILD_LOG"
  printf "\n  %s전체 로그: %s%s\n\n" "$C_DIM" "${BUILD_LOG#"$PROJECT_ROOT"/}" "$C_OFF"
  return 1
}

cmd_start() {
  ensure_dirs

  if process_running "$SERVER_PID_FILE" && health_check 3; then
    ok "이미 돌고 있습니다"
    access_urls
    return 0
  fi

  # 산출물이 없으면 만들면 된다. 예전에는 ./install.sh 를 다시 돌리라고
  # 돌려보냈는데, 정작 필요한 것은 빌드 한 번뿐이었다.
  if ! build_exists; then
    info "빌드 산출물이 없습니다"
    cmd_build || return 1
  fi

  # 남아 있는 PID 파일은 지난번에 비정상 종료된 흔적이다. 정리하고 시작한다.
  process_running "$SERVER_PID_FILE"   || rm -f "$SERVER_PID_FILE"
  process_running "$WATCHDOG_PID_FILE" || rm -f "$WATCHDOG_PID_FILE"

  if process_running "$WATCHDOG_PID_FILE"; then
    info "watchdog 이 이미 돌고 있습니다. 서버 기동은 watchdog 에 맡깁니다"
  else
    info "서버와 watchdog 을 시작합니다"
    rotate_all_logs
    nohup "$PROJECT_ROOT/bin/watchdog.sh" >> "$WATCHDOG_LOG" 2>&1 &
    disown 2>/dev/null || true
  fi

  # watchdog 이 서버를 띄우고 /health 가 200 을 줄 때까지 기다린다.
  printf "  기동을 기다리는 중"
  local waited=0
  while [ "$waited" -lt 60 ]; do
    if health_check 3; then
      printf "\n"
      ok "준비됐습니다"
      access_urls
      printf "\n  %s로그: ./run.sh logs   ·   상태: ./run.sh status   ·   중지: ./run.sh stop%s\n\n" \
        "$C_DIM" "$C_OFF"
      return 0
    fi
    printf "."
    sleep 2
    waited=$((waited + 2))
  done

  printf "\n"
  fail "60초 안에 응답이 없습니다. 로그를 확인하세요."
  printf "  %s./run.sh logs server%s\n" "$C_BLUE" "$C_OFF"
  return 1
}

cmd_stop() {
  local stopped=0

  # watchdog 을 먼저 끈다. 서버부터 끄면 watchdog 이 죽은 줄 알고 다시 띄운다.
  if stop_pid_file "$WATCHDOG_PID_FILE" "watchdog" 20; then
    ok "watchdog 을 껐습니다"
    stopped=1
  fi

  if stop_pid_file "$SERVER_PID_FILE" "서버" 15; then
    ok "서버를 껐습니다"
    stopped=1
  fi

  # PID 파일이 유실된 경우를 대비해 이름으로도 한 번 더 확인한다.
  stop_stray "$PROJECT_ROOT/bin/watchdog.sh" "watchdog" && stopped=1
  stop_stray "node $PROJECT_ROOT/dist-server/server/index.js" "서버" && stopped=1

  if [ "$stopped" -eq 0 ]; then
    info "돌고 있는 프로세스가 없습니다"
  fi
  return 0
}

cmd_status() {
  local port
  port="$(server_port)"

  printf "\n"
  printf "  %-12s" "서버"
  if process_running "$SERVER_PID_FILE"; then
    printf "%s돌고 있음%s (pid %s)\n" "$C_GREEN" "$C_OFF" "$(read_pid "$SERVER_PID_FILE")"
  else
    printf "%s꺼져 있음%s\n" "$C_RED" "$C_OFF"
  fi

  printf "  %-12s" "watchdog"
  if process_running "$WATCHDOG_PID_FILE"; then
    printf "%s돌고 있음%s (pid %s)\n" "$C_GREEN" "$C_OFF" "$(read_pid "$WATCHDOG_PID_FILE")"
  elif pgrep -f "$PROJECT_ROOT/bin/watchdog.sh" >/dev/null 2>&1; then
    # PID 파일 없이 떠 있는 경우. stop 이 이름으로 정리하지만 상태에도 드러낸다.
    printf "%s돌고 있음(PID 파일 없음)%s\n" "$C_YELLOW" "$C_OFF"
  else
    printf "%s꺼져 있음%s\n" "$C_RED" "$C_OFF"
  fi

  printf "  %-12s" "응답"
  if health_check 5; then
    printf "%s정상%s  %s%s%s\n" "$C_GREEN" "$C_OFF" "$C_DIM" "$(health_url)" "$C_OFF"
  else
    printf "%s없음%s  %s%s%s\n" "$C_RED" "$C_OFF" "$C_DIM" "$(health_url)" "$C_OFF"
  fi

  printf "  %-12s%s  (HOST=%s, HTTPS=%s)\n" "설정" "$port" "$(server_host)" \
    "$(https_enabled && echo on || echo off)"

  printf "\n  로그\n"
  local f
  for f in "$SERVER_LOG" "$WATCHDOG_LOG"; do
    if [ -f "$f" ]; then
      printf "    %-28s %s\n" "${f#"$PROJECT_ROOT"/}" "$(human_size "$(file_size "$f")")"
    fi
  done
  # 회전된 것도 같이 보여준다. 몇 개나 쌓였는지 한눈에 보이는 편이 낫다.
  for f in "$LOG_DIR"/*.log.[0-9]; do
    [ -f "$f" ] || continue
    printf "    %-28s %s\n" "${f#"$PROJECT_ROOT"/}" "$(human_size "$(file_size "$f")")"
  done
  printf "\n"
}

human_size() {
  local bytes="$1"
  if [ "$bytes" -ge 1048576 ]; then
    printf '%s MB' "$((bytes / 1048576))"
  elif [ "$bytes" -ge 1024 ]; then
    printf '%s KB' "$((bytes / 1024))"
  else
    printf '%s B' "$bytes"
  fi
}

cmd_logs() {
  local which="${1:-all}"
  ensure_dirs
  touch "$SERVER_LOG" "$WATCHDOG_LOG"

  case "$which" in
    server)   tail -n 50 -f "$SERVER_LOG" ;;
    watchdog) tail -n 50 -f "$WATCHDOG_LOG" ;;
    all|*)    tail -n 30 -f "$SERVER_LOG" "$WATCHDOG_LOG" ;;
  esac
}

cmd_foreground() {
  if ! build_exists; then
    fail "빌드 산출물이 없습니다. ./install.sh 를 먼저 실행하세요."
    return 1
  fi
  info "터미널을 잡고 실행합니다. watchdog 은 돌지 않습니다. (Ctrl+C 로 종료)"
  access_urls
  printf "\n"
  cd "$PROJECT_ROOT" && exec node "$PROJECT_ROOT/dist-server/server/index.js"
}

case "${1:-start}" in
  start)      cmd_start ;;
  stop)       cmd_stop ;;
  # 빌드를 끄기 전에 한다. 먼저 껐다가 빌드가 깨지면 서버가 내려간 채로
  # 남는다 — 고치는 동안 아무도 쓸 수 없게 되는 것이 가장 나쁜 결과다.
  restart)
    case "${2:-}" in
      -n|--no-build) ;;
      *) cmd_build || exit 1 ;;
    esac
    cmd_stop; sleep 2; cmd_start ;;
  build)      cmd_build ;;
  status)     cmd_status ;;
  logs)       cmd_logs "${2:-all}" ;;
  foreground|fg) cmd_foreground ;;
  -h|--help|help) usage ;;
  *)          fail "모르는 명령: $1"; printf "\n"; usage; exit 1 ;;
esac
