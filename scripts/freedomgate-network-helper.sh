#!/bin/sh
# Privileged network helper wrapper for FreedomGate.
#
# Usage: freedomgate-network-helper.sh [start|stop|status|run]
#   start  - start the daemon in the background (default when no argument)
#   stop   - stop a running daemon
#   status - print daemon and network state as JSON
#   run    - run in the foreground (systemd uses this)
#
# The daemon itself is scripts/freedomgate-network-helper.mjs and must run as
# root. systemd starts it through packaging/systemd/freedomgate-network.service.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DAEMON="$SCRIPT_DIR/freedomgate-network-helper.mjs"
NODE=${FREEDOMGATE_NODE:-node}
RUN_DIR=${FREEDOMGATE_RUN_DIR:-/run/freedomgate}
SOCKET="$RUN_DIR/network.sock"
PIDFILE="$RUN_DIR/network-helper.pid"

if [ "$(id -u)" -ne 0 ]; then
  echo 'root required' >&2
  exit 1
fi

command=${1:-start}
case "$command" in
  start)
    mkdir -p "$RUN_DIR"
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo 'helper already running' >&2
      exit 1
    fi
    "$NODE" "$DAEMON" &
    echo $! > "$PIDFILE"
    echo "started pid $(cat "$PIDFILE")"
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      rm -f "$PIDFILE"
    fi
    rm -f "$SOCKET"
    echo 'stopped'
    ;;
  status)
    if [ -S "$SOCKET" ]; then
      "$NODE" -e '
        const { connect } = require("node:net");
        const socket = connect(process.argv[1]);
        let raw = "";
        socket.on("connect", () => socket.end(JSON.stringify({ action: "status" })));
        socket.on("data", chunk => { raw += chunk; });
        socket.on("end", () => { process.stdout.write(raw); });
        socket.on("error", error => { console.error(error.message); process.exit(1); });
      ' "$SOCKET"
    else
      echo '{"ok":false,"error":"helper socket absent"}'
      exit 1
    fi
    ;;
  run)
    exec "$NODE" "$DAEMON"
    ;;
  *)
    echo "usage: $0 [start|stop|status|run]" >&2
    exit 2
    ;;
esac
