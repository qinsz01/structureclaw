#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.runtime/pids"
LOG_DIR="$ROOT_DIR/.runtime/logs"

latest_session_header() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  grep "^=== \\[" "$file" | tail -1 || true
}

show_service() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"
  local log_file="$LOG_DIR/$name.log"
  local header=""
  header="$(latest_session_header "$log_file")"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "$name: running (pid $pid)"
      if [[ -n "$header" ]]; then
        echo "  session: $header"
      fi
      return 0
    fi
    echo "$name: stale pid file"
    if [[ -n "$header" ]]; then
      echo "  last session: $header"
    fi
    return 0
  fi

  echo "$name: stopped"
  if [[ -n "$header" ]]; then
    echo "  last session: $header"
  fi
}

show_service "backend"
show_service "frontend"
show_service "core"

echo
echo "Health checks:"
curl -sf http://localhost:8000/health >/dev/null && echo "backend: healthy" || echo "backend: unavailable"
curl -sf http://localhost:8001/health >/dev/null && echo "core: healthy" || echo "core: unavailable"
curl -sfI http://localhost:3000 >/dev/null && echo "frontend: healthy" || echo "frontend: unavailable"
