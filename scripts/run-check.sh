#!/usr/bin/env sh
# Helper for pi-return-on exec checks. The extension normally runs commands
# directly, but this script is useful for debugging or policy wrappers.
# Usage: run-check.sh 'grep -q Ready server.log'
set -eu
if [ "$#" -lt 1 ]; then
  echo "usage: $0 '<command>'" >&2
  exit 2
fi
exec sh -lc "$1"
