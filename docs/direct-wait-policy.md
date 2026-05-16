# Direct Wait Policy

This extension should keep Pi sessions open while external work runs. The problem is not that `return_on` blocks itself; the problem is that agents sometimes choose direct blocking waits instead of using `return_on`.

## Goal

Prefer this pattern:

1. Start long-running work in the background.
2. Capture logs and pid files, preferably under `.return-on/`.
3. Register a `return_on` watcher for the readiness/completion signal.
4. End the current turn and let `return_on` wake the session later.

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

Commands that are explicitly backgrounded with `&`, `nohup`, `setsid`, or `disown` are not blocked by this policy.

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

## Deferred option

### Option D: auto-convert

Automatically converting a blocking command into a background command plus `return_on` watcher is tracked separately because it can unexpectedly change command semantics. See GitHub issue #1.
