#!/bin/bash
# End-to-end UI tests against the real KalCode Remote dev host (crates/remote/examples/devhost.rs).
#
#   scripts/e2e.sh <simulator-udid> [agents=8] [extra xcodebuild args, e.g. -only-testing:...]
#
# Expects: DEVHOST=<path to built devhost binary> (default: ../host/target/debug/examples/devhost)
# Starts a fresh devhost advertising 127.0.0.1:47820 (the simulator shares the Mac's network),
# then serves the UI tests' control requests through files in $CTL:
#   request = pair | kill | start | revoke   →   ack-<cmd> (ack-pair contains a fresh pairing link)
set -u
UDID=$1; AGENTS=${2:-8}; shift; [ $# -gt 0 ] && shift
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${KC_WORK:-$ROOT/../run-e2e}
DEVHOST=${DEVHOST:-$ROOT/../host/target/debug/examples/devhost}
CTL=$WORK/ctl; DATA=$WORK/data; LOG=$WORK/devhost.log; FIFO=$WORK/stdin
rm -rf "$WORK"; mkdir -p "$CTL" "$DATA"

start_host() {
  rm -f "$FIFO"; mkfifo "$FIFO"
  sleep 2147483647 > "$FIFO" 2>/dev/null < /dev/null & echo $! > "$WORK/hold.pid"
  "$DEVHOST" --data "$DATA" --agents "$AGENTS" --port 47820 --name "Kaleb's Workstation" --addr 127.0.0.1:47820 < "$FIFO" >> "$LOG" 2>&1 &
  echo $! > "$WORK/host.pid"
  for _ in $(seq 50); do grep -q "listening on" "$LOG" 2>/dev/null && break; sleep 0.1; done
}
stop_host() {
  for f in host hold; do [ -f "$WORK/$f.pid" ] && kill "$(cat "$WORK/$f.pid")" 2>/dev/null; rm -f "$WORK/$f.pid"; done
  for _ in $(seq 30); do nc -z 127.0.0.1 47820 2>/dev/null || break; sleep 0.1; done
}
host_cmd() { echo "$1" > "$FIFO"; }
fresh_link() {
  local before; before=$(grep -c 'kalcode-remote://pair' "$LOG")
  host_cmd pair
  for _ in $(seq 50); do [ "$(grep -c 'kalcode-remote://pair' "$LOG")" -gt "$before" ] && break; sleep 0.1; done
  grep -o 'kalcode-remote://pair?d=[A-Za-z0-9_=-]*' "$LOG" | tail -1
}
trap 'stop_host; [ -n "${WATCH_PID:-}" ] && kill $WATCH_PID 2>/dev/null' EXIT

start_host
echo "devhost pid $(cat "$WORK/host.pid"); agents $AGENTS; ctl $CTL"

( while true; do
    if [ -f "$CTL/request" ]; then
      cmd=$(tr -d '[:space:]' < "$CTL/request"); rm -f "$CTL/request"
      case "$cmd" in
        pair)   fresh_link > "$CTL/ack-pair.tmp"; mv "$CTL/ack-pair.tmp" "$CTL/ack-pair" ;;
        kill)   stop_host; touch "$CTL/ack-kill" ;;
        start)  start_host; touch "$CTL/ack-start" ;;
        revoke) host_cmd revoke-all; sleep 0.5; touch "$CTL/ack-revoke" ;;
      esac
      echo "ctl: $cmd" >> "$WORK/ctl.log"
    fi
    sleep 0.1
  done ) & WATCH_PID=$!

cd "$ROOT"
TEST_RUNNER_KC_CTL_DIR="$CTL" TEST_RUNNER_KC_PAIR_LINK="$(fresh_link)" \
xcodebuild -project KalCodeRemote.xcodeproj -scheme KalCodeRemote -destination "id=$UDID" \
  -derivedDataPath "$ROOT/../dd" -resultBundlePath "$WORK/e2e.xcresult" \
  -only-testing:KalCodeRemoteUITests "$@" test 2>&1 | grep -E "Test Case .*(passed|failed)|error:|Executed|\*\* "
