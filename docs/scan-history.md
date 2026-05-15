# return_on scan history

A running tally of `return_on` tool errors observed across local Pi session
logs (`~/.pi/agent/sessions/--<cwd>--/*.jsonl`). Refreshed by running:

```bash
npm run scan-errors
```

Use this file to track which classes of failure are still appearing in real
sessions and whether mitigations are actually landing.

## 2026-05-16 baseline

Total `return_on` tool errors observed: **201**

| Count | Error message |
|------:|---------------|
| 93 | `unsupported condition type 'undefined'` |
| 37 | `process condition requires pid, name, commandContains, or matches` |
| 36 | `return_on timeout 30m exceeds max 10m` |
| 22 | `return_on timeout 15m exceeds max 10m` |
| 10 | `condition must be an object` |
|  2 | `return_on timeout 2h exceeds max 10m` |
|  1 | `return_on timeout 12m exceeds max 10m` |

Condition shapes for the errored calls (top groups):

| Count | Shape |
|------:|-------|
| 58 | `{type:"file", path, exists}` (mostly co-occurring with timeout-exceeds-max) |
| 56 | `{op, children:[{file:{...}}|{process:{...}}]}` — leaves missing `type` |
| 25 | `{file:{path, exists}}` — wrapper-style leaf instead of flat `{type:"file"}` |
| 20 | `{any:[...]}` — same wrapper-style leaves inside group shorthand |

### Themes

1. **Schema confusion.** Agents frequently nest leaves inside `{file:{...}}`,
   `{process:{...}}`, or place them as group `children` without a `type` field.
   The supported shape is flat `{type:"file", path, ...}` (optionally inside
   `{op, children:[...]}` / `{any:[...]}` / `{all:[...]}` groups).
2. **`pidFile` not supported.** 37 errors come from process conditions using
   `{type:"process", pidFile:"..."}`. Agents reach for this when combining a
   file-exists check with a process-exited check via `or` (download/build
   pipelines, e.g. cargoviu DB dump).
3. **10-minute timeout cap is too tight for real workflows.** 61 timeout
   errors at 12 m – 2 h. Workloads include DB dumps, dependency-upgrade test
   matrices, and remote video processing. The current message points users at
   `returnOn.maxTimeout`, but they still keep hitting it.

Hotspot session directories: `async-video-messaging`, `cargoviu-ai-agent`,
`juston-video-projects`.

### Follow-ups

- [ ] Improve `normalizeCondition` error messages so leaves like `{file:{...}}`
      or untyped leaves inside `{op,children}` point at the correct
      `{type:"...", ...}` shape.
- [x] Add `pidFile` support to process conditions (read pid from file, then
      apply existing pid/status logic).
- [ ] Reconsider the default `maxTimeout` cap or auto-fallback to the cap with
      a warning instead of erroring out.
- [ ] Expand README/tool description with the canonical flat-leaf examples
      so new agents see the right shape first.
