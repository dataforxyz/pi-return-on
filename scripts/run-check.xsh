#!/usr/bin/env xonsh
# Helper for pi-return-on xonsh checks.
# Usage: run-check.xsh 'pgrep node'
import sys
if len(sys.argv) < 2:
    print(f"usage: {sys.argv[0]} '<command>'", file=sys.stderr)
    sys.exit(2)
cmd = sys.argv[1]
result = __xonsh__.subproc_captured_hiddenobject(cmd)
sys.stdout.write(result.out or "")
sys.stderr.write(result.err or "")
sys.exit(result.rtn)
