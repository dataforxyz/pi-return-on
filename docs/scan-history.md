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

- [x] Improve `normalizeCondition` error messages so leaves like `{file:{...}}`
      or untyped leaves inside `{op,children}` point at the correct
      `{type:"...", ...}` shape.
- [x] Add `pidFile` support to process conditions (read pid from file, then
      apply existing pid/status logic).
- [x] Reconsider the default `maxTimeout` cap or auto-fallback to the cap with
      a warning instead of erroring out. *(Default cap raised from 10 m to 2 h
      so DB dumps, build matrices, and remote renders work out of the box;
      operators can still lower it via `returnOn.maxTimeout`.)*
- [x] Expand README/tool description with the canonical flat-leaf examples
      so new agents see the right shape first. *(See README "Canonical
      condition shapes".)*
- [x] Accept `condition` as a JSON-encoded string and `JSON.parse` it before
      validating. *(Fixes the 12 "condition must be an object" cases where
      agents serialized the object first.)*

### Notes on the 10 "condition must be an object" hits

All were from one session passing `condition` as a stringified JSON object,
e.g. `"{\"op\":\"or\",\"children\":[...]}"`. After the JSON-string fix the
extension parses these automatically. The same session then retried with
wrapper-style leaves, which the schema-error commit now flags clearly.

### Re-scan checklist

After the fixes have been live for a week or two, run:

```bash
npm run scan-errors
```

and append a new dated section to this file with the resulting tally. Goal:
schema-confusion / pidFile / timeout-cap counts should approach zero. If they
don't, the error messages still aren't pointing agents at the right shape.

## 2026-05-16 direct-wait audit

The complementary direct-wait scan (`npm run audit:direct-waits`) looks at
bash tool calls that **should** have been a `return_on` watcher but instead
blocked the agent's turn. Filtered to actual bash `toolCall` entries (not
incidental log mentions):

| Count | Kind |
|------:|------|
| 479 | long `sleep` (≥10s) in foreground |
|   8 | `watch` / repeated polling |
|   1 | `npm/yarn/pnpm dev` style dev server |
|   1 | `while true; do …; done` polling loop |

Duration distribution for the 479 long sleeps:

| Count | Duration |
|------:|----------|
| 208 | 30–60 s |
| 189 | 10–30 s |
|  81 | 1–5 m |
|   1 | 5–30 m |

Observed patterns (representative samples):

- `sleep 20; ssh … 'systemctl is-active …; docker ps …'` — wait for a
  remote service restart, then probe. Better as
  `{type:"url"}` health-check or `{type:"exec"}` with `success:true` + `every`.
- `for i in {1..20}; do ssh … || sleep 10; done` — manual retry loop. Better
  as `{type:"exec", command:"ssh …", success:true, every:"10s"}` with a
  timeout.
- `sleep 30; journalctl --since '35 seconds ago' …` — drain logs after a
  device/service event. Better as `{type:"file"}` watcher on the log path with
  `stableFor` or `{type:"exec"}` against `journalctl --grep`.
- `sleep 15; pgrep -af 'piker chart' && tail -20 …` — wait for a foreground
  process to settle. Better as `{type:"process", name:"piker chart"}` or
  `{type:"port"}` if it binds a port.

False-positive note: the `watch`/`dev` arms over-match (e.g. `rg ... "watch
party"`, `next-fixtures`); the 479 long-sleep number is the clean signal.

Follow-up: the README "Canonical condition shapes" section should help, but
the biggest lever is likely a Pi-side hint when an agent issues a `bash` with
a long foreground `sleep` — surface the equivalent `return_on` call. Track
that as a separate enhancement rather than another scanner pass.

## 2026-05-16 capability additions

While working through the scan, two capability gaps were closed so that the
next scan should see strictly fewer reasons for agents to fall back to direct
waits or work around the tool:

- **`maxFires`** for repeating watchers. Default is still `1`. With
  `maxFires > 1`, a watcher fires up to N times, edge-triggered (the
  condition must evaluate false between fires) and is also retired by its
  `timeout`, whichever comes first. Timer-only conditions are rejected at
  registration because a passed deadline cannot re-arm.
- **JSON-string `condition`** — accepted and `JSON.parse`d before validation,
  matching how some callers flatten tool arguments.

Follow-ups to watch in the next scan:

- [x] Surface a Pi-side hint when a foreground `sleep ≥10s` is issued,
      suggesting the equivalent `return_on` call. *(`formatDirectWaitBlockReason`
      now emits a kind-specific suggestion: timer for long sleeps, file
      watcher for `tail -f`/`journalctl -f`/`kubectl logs -f`, port watcher
      for foreground dev/start servers, exec watcher for repeated polling,
      and a generic file/process/port/url/exec hint for infinite loops.)*
- [ ] After a couple weeks live, re-run `npm run scan-errors` and
      `npm run audit:direct-waits` and append a new dated section. Expect
      schema-confusion, pidFile-not-supported, and timeout-cap-exceeded
      counts to approach zero; long-sleep blocks should drop only modestly
      until the Pi-side hint lands.
