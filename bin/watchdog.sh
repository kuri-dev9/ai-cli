#!/usr/bin/env bash
#
# 서버가 실제로 응답하는지 지켜보다가, 죽었거나 먹통이면 다시 띄운다.
# 로그 회전도 여기서 같이 한다.
#
#   run.sh 가 백그라운드로 띄운다. 직접 실행할 일은 보통 없다.
#
# 확인 방식은 두 단계다.
#   1) 서버 프로세스가 살아 있는가 (PID)
#   2) /health 가 200 을 주는가
#
# 2번까지 보는 이유는, 프로세스는 살아 있는데 이벤트 루프가 막혀 응답을 못 하는
# 상태가 실제로 있기 때문이다. 포트만 확인하면 이걸 못 잡는다.

set -uo pipefail

# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

CHECK_INTERVAL="${WATCHDOG_INTERVAL:-15}"      # 확인 주기(초)
FAIL_THRESHOLD="${WATCHDOG_FAIL_THRESHOLD:-3}" # 연속 몇 번 실패하면 재시작할지
START_GRACE="${WATCHDOG_START_GRACE:-30}"      # 기동 직후 봐주는 시간(초)
MAX_RESTARTS="${WATCHDOG_MAX_RESTARTS:-5}"     # 이 횟수를 넘기면 포기하고 끝낸다
RESTART_WINDOW="${WATCHDOG_RESTART_WINDOW:-600}" # 그 횟수를 세는 창(초)

say() {
  ensure_dirs
  log_line "$1" >> "$WATCHDOG_LOG"
}

start_server_process() {
  ensure_dirs
  rotate_log "$SERVER_LOG"

  cd "$PROJECT_ROOT" || return 1
  # stdout 과 stderr 를 같은 로그로 모은다. 서버가 죽은 뒤에도 남아 있어야
  # 무슨 일이 있었는지 볼 수 있다.
  #
  # `npm run server` 를 쓰지 않는 이유: npm 이 node 를 자식으로 띄우므로 $! 가
  # npm 의 PID 가 된다. 그 PID 를 죽이면 npm 만 끝나고 node 는 고아로 남아
  # 포트를 계속 잡는다. 그러면 재시작이 EADDRINUSE 로 실패하고 stop 도 듣지
  # 않는다. package.json 의 server 스크립트와 같은 명령을 직접 실행한다.
  nohup node "$PROJECT_ROOT/dist-server/server/index.js" >> "$SERVER_LOG" 2>&1 &
  local pid=$!
  printf '%s' "$pid" > "$SERVER_PID_FILE"
  say "서버를 시작했습니다 (pid $pid)"

  # 기동에는 시간이 걸린다. 준비될 때까지 기다렸다가 결과를 남긴다.
  local waited=0
  while [ "$waited" -lt "$START_GRACE" ]; do
    if health_check 3; then
      say "기동 확인됨 (${waited}초)"
      return 0
    fi
    if ! pid_alive "$pid"; then
      say "기동 중에 프로세스가 죽었습니다. logs/server.log 를 보세요"
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done

  say "기동 후 ${START_GRACE}초 안에 /health 응답이 없습니다"
  return 1
}

restart_server() {
  say "서버를 다시 시작합니다"
  stop_pid_file "$SERVER_PID_FILE" "서버" 15 >/dev/null 2>&1
  # 포트가 풀릴 틈을 준다. 바로 띄우면 EADDRINUSE 로 실패할 수 있다.
  sleep 2
  start_server_process
}

cleanup() {
  say "watchdog 을 종료합니다"
  rm -f "$WATCHDOG_PID_FILE"
  exit 0
}
trap cleanup TERM INT

ensure_dirs
printf '%s' "$$" > "$WATCHDOG_PID_FILE"
say "watchdog 시작 (확인 주기 ${CHECK_INTERVAL}초, ${FAIL_THRESHOLD}회 연속 실패 시 재시작)"

consecutive_failures=0
restart_count=0
window_started="$(date +%s)"

while true; do
  sleep "$CHECK_INTERVAL"

  # 로그가 무한정 커지지 않게 매 주기에 크기를 확인한다.
  rotate_all_logs

  now="$(date +%s)"
  if [ $((now - window_started)) -ge "$RESTART_WINDOW" ]; then
    # 창이 지나면 재시작 횟수를 다시 센다. 며칠에 한 번씩 재시작되는 것과
    # 몇 분 사이에 연달아 죽는 것은 다른 문제다.
    if [ "$restart_count" -gt 0 ]; then
      say "최근 ${RESTART_WINDOW}초 동안 재시작 ${restart_count}회. 카운터를 초기화합니다"
    fi
    restart_count=0
    window_started="$now"
  fi

  if process_running "$SERVER_PID_FILE" && health_check 5; then
    if [ "$consecutive_failures" -gt 0 ]; then
      say "정상으로 돌아왔습니다"
    fi
    consecutive_failures=0
    continue
  fi

  consecutive_failures=$((consecutive_failures + 1))

  if process_running "$SERVER_PID_FILE"; then
    say "프로세스는 살아 있으나 /health 응답이 없습니다 (${consecutive_failures}/${FAIL_THRESHOLD})"
  else
    say "서버 프로세스가 없습니다 (${consecutive_failures}/${FAIL_THRESHOLD})"
  fi

  [ "$consecutive_failures" -ge "$FAIL_THRESHOLD" ] || continue

  if [ "$restart_count" -ge "$MAX_RESTARTS" ]; then
    say "재시작이 ${RESTART_WINDOW}초 안에 ${MAX_RESTARTS}회를 넘었습니다."
    say "같은 이유로 계속 죽는 것으로 보고 watchdog 을 끝냅니다. logs/server.log 를 확인하세요."
    rm -f "$WATCHDOG_PID_FILE"
    exit 1
  fi

  restart_count=$((restart_count + 1))
  consecutive_failures=0
  restart_server || say "재시작에 실패했습니다"
done
