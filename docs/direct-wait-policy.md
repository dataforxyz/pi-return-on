# Direct Wait Policy

This extension should keep Pi sessions open while external work runs. The problem is not that `return_on` blocks itself; the problem is that agents sometimes choose direct blocking waits instead of using `return_on`.

## Goal

Prefer this pattern:

1. Start long-running work in the background.
2. Capture logs and pid files, preferably under `.return-on/`.
3. Register a `return_on` watcher for the readiness/completion signal.
4. End the current turn and let `return_on` wake the session later.

Avoid this pattern:

1. Run a direct wait such as `sleep 60`, `tail -f`, `watch`, an infinite polling loop, or a foreground dev server.
2. Keep the assistant turn busy until the wait completes or times out.

## Chosen options

### Option A: prompt guidance

Add system prompt guidance and tool prompt guidelines that tell agents not to wait directly. Agents should start background work, capture logs/pids, and use `return_on` to wake later.

### Option C: block high-confidence direct waits

Block obvious direct waits in bash tool calls and return an actionable reason. The first implementation blocks high-confidence patterns only:

- long `sleep` commands
- `tail -f` / `tail --follow`
- `journalctl -f` / `journalctl --follow`
- `kubectl logs -f` / `kubectl logs --follow`
- `watch ...`
- infinite shell loops such as `while true; do ...` or `for ((;;)); do ...`
- common foreground dev/server commands such as `npm run dev`, `pnpm dev`, `yarn start`, `next dev`, `vite`, and `python -m http.server`

Commands that are explicitly backgrounded with `&`, `nohup`, `setsid`, or `disown` are not blocked by this policy.

## Deferred option

### Option D: auto-convert

Automatically converting a blocking command into a background command plus `return_on` watcher is tracked separately because it can unexpectedly change command semantics. See GitHub issue #1.
