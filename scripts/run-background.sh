#!/usr/bin/env bash
# Start a long-running command in the background and print return_on watcher args.
#
# Usage:
#   scripts/run-background.sh [--dir DIR] [--label LABEL] -- <command...>
#   scripts/run-background.sh [--dir DIR] [--label LABEL] '<shell command>'
#
# The command runs under `sh -lc`, with stdout/stderr captured to a log. The
# wrapper writes pid/status/done files so agents can register return_on on the
# pid file without blocking the conversation.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/run-background.sh [--dir DIR] [--label LABEL] -- <command...>
       scripts/run-background.sh [--dir DIR] [--label LABEL] '<shell command>'

Starts the command in the background and prints the files plus a return_on
example. Default DIR is .return-on/runs.
USAGE
}

out_dir=".return-on/runs"
label="background command"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || { echo "--dir requires a value" >&2; exit 2; }
      out_dir=$2; shift 2 ;;
    --label)
      [ "$#" -ge 2 ] || { echo "--label requires a value" >&2; exit 2; }
      label=$2; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    --)
      shift; break ;;
    *)
      break ;;
  esac
done

[ "$#" -gt 0 ] || { usage >&2; exit 2; }

cmd="$*"
slug=$(printf '%s' "$label" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-\+//; s/-\+$//; s/--\+/-/g' | cut -c1-64)
[ -n "$slug" ] || slug="run"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
run_dir="$out_dir/${stamp}-${slug}"
mkdir -p "$run_dir"

log_file="$run_dir/output.log"
pid_file="$run_dir/pid"
status_file="$run_dir/status"
done_file="$run_dir/done"
cmd_file="$run_dir/command.sh"

printf '%s\n' "$cmd" > "$cmd_file"
chmod 600 "$cmd_file"
printf 'running\n' > "$status_file"

(
  set +e
  sh -lc "$cmd" > "$log_file" 2>&1
  code=$?
  printf '%s\n' "$code" > "$status_file"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$done_file"
  exit "$code"
) &
pid=$!
printf '%s\n' "$pid" > "$pid_file"

cat <<EOF
Started: $label
Command: $cmd
Run dir: $run_dir
PID file: $pid_file
Log: $log_file
Status: $status_file
Done: $done_file

Suggested watcher:
return_on({
  label: "$label finished",
  condition: { type: "process", pidFile: "$pid_file", state: "exited", every: "2s" },
  resume: "Background command '$label' finished. Read $status_file and $log_file, then continue.",
  timeout: "2h"
})
EOF
