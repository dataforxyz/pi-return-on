# pi-return-on

Pi extension for background timers and condition watchers. It lets the agent register a condition, end the current turn, and wake the same session later when the condition becomes true.

Use this when the agent would otherwise waste tokens waiting for a build, render, server, process, file, log line, port, or another external event.

## What it can wait for

- **Time** — after a duration or at a clock/date time.
- **Files/logs** — exists, absent, deleted, changed, stable for a duration, contains text, matches regex.
- **Processes** — pid running/exited, process name, command substring, or `/proc` regex match.
- **Ports** — TCP port open/closed checks without shelling out.
- **URLs** — HTTP status and optional body text/regex checks.
- **Incoming webhooks** — start a local HTTP endpoint that wakes the session when called.
- **Commands** — shell/bash/xonsh/python/node checks by exit code or output match.
- **Agents/subagents** — usually by watching a result file or URL; `exec` remains available for custom integrations.
- **Nested logic** — `and`, `or`, `not`, plus shorthand `all`, `any`, `not`.

## Tools

- `return_on` — register a watcher and terminate the current LLM turn.
- `return_on_list` — list watcher jobs for the current session.
- `return_on_status` — show detailed status for one watcher by id.
- `return_on_cancel` — cancel a watcher by id.
- `return_on_handlers` — list background fork/sibling handlers launched for fired watchers.
- `return_on_fired_events` — list durable fired-event capsules used for restart-safe delivery.
- `return_on_prune` — prune old retained jobs, fired-event capsules, handler artifacts, and direct-wait audit entries.

Slash commands:

- `/return-on-list`
- `/return-on-status <id>`
- `/return-on-cancel <id>`
- `/return-on-handlers`
- `/return-on-fired-events [pending|delivered|failed|all] [limit]`
- `/return-on-prune [--dry-run] [--days=N] [--audit-max=N]`
- `/return-on-direct-waits [limit]`
- `/return-on-audit [limit]`

Visibility:

- Active waits update the Pi status footer with compact tags such as `⏰ build · port 127.0.0.1:3000 open` or `⏰ 2 waiting: build · render`.
- `/return-on-list` and `return_on_list` show each job's current wait summary and condition description.
- The `return_on` registration result includes a `Waiting for:` line so the agent and user can immediately verify the watcher target.
- `/return-on-status <id>` and `return_on_status` include the condition tree, latest leaf check summaries, next-check timing, latches, timeout/delivery/handler metadata, incoming webhook paths/URLs, and the resume instruction.
- `/return-on-fired-events` and `return_on_fired_events` show pending/delivered/failed fired capsules for restart-safe delivery debugging.
- `/return-on-prune --dry-run` previews retention cleanup before deleting old state.

Design notes:

- [Direct wait policy](./docs/direct-wait-policy.md)
- [Background worker clarifying questions](./docs/background-worker-clarifying-questions.md)
- [Background event router and handler ledger](./docs/background-event-router.md)
- [Inbound intercom fork channel](./docs/intercom-fork-channel.md)
- [Scan history (recurring tool errors)](./docs/scan-history.md)

Diagnostics:

- `npm run scan-errors` runs `scripts/scan-return-on-errors.mjs` and scans local Pi session JSONL logs for failed `return_on` tool calls, grouping common error messages/argument shapes.
- By default it scans Pi session logs under `~/.pi/agent/sessions/--<cwd>--/*.jsonl`; use `npm run scan-errors -- <path>` to scan non-default session roots.
- `npm run audit:direct-waits` summarizes the structured direct-wait audit plus raw textual candidates in local Pi session logs.
- `npm run collect:direct-waits` runs a read-only structured session scanner that extracts actual bash tool calls matching direct-wait patterns and nearby `return_on` registrations into `~/.local/state/pi-return-on/direct-wait-examples.jsonl` for review. It does not auto-convert commands.
- `npm run review:direct-waits` summarizes/dedupes that corpus, samples unreviewed examples, and can append human verdicts to the sidecar `~/.local/state/pi-return-on/direct-wait-example-reviews.jsonl` without mutating session logs.
- Extension state is stored under `~/.local/state/pi-return-on/`, including `jobs.json`, fired event capsules under `fired/<job-id>.json`, `handlers.json`, direct-wait audit/corpus/review files, and per-handler stdout/stderr/session artifacts under `handlers/<handler-id>/`.
- Startup cleanup keeps active jobs, pending/failed fired events, running handlers, and direct-wait example corpora, while pruning terminal jobs, delivered fired-event capsules, completed handler artifacts, and old direct-wait audit entries after 30 days by default. Use `/return-on-prune --dry-run` or `return_on_prune` to inspect or override the retention window.

## `return_on` parameters

```json
{
  "label": "wait for render",
  "condition": { "type": "file", "path": "out/video.mp4", "stableFor": "10s" },
  "resume": "Continue now that the render output is ready.",
  "every": "2s",
  "timeout": "10m",
  "webhook": "https://example.com/pi-return-on-hook",
  "delivery": { "mode": "fork", "notify": "ack-and-summary" },
  "endTurn": true,
  "allowExec": false
}
```

| Field | Required | Description |
| --- | --- | --- |
| `label` | no | Short human-readable watcher name. |
| `condition` | yes | Condition tree or leaf condition. |
| `resume` | yes | Instruction included in the wake message. |
| `every` | no | Default polling interval inherited by file/process/port/url/exec leaves. |
| `timeout` | no | Wake anyway after this duration. If omitted, `returnOn.defaultTimeout` applies. Values above `returnOn.maxTimeout` are rejected. |
| `webhook` | no | Optional HTTP webhook notified when the watcher fires. URL string or `{url, method, headers, timeout}`. |
| `delivery` | no | Delivery mode. Default is legacy `{mode:"wake"}` unless `returnOn.defaultDeliveryMode` or `PI_RETURN_ON_DELIVERY_MODE=fork` is set. Use `{mode:"fork"}` to launch a background fork/sibling Pi handler instead of waking the parent turn directly. |
| `endTurn` | no | Defaults to `true`, which ends the current assistant turn after registration. Set `false` only when the agent can keep doing useful work without waiting for the condition. |
| `allowExec` | no | Required for `exec` leaves unless the interactive UI confirms. |

Durations accept numbers as milliseconds or strings like `500ms`, `2s`, `10m`, `1h`, `1d`.

## Timeout policy

New watchers are never unbounded. By default, `return_on` applies a 10 minute timeout when the tool call omits `timeout`, and rejects explicit timeouts longer than 2 hours.

Configure these limits in Pi settings (`~/.pi/agent/settings.json` globally or `.pi/settings.json` per project):

```json
{
  "returnOn": {
    "defaultTimeout": "10m",
    "maxTimeout": "2h"
  }
}
```

Lower the cap (for example `"maxTimeout": "10m"`) if you want tighter bounds; raise it (or set per-project) for workflows like long DB dumps or remote renders.

`defaultTimeoutMs` and `maxTimeoutMs` are also accepted as millisecond numbers. The default must be positive and cannot exceed the max. Environment variables `PI_RETURN_ON_DEFAULT_TIMEOUT` and `PI_RETURN_ON_MAX_TIMEOUT` can override the settings for debugging or local experiments.

## Default delivery policy

Use settings to make fork handling the default for real workflows instead of requiring every tool call to repeat `delivery: {"mode":"fork"}`:

```json
{
  "returnOn": {
    "defaultDeliveryMode": "fork",
    "defaultDeliveryNotify": "ack-and-summary",
    "triggerParentOnSummary": false
  }
}
```

`defaultDeliveryMode` accepts `"wake"` or `"fork"`. `defaultDeliveryNotify` accepts `"ack-and-summary"`, `"summary"`, or `"none"`. Environment variables `PI_RETURN_ON_DELIVERY_MODE`, `PI_RETURN_ON_DELIVERY_NOTIFY`, and `PI_RETURN_ON_TRIGGER_PARENT_ON_SUMMARY` override settings for local experiments.

## Background fork handlers

When a watcher fires, the extension writes an idempotent fired-event capsule to `~/.local/state/pi-return-on/fired/<job-id>.json` before delivery. If a future/background evaluator writes a pending capsule while Pi is not active, the extension will deliver it on the next matching `session_start` and mark it delivered.

Legacy delivery wakes the same parent session with `triggerTurn: true`. For events that should be handled without distracting the parent, pass:

```json
{
  "delivery": { "mode": "fork", "notify": "ack-and-summary" }
}
```

When the watcher fires, the extension writes an event capsule under `~/.local/state/pi-return-on/handlers/<id>/`, starts a sibling/background Pi process, and posts a brief ack plus final handler summary back into the parent transcript. By default it can fork the parent session for context; when `endTurn:false` keeps the parent turn active, the handler uses the capsule-only prompt to avoid inheriting live parent work. The handler inherits normal Pi extension discovery, so tools such as `subagent(...)` and `intercom(...)` are available when they are installed for top-level Pi sessions.

If pi-intercom is available, the handler prompt includes the parent intercom target and an explicit delegated-authority policy. The handler may answer or act directly when the needed response is derivable from the event, inherited context, repo state, or prior user instructions. It should escalate to the parent only for destructive actions, ambiguous user preference, external side effects, security/privacy/cost risk, conflict with current parent work, or low confidence. Use `intercom.send` for non-blocking progress, blocker, or escalation notices; use `intercom.ask` only when a parent decision is required and the handler cannot safely continue without it. Routine completion should still be returned as the final handler summary.

Useful delivery options:

- `notify: "ack-and-summary"` — post launch ack and final summary.
- `notify: "summary"` — only post the final summary.
- `notify: "none"` — keep handler output in its handler directory only.
- `triggerParentOnSummary: true` — make the final summary trigger a parent turn; default is display-only.
- `piCommand` — override the `pi` executable path for testing or custom installs. `PI_RETURN_ON_PI_BIN` also works.

Set `returnOn.defaultDeliveryMode` to `"fork"` or set `PI_RETURN_ON_DELIVERY_MODE=fork` before starting Pi to make fork handling the default for new watchers. Use `{ "delivery": { "mode": "wake" } }` to force legacy direct wake for a specific watcher.

## Orchestration recipes

These patterns keep the parent session available while a watcher or fork handler handles the wait.

### Continue working while a background command runs

Start the command yourself, capture logs/pid, and register a watcher with `endTurn:false` if there is still useful work to do in the same turn.

```bash
mkdir -p .return-on
npm test > .return-on/test.log 2>&1 & echo $! > .return-on/test.pid
```

```json
{
  "label": "test process finished",
  "condition": { "type": "process", "pid": 12345, "exited": true },
  "resume": "The test process exited. Inspect .return-on/test.log and summarize failures or success.",
  "delivery": { "mode": "fork", "notify": "ack-and-summary" },
  "endTurn": false
}
```

Use `endTurn:true` or omit it when the next useful action really depends on the process result.

### Wait for a log marker

Use file `contains` or `matches` when a process writes a clear readiness, success, failure, or attention marker.

```json
{
  "label": "dev server ready",
  "condition": { "type": "file", "path": ".return-on/server.log", "contains": "Server ready" },
  "resume": "The dev server log says it is ready. Verify the URL if needed and continue.",
  "delivery": { "mode": "fork", "notify": "summary" }
}
```

For failure-first routing, use `any` with separate marker conditions and let the fork handler inspect the log around the match.

```json
{
  "label": "agent log reached terminal marker",
  "condition": {
    "any": [
      { "type": "file", "path": ".return-on/worker.log", "contains": "COMPLETE" },
      { "type": "file", "path": ".return-on/worker.log", "matches": "ERROR|needs_attention|BLOCKED" }
    ]
  },
  "resume": "Triage the worker log marker. If it is routine, summarize; if blocked or risky, escalate with the smallest needed question.",
  "delivery": { "mode": "fork", "notify": "ack-and-summary" }
}
```

### Wait for async subagents or other agent artifacts

`return_on` does not need to own the subagent runtime. Watch the artifacts the orchestrator already knows about: result files, `events.jsonl`, progress files, output logs, or child processes.

```json
{
  "label": "review subagent result ready",
  "condition": { "type": "file", "path": "/tmp/pi-subagents-user/results/review-run.json", "exists": true },
  "resume": "A review subagent result file is ready. Read it, extract the decision and blockers, and report only the relevant summary.",
  "delivery": { "mode": "fork", "notify": "ack-and-summary" }
}
```

For several workers, combine conditions:

```json
{
  "label": "all workers finished",
  "condition": {
    "all": [
      { "type": "file", "path": ".return-on/worker-a.done", "exists": true },
      { "type": "file", "path": ".return-on/worker-b.done", "exists": true },
      { "type": "file", "path": ".return-on/worker-c.done", "exists": true }
    ]
  },
  "resume": "All workers finished. Compare their outputs, summarize agreement/disagreement, and ask the parent only if a decision is required.",
  "delivery": { "mode": "fork", "notify": "summary" }
}
```

### Wait for service readiness

Use port or URL checks instead of sleeping or polling manually.

```json
{
  "label": "local app ready",
  "condition": { "type": "url", "url": "http://127.0.0.1:3000/health", "ok": true, "bodyContains": "ok" },
  "resume": "The local app health check is passing. Continue with browser/API verification.",
  "every": "2s",
  "timeout": "2m",
  "delivery": { "mode": "fork", "notify": "summary" }
}
```

### Let external systems wake Pi

Use incoming webhooks for CI, deploy providers, remote machines, or humans clicking a callback URL. Pair them with fork delivery when the callback payload may need triage before the parent sees it.

```json
{
  "label": "CI callback",
  "condition": { "type": "webhook", "bodyMatches": "success|failure|cancelled" },
  "resume": "CI called back. Inspect the payload and linked logs if present; summarize status and next action.",
  "delivery": { "mode": "fork", "notify": "ack-and-summary" }
}
```

### Intercom-style delegated handling

When a fired event implies an intercom response, the fork handler has delegated authority to answer routine questions from the event/context. It should send non-blocking notices with `intercom.send`, reserve `intercom.ask` for true parent decisions, and include a compact audit trail in the final summary.

```text
Answered worker ask from handler roh_...:
- Asked: whether to keep API v1 compatibility while fixing tests
- Answered: yes, preserve the public error shape
- Basis: issue instructions and existing README contract
- Parent action: none
```

## Incoming webhooks

Use a `webhook` condition when an external system should wake Pi by making an HTTP request. The extension starts a local HTTP server bound to `127.0.0.1` by default, generates a random path/token if you do not provide them, and returns the callable URL in the tool result.

```json
{
  "label": "external callback",
  "condition": { "type": "webhook" },
  "resume": "The external webhook was called; continue."
}
```

The generated URL looks like:

```text
POST http://127.0.0.1:39123/return-on/abc123...?token=...
```

For remote services, expose the local endpoint with an SSH tunnel, Tailscale, ngrok, Cloudflare Tunnel, etc. You can bind a fixed host/port by setting environment variables before starting Pi:

```bash
PI_RETURN_ON_WEBHOOK_HOST=127.0.0.1 PI_RETURN_ON_WEBHOOK_PORT=8787 pi
```

Optional condition fields: `path`, `token`, `method`, `bodyContains`, and `bodyMatches`.

## Outgoing webhooks

A watcher can also notify an external HTTP endpoint when it fires. The webhook is best-effort and does not replace return_on delivery; delivery may be a same-session wake message or a forked handler depending on the watcher `delivery` settings.

```json
{
  "label": "deploy finished",
  "condition": { "type": "file", "path": "deploy.log", "contains": "DONE" },
  "webhook": {
    "url": "https://example.com/pi-return-on-hook",
    "headers": { "authorization": "Bearer TOKEN" },
    "timeout": "5s"
  },
  "resume": "Deploy finished; inspect the result."
}
```

The webhook receives JSON like:

```json
{
  "event": "return_on.fired",
  "id": "ro_...",
  "label": "deploy finished",
  "reason": "...",
  "createdAt": 1760000000000,
  "firedAt": 1760000010000,
  "cwd": "/path/to/project",
  "resume": "Deploy finished; inspect the result.",
  "condition": {},
  "latches": {}
}
```

Headers are stored in the local jobs state file while the watcher is active, so avoid putting long-lived secrets there unless you trust the machine and state file permissions.

## Event-driven when possible, polling as fallback

File/log leaves use native `fs.watch` on parent directories when available, so file creation/modification/deletion can trigger an immediate re-evaluation instead of waiting for the next polling interval. If native watching is unavailable, or if the parent directory does not exist yet, the regular polling ticker still handles the watcher.

Process, port, URL, and exec leaves remain polling-based.

## Polling with `every`

File, process, port, URL, and exec leaves support `every`. Incoming webhook leaves are event-driven. A top-level `every` on `return_on` is inherited by polling leaves unless the leaf overrides it:

```json
{ "type": "file", "path": "build.log", "contains": "Done", "every": "2s" }
```

```json
{ "type": "exec", "command": "pgrep node", "failure": true, "every": "5000ms" }
```

Defaults:

- file checks: `1s`
- process checks: `2s`
- port checks: `2s`
- URL checks: `5s`
- exec checks: `5s`
- exec checks are clamped to a minimum of `2s`

## Condition trees

Canonical group form:

```json
{
  "op": "and",
  "children": [
    { "type": "timer", "after": "30s" },
    {
      "op": "or",
      "children": [
        { "type": "file", "path": "out/video.mp4", "stableFor": "10s" },
        { "type": "file", "path": "render.log", "contains": "Render complete" }
      ]
    }
  ]
}
```

Shorthands:

```json
{ "all": [ { "type": "timer", "after": "5s" }, { "type": "file", "path": "done.txt" } ] }
```

```json
{ "any": [ { "type": "timer", "after": "10m" }, { "type": "file", "path": "server.log", "contains": "READY" } ] }
```

```json
{ "not": { "type": "file", "path": "tmp.lock", "exists": true } }
```

Leaves in positive `and` / `or` branches latch once true. This makes long-running `and` groups predictable: if one leaf becomes true and later false, it still counts as satisfied. `not` evaluates its child dynamically so it can fire when a file disappears or a command stops succeeding.

Empty `all` / `any` groups are rejected.

## Leaf types

### Timer

```json
{ "type": "timer", "after": "20m" }
```

```json
{ "type": "timer", "at": "18:00" }
```

Common aliases are accepted and normalized:

```json
{ "timer": "20m" }
```

```json
{ "type": "timer", "duration": "20m" }
```

`at` can be an ISO-like date/time or `HH:MM`; if `HH:MM` has already passed today, it means tomorrow.

### File / log

```json
{ "type": "file", "path": "build.log", "contains": "Compiled successfully" }
```

```json
{ "type": "file", "path": "out/video.mp4", "stableFor": "10s" }
```

```json
{ "type": "file", "path": "tmp.lock", "deleted": true }
```

```json
{ "type": "file", "path": "optional.flag", "exists": false }
```

Supported fields:

| Field | Meaning |
| --- | --- |
| `path` | Path relative to the session cwd, or absolute path. |
| `exists: true` | File must exist. This is the default for most file checks. |
| `exists: false` | File must be absent. |
| `deleted: true` | File must be absent/deleted. |
| `changed: true` | File mtime changed since first observation. |
| `stableFor` | File exists and mtime has not changed for this duration. |
| `contains` | File text contains this string. |
| `matches` | File text matches this JavaScript regex. |
| `every` | Polling interval. |

### Process

```json
{ "type": "process", "pid": 12345, "exited": true, "every": "2s" }
```

```json
{ "type": "process", "name": "node", "running": true }
```

```json
{ "type": "process", "pidFile": ".return-on/worker.pid", "exited": true }
```

Supported fields: `pid`, `pidFile`, `name`, `commandContains`, `matches`, `running`, `exited`, `state`, and `every`.

`pidFile` reads the first integer from the file (resolved relative to the session cwd) and applies the existing pid-based check. A missing or empty `pidFile` is treated as the target process not running, so `{exited: true, pidFile: "..."}` fires as soon as the pidfile is removed.

### Port

```json
{ "type": "port", "host": "127.0.0.1", "port": 3000, "open": true, "every": "2s" }
```

Supported fields: `port`, `host`, `open`, `closed`, `timeout`, and `every`.

### URL

```json
{ "type": "url", "url": "http://127.0.0.1:3000/health", "status": 200, "bodyContains": "ok", "every": "5s" }
```

Supported fields: `url`, `method`, `status`, `ok`, `bodyContains`, `bodyMatches`, `timeout`, and `every`.

### Exec

Exec leaves run local commands. They are powerful and risky: commands run as the current user. Prefer first-class `file`, `process`, `port`, and `url` leaves when possible. The extension asks for confirmation in interactive mode unless `allowExec: true` is provided after explicit user approval.

```json
{ "type": "exec", "runner": "sh", "command": "grep -q Ready server.log", "success": true, "every": "5s" }
```

A common alias is accepted and normalized:

```json
{ "exec": "grep -q Ready server.log", "success": true, "every": "5s" }
```

```json
{ "type": "exec", "runner": "python", "code": "import pathlib,sys; sys.exit(0 if pathlib.Path('done.txt').exists() else 1)", "success": true, "every": "10s" }
```

```json
{ "type": "exec", "runner": "xonsh", "code": "pgrep node", "success": true }
```

Supported runners:

- `sh`
- `bash`
- `xonsh`
- `python`
- `node`

Supported checks:

| Field | Meaning |
| --- | --- |
| `success: true` | Exit code is `0`. Default when no explicit check is given. |
| `failure: true` | Exit code is non-zero. |
| `exitCode` | Exit code equals this number. |
| `stdoutContains` / `stderrContains` / `outputContains` | Output contains string. |
| `stdoutMatches` / `stderrMatches` / `outputMatches` | Output matches JavaScript regex. |
| `timeout` | Per-run command timeout. Default `10s`. |
| `every` | Polling interval. Default `5s`, minimum `2s`. |

Stdout/stderr are truncated in job details to avoid unbounded state growth.

## Examples

### Wait 10 minutes

```json
{
  "label": "short break",
  "condition": { "type": "timer", "after": "10m" },
  "resume": "Continue the task after the break."
}
```

### Wait for a render file to stop changing

```json
{
  "label": "render output stable",
  "condition": { "type": "file", "path": "out/video.mp4", "stableFor": "15s", "every": "2s" },
  "resume": "Inspect the rendered video output and continue."
}
```

### Wait for a log line

```json
{
  "label": "server ready log",
  "condition": { "type": "file", "path": "server.log", "contains": "Server ready", "every": "1s" },
  "resume": "The server reports ready; run the next validation step."
}
```

### Wait for a process to exit

```json
{
  "label": "node process exited",
  "condition": { "type": "process", "pid": 12345, "exited": true, "every": "2s" },
  "resume": "The process is gone; inspect its output and continue."
}
```

### Wait for a port to open

```json
{
  "label": "local server port open",
  "condition": { "type": "port", "host": "127.0.0.1", "port": 3000, "open": true, "every": "2s" },
  "resume": "Port 3000 is open; run the browser/API checks."
}
```

### Wait for an HTTP endpoint

```json
{
  "label": "health check ready",
  "condition": { "type": "url", "url": "http://127.0.0.1:3000/health", "status": 200, "every": "5s", "timeout": "2s" },
  "resume": "The health check passes; continue integration testing."
}
```

### Wait for an agent/subagent result file

```json
{
  "label": "subagent result ready",
  "condition": { "type": "file", "path": "/tmp/pi-subagents-uid-1000/async-subagent-runs/RUN_ID/result.json", "exists": true, "every": "3s" },
  "resume": "Read the subagent result and synthesize next steps."
}
```

## Install locally

From this directory:

```bash
npm install
pi ext install .
```

For development, copy or symlink `src/index.ts` into `~/.pi/agent/extensions/pi-return-on/index.ts` and run `/reload`.

## State and restart behavior

Jobs are persisted to:

```text
~/.local/state/pi-return-on/jobs.json
~/.local/state/pi-return-on/handlers.json
~/.local/state/pi-return-on/handlers/<handler-id>/
```

Jobs are scoped by Pi session file. A watcher resumes the session that registered it after `/reload` or restart, but should not wake a different session. Fork-handler output is persisted under `handlers/<handler-id>/`.

## Testing

```bash
npm test
```

This runs TypeScript typechecking for `src/` and `test/`, then runs a hermetic smoke suite with a temporary `HOME`. The smoke suite covers timers, fork-delivery handler launch/summary, incoming webhook wakeups, outgoing webhook delivery, file/log checks, event-driven file rechecks, stable files, first-class process/port/url checks, boolean trees, `not` across skipped polling intervals, exec approval/validation, list/status/cancel surfaces, timeout, restart persistence, and session isolation.

For manual development checks, run the smoke suite directly and inspect the temporary state path printed at the end:

```bash
npm run smoke
```

The smoke harness loads `src/index.ts` as a Pi extension with a fake Pi API, registers the tools and commands, emits `session_start` / `session_shutdown`, and waits for real timer/file/process/port/url/exec wake messages.

## Current limitations

- Agent/subagent watchers are currently expressed through file, URL, incoming webhook, or exec checks rather than a dedicated first-class leaf type.
- File checks are event-assisted with polling fallback; incoming webhooks are event-driven; process, port, URL, and exec checks are polling-based.
- Background commands should be treated as trusted local code.
