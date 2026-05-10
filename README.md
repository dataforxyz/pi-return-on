# pi-return-on

Pi extension for background timers and condition watchers. It lets the agent register a condition and stop spending tokens; the extension wakes the session later when the condition becomes true.

## MVP tools

- `return_on` — register a watcher and terminate the current LLM turn.
- `return_on_list` — list watcher jobs for the current session.
- `return_on_cancel` — cancel a watcher by id.

Slash commands:

- `/return-on-list`
- `/return-on-status <id>`
- `/return-on-cancel <id>`

## Conditions

Condition trees support boolean groups:

```json
{
  "op": "and",
  "children": [
    {
      "op": "or",
      "children": [
        { "type": "timer", "after": "10m" },
        { "type": "exec", "command": "grep -q 'Server ready' server.log", "every": "5s" }
      ]
    },
    {
      "op": "or",
      "children": [
        { "type": "file", "path": "out/video.mp4", "stableFor": "10s" },
        { "type": "exec", "command": "find out -name '*.mp4' | grep -q .", "every": "10s" }
      ]
    }
  ]
}
```

Shorthands also work:

```json
{ "any": [ { "type": "timer", "after": "5m" }, { "type": "file", "path": "done.txt" } ] }
```

Leaves latch once true, which makes `and` / `or` groups deterministic.

## Leaf types

### Timer

```json
{ "type": "timer", "after": "20m" }
{ "type": "timer", "at": "18:00" }
```

### File

```json
{ "type": "file", "path": "build.log", "contains": "Compiled successfully" }
{ "type": "file", "path": "out/video.mp4", "stableFor": "10s" }
{ "type": "file", "path": "tmp.lock", "deleted": true }
```

### Exec

Runs arbitrary local checks with confirmation in interactive mode unless `allowExec: true` was set after user approval.

```json
{ "type": "exec", "runner": "sh", "command": "grep -q Ready server.log", "every": "5s" }
{ "type": "exec", "runner": "python", "code": "import pathlib,sys; sys.exit(0 if pathlib.Path('done.txt').exists() else 1)", "every": "10s" }
{ "type": "exec", "runner": "xonsh", "code": "pgrep node", "success": true }
```

Supported exec checks include `success`, `failure`, `exitCode`, `stdoutContains`, `stderrContains`, `outputContains`, and regex variants ending in `Matches`.

## Install locally

From this directory:

```bash
pi ext install .
# or add this package path to ~/.pi/agent/settings.json packages/extensions
```

For development, copy or symlink `src/index.ts` into `~/.pi/agent/extensions/pi-return-on/index.ts` and run `/reload`.

## State

Active jobs are persisted to:

```text
~/.local/state/pi-return-on/jobs.json
```

Jobs are session-scoped by Pi session file, so a watcher resumes the session that registered it after `/reload` or restart.
