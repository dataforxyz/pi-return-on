# Direct Wait Policy

This extension should keep Pi sessions open while external work runs. The problem is not that `return_on` blocks itself; the problem is that agents sometimes choose direct blocking waits instead of using `return_on`.

## Goal

Prefer this pattern:

1. Start long-running work in the background.
2. Capture logs and pid files, preferably under `.return-on/`.
3. Make terminal signals failure-safe: a `.done`/status file must still be written when the command exits nonzero, and process exit should be used as a fallback when practical.
4. Register a `return_on` watcher for the readiness/completion signal.
5. End the current turn and let `return_on` wake the session later.

Avoid this pattern:

1. Run a direct wait such as `sleep 10` or longer, `tail -f`, `watch`, an infinite polling loop, or a foreground dev server.
2. Keep the assistant turn busy until the wait completes or times out.

## Chosen options

### Option A: prompt guidance

Add system prompt guidance and tool prompt guidelines that tell agents not to wait directly. Agents should start background work, capture logs/pids, and use `return_on` to wake later.

### Option C: block high-confidence direct waits

Block obvious direct waits in bash tool calls and return an actionable reason. The first implementation blocks high-confidence patterns only:

- `sleep` commands of 10 seconds or longer
- `tail -f` / `tail --follow`
- `journalctl -f` / `journalctl --follow`
- `kubectl logs -f` / `kubectl logs --follow`
- `watch ...`
- infinite shell loops such as `while true; do ...` or `for ((;;)); do ...`
- common foreground dev/server commands such as `npm run dev`, `pnpm dev`, `yarn start`, `next dev`, `vite`, and `python -m http.server`
- `timeout N <cmd>` (GNU coreutils) where `N` is 5 minutes or longer. Bounding a slow command with a hard ceiling still blocks the turn for up to `N`; the same workload should run in the background with a `return_on` watcher on its pid/log. `timeout` values between 30s and 5m are audited as `allowed_short_timeout` for visibility but not blocked.
- `gh run watch <run-id>` and `gh pr checks --watch` (not `--watch=false`). Both poll a CI run synchronously and can pin the turn for the full duration of the workflow. Use an `exec` watcher that polls `gh run view <id> --json status` instead.
- High-confidence fragile background completion wrappers: when `set -e`/`errexit` is enabled, a command such as `( work; printf '%s\\n' "$?" > "$DONE" ) &` never writes the sentinel if `work` returns nonzero. Detection preserves multiline statement boundaries, recognizes combined option forms such as `set -o pipefail -o errexit`, accepts variable-backed or literal `.done`/`.status`/`.exit`/`.rc` targets, matches the enclosing background subshell through nested parentheses, and resolves errexit/sentinel-assignment state only from applicable ancestor shell scopes. A single background `&` is distinguished from `&&`; shell comments remain masked through the real newline even when they contain quotes or semicolons; `set -`/`set --` stops option parsing; and control flow only exempts a write for a completed `if` or a known-success `|| true`/`|| :`/status-assignment fallback immediately determining the recorded status; `|| exit` and other failure-propagating alternatives remain blocked. An unrelated `EXIT` trap is not treated as proof that the sentinel will be written. Use `if work; then rc=0; else rc=$?; fi`, or an `EXIT` trap that actually writes the sentinel, before recording terminal status. Capture `$!` and watch process exit as a fallback so unexpected wrapper failure cannot leave a file-only watcher waiting until timeout.

Commands that are explicitly backgrounded with `&`, `nohup`, `setsid`, or `disown` are not blocked for merely being long-running. An explicitly backgrounded command can still be blocked when its completion wrapper is provably fragile under errexit.

## Observability

Every direct-wait policy interaction is appended to:

```text
~/.local/state/pi-return-on/direct-wait-audit.jsonl
```

The audit records:

- blocked direct waits
- allowed short sleeps under 10 seconds
- allowed/backgrounded direct-wait-shaped commands
- cwd, session file, command, matched kind/detail, threshold, timestamp, and reason when blocked

Commands are lightly redacted for common `token=`, `api_key=`, `secret=`, and password-style values.

Use `/return-on-direct-waits [limit]` or `/return-on-audit [limit]` inside Pi to see a recent summary.

Use the scanner script outside Pi to summarize the audit log and scan Pi session logs for possible missed opportunities:

```bash
npm run audit:direct-waits
node scripts/scan-direct-waits.mjs --json
node scripts/scan-direct-waits.mjs ~/.pi/agent/sessions
node scripts/scan-direct-waits.mjs --json --audit-only /path/to/direct-wait-audit.jsonl
```

The scanner reports structured audit counts plus text-log candidates such as long sleeps, streaming waits, polling loops, and foreground dev servers that may not have gone through the current blocker.

## Opt-in auto-backgrounding

### Option D: auto-convert safe finite waits

Auto-conversion is available only when `returnOn.autoBackground` enables it. In an interactive session, `/return-on-config` provides a menu; direct forms include `/return-on-config off`, `/return-on-config explicit`, and `/return-on-config long 5m 5m`. The extension first persists a provisional false launch gate, starts a failure-safe detached wrapper with `.return-on/auto-bash-*.{log,pid,done}` artifacts, then binds and saves a process-exit watcher using the known numeric PID. It returns a visible terminating receipt to the model and records `auto_backgrounded` in the audit log.

`"explicit"` mode is deliberately limited to finite explicit waits (`sleep` and GNU `timeout N <command>`). `"explicit-and-long-tool-timeout"` additionally converts generic commands carrying a long Pi bash-tool `timeout` field, such as `make verify-fast-checks` with `timeout: 900`. It preserves that tool deadline with GNU `timeout` in the wrapper. A long tool timeout beyond `returnOn.maxTimeout` is blocked rather than allowed to occupy the foreground turn.

Streaming logs, foreground servers, CI watches, infinite loops, compound shell commands, and fragile completion wrappers are not auto-converted: their correct readiness condition or duration cannot be inferred safely, so the existing actionable block remains. The feature is off by default because its `/usr/bin/env bash` wrapper is not appropriate for commands that require a custom non-Bash Pi shell. Persisting a mode alone never registers the override: a user must launch Pi with `--return-on-auto-background` and invoke `/return-on-config` in an interactive TUI session to activate it. This double opt-in prevents inherited configuration and environment markers from silently replacing an embedded SDK’s opaque base-tool override, while `--no-builtin-tools` and sandbox/SSH/custom extension policies remain protected. Project-local auto-background settings are read only when Pi trusts the project.
