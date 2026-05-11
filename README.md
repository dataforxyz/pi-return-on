# pi-return-on

Pi extension for background timers and condition watchers. It lets the agent register a condition, end the current turn, and wake the same session later when the condition becomes true.

Use this when the agent would otherwise waste tokens waiting for a build, render, server, process, file, log line, port, or another external event.

## What it can wait for

- **Time** — after a duration or at a clock/date time.
- **Files/logs** — exists, absent, deleted, changed, stable for a duration, contains text, matches regex.
- **Processes** — pid running/exited, process name, command substring, or `/proc` regex match.
- **Ports** — TCP port open/closed checks without shelling out.
- **URLs** — HTTP status and optional body text/regex checks.
- **Commands** — shell/bash/xonsh/python/node checks by exit code or output match.
- **Agents/subagents** — usually by watching a result file or URL; `exec` remains available for custom integrations.
- **Nested logic** — `and`, `or`, `not`, plus shorthand `all`, `any`, `not`.

## Tools

- `return_on` — register a watcher and terminate the current LLM turn.
- `return_on_list` — list watcher jobs for the current session.
- `return_on_cancel` — cancel a watcher by id.

Slash commands:

- `/return-on-list`
- `/return-on-status <id>`
- `/return-on-cancel <id>`

## `return_on` parameters

```json
{
  "label": "wait for render",
  "condition": { "type": "file", "path": "out/video.mp4", "stableFor": "10s" },
  "resume": "Continue now that the render output is ready.",
  "every": "2s",
  "timeout": "30m",
  "webhook": "https://example.com/pi-return-on-hook",
  "allowExec": false
}
```

| Field | Required | Description |
| --- | --- | --- |
| `label` | no | Short human-readable watcher name. |
| `condition` | yes | Condition tree or leaf condition. |
| `resume` | yes | Instruction included in the wake message. |
| `every` | no | Default polling interval inherited by file/process/port/url/exec leaves. |
| `timeout` | no | Wake anyway after this duration. |
| `webhook` | no | Optional HTTP webhook notified when the watcher fires. URL string or `{url, method, headers, timeout}`. |
| `allowExec` | no | Required for `exec` leaves unless the interactive UI confirms. |

Durations accept numbers as milliseconds or strings like `500ms`, `2s`, `10m`, `1h`, `1d`.

## Webhooks

A watcher can notify an external HTTP endpoint when it fires. The Pi session wake still happens normally; the webhook is best-effort and does not replace the wake message.

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

File, process, port, URL, and exec leaves support `every`. A top-level `every` on `return_on` is inherited by leaves unless the leaf overrides it:

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

Supported fields: `pid`, `name`, `commandContains`, `matches`, `running`, `exited`, `state`, and `every`.

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
```

Jobs are scoped by Pi session file. A watcher resumes the session that registered it after `/reload` or restart, but should not wake a different session.

## Testing

```bash
npm test
```

This runs TypeScript typechecking for `src/` and `test/`, then runs a hermetic smoke suite with a temporary `HOME`. The smoke suite covers timers, webhook delivery, file/log checks, event-driven file rechecks, stable files, first-class process/port/url checks, boolean trees, `not` across skipped polling intervals, exec approval/validation, list/status/cancel surfaces, timeout, restart persistence, and session isolation.

For manual development checks, run the smoke suite directly and inspect the temporary state path printed at the end:

```bash
npm run smoke
```

The smoke harness loads `src/index.ts` as a Pi extension with a fake Pi API, registers the tools and commands, emits `session_start` / `session_shutdown`, and waits for real timer/file/process/port/url/exec wake messages.

## Current limitations

- Agent/subagent watchers are currently expressed through file, URL, or exec checks rather than a dedicated first-class leaf type.
- File checks are event-assisted with polling fallback; process, port, URL, and exec checks are polling-based.
- Background commands should be treated as trusted local code.
