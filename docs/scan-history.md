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

## 2026-05-16 post-fix re-scan

First re-scan after the schema-error / pidFile / timeout-cap / JSON-string
and wrapper-leaf-recursion fixes shipped. `scan-return-on-errors.mjs` now
supports `--since <iso>` / `--until <iso>` / `--json` so the historical
log of pre-fix errors stays in the cumulative total without polluting the
actual signal.

```bash
npm run scan-errors -- --since 2026-05-15T22:30:00Z   # = post-JSON-string fix
```

Result: **5 errors** (vs 201 cumulative baseline), all from two sessions
that were running older builds at scan time:

| Count | Error |
|------:|-------|
| 2 | `condition leaf uses wrapper shape '{process:{...}}'` |
| 1 | `condition leaf uses wrapper shape '{exec:{...}}'` |
| 2 | `return_on timeout 30m exceeds max 10m…` |

Notes:

- The two `30m` timeout-cap hits are emitted by the **old 10m cap** wording.
  The current code reports the 2h default, so those sessions are on a build
  predating `7380988`. Once they restart they'll inherit the new cap.
- The three wrapper-shape hits are the *new* error message firing correctly,
  not a regression. Agents are now told the exact flat shape to use.
- The wrapper-leaf-inside-`{op,children}` case is covered by
  `testConditionShapeErrors` ("wrapper file leaf inside op group") and the
  recursion catches it. The 1 such case in the raw post-fix scan is again
  a session on an older build.
- The 12 "condition must be an object" hits in the wider sweep are all from a
  single session at 19:36 UTC on 2026-05-15, before `1a9ded4` (22:21 UTC)
  shipped the JSON-string fix.

The baseline shifts dramatically once we exclude pre-fix sessions, which is
the right way to track progress going forward. Re-run with `--since` set to
the latest pre-fix-cluster boundary in each scan.

## 2026-05-16 wider blocking-pattern sweep + gh CI watchers

With the `timeout N` detector live, re-ran a wider scan looking for other
foreground-blocking patterns not yet caught. Candidates inspected:
`gh run watch`, `gh pr checks --watch`, `kubectl wait`, `docker wait`, the
`wait` shell builtin on a pid, `inotifywait`, `entr`, `nc -l`, ssh tail-f,
long `curl --max-time`, `nodemon`, `vitest --watch`, `jest --watch`,
`cargo watch`, `tsc --watch`, `tmux attach`, `screen -r`.

After tightening the regexes to skip false positives (grep word lists,
`--watch=false`, the substring inside heredocs), the only real hits across
all local sessions were:

- **3x `gh run watch <id>`** in cargoviu-ai-agent CI workflows. Synchronous
  poll for the full duration of the GitHub Actions run.
- 0 of the other candidates were genuine.

Fix: added a `"ci watch"` kind to `analyzeDirectWait` covering
`gh run watch <id>` and `gh pr checks --watch` (but not `--watch=false`).
Block suggestion is an `exec` watcher polling `gh run view <id> --json
status --jq .status` for `"completed"`. Smoke coverage added.

Takeaway: the existing detector covers the bulk of real blocking patterns.
Further additions should be data-driven — re-run the wider sweep every few
weeks and only add a detector once the pattern appears in real sessions.

## 2026-05-16 timeout-bounded command detection

User asked: are we catching `timeout 900 <cmd>` patterns? A quick session scan
found **80** bash tool calls with `timeout N` where N >= 30s:

| Bucket | Count |
|---|---|
| 30-60s | 20 |
| 1-5m  | 46 |
| 5-15m | 10 |
| 15-30m | 3 |
| 30-60m | 1 |

The 5-15m / 15-30m / 30-60m cases (14 total) are the bad ones: the agent is
pinning the turn for up to 30+ minutes instead of backgrounding the command
and using `return_on` on its pid. Workloads observed: piker backtests,
juston-app pytest matrix, fetch_hist data jobs.

Fix: `analyzeDirectWait` now detects `timeout [opts] N[smhd] <cmd>` and
classifies it as a `"timeout-bounded command"`. >= 5m is blocked with a
suggested `return_on({type:"process", pidFile:...})` shape; 30s-5m is
audited as `allowed_short_timeout` so we keep visibility on the smaller
cases without disrupting routine usage. Smoke coverage added.

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
- [x] `scan-return-on-errors` learned `--since`/`--until`/`--json` so we can
      filter to post-fix sessions instead of comparing against a cumulative
      tally that includes everything on disk.

## 2026-05-15 first post-fix scan

Filtered to errors logged after the JSON-string fix (`1a9ded4`) shipped at
`2026-05-15T22:21Z`:

```bash
node scripts/scan-return-on-errors.mjs --since 2026-05-15T22:30:00Z
```

Result: **5 errors** (down from the 201-error pre-fix baseline / 220 cumulative).

| Count | Error |
|------:|-------|
| 2 | `condition leaf uses wrapper shape '{process:{...}}'` (new clearer message hitting) |
| 2 | `return_on timeout 30m exceeds max 10m` |
| 1 | `condition leaf uses wrapper shape '{exec:{...}}'` (new clearer message hitting) |

Diagnosis:

- The wrapper-shape errors **are the fix working**: agents that used to get
  `unsupported condition type 'undefined'` now get the targeted message and
  in this session retried with `{type:"process", ...}` successfully on the
  next call. No code change needed.
- The 30m/10m hits are not a regression of the 2 h default raise. The user's
  `~/.pi/agent/settings.json` explicitly pins `returnOn.maxTimeout: "10m"`,
  which takes precedence over the new default. Either bump that setting or
  remove it to inherit the 2 h default.
- Zero `condition must be an object` hits post-fix — the JSON-string parse is
  catching everything the previous baseline showed (the 12 pre-fix hits at
  19:36Z that earlier scans surfaced predate the commit by ~3 h).
- Zero `process condition requires pid, name, commandContains, or matches`
  hits post-fix — `pidFile` support is being used correctly.

Follow-up: in a couple weeks, re-run with `--since` set to the latest fix
date and append a new dated section; the wrapper-shape hits should trend
toward zero as the clearer error nudges agents to retry with the canonical
shape on first failure.

## 2026-05-25 current scan + exec `cmd` alias

Refreshed scans:

```bash
node scripts/scan-return-on-errors.mjs --json
node scripts/scan-return-on-errors.mjs --days 7 --json
node scripts/scan-direct-waits.mjs --audit-only --json
```

Before today's compatibility tweak, the 7-day `return_on` error scan showed
**1 unresolved / 4 total** recent errors:

| Count | Error | Diagnosis |
|------:|-------|-----------|
| 1 | `exec condition requires command or code` | Agent supplied `{type:"exec", cmd:"..."}` instead of canonical `command`. |

All other recent errors were historical wrapper-shape messages that are already
covered by current condition compatibility. The cumulative scan had **2
unresolved / 281 total** before the tweak: the same exec `cmd` alias issue plus
one real `return_on timeout 4h exceeds max 2h` event.

Fix: `normalizeCondition` now accepts `cmd` as a compatibility alias for exec
conditions and normalizes it to `command`; the error scanner suppresses the old
`exec condition requires command or code` entries when the failed call used
that now-supported alias. Post-fix scan result:

| Scope | Unresolved | Resolved / total |
|-------|-----------:|-----------------:|
| 7 days | 0 | 4 / 4 |
| cumulative | 1 | 280 / 281 |

Remaining unresolved cumulative issue: a single `4h` watcher request exceeding
the current `2h` max. Keep this as a real signal unless it recurs; callers
should choose a shorter watcher, chain follow-up watchers, or opt into a larger
`returnOn.maxTimeout` in settings.

Direct-wait audit entries are small and mostly benign: **28** audited events
(**21** allowed short sleeps, **6** allowed short `timeout` commands, **1**
blocked long sleep). The blocked case was `sleep 30s` inside a remote tmux
smoke-check; the existing policy message suggested a timer watcher and captured
artifacts, so no scanner/code change was needed for that pattern.

Follow-up lifecycle tooling added:

- `npm run scan-lifecycle` / `node scripts/scan-return-on-lifecycle.mjs --json` reads `~/.local/state/pi-return-on/{jobs.json,handlers.json,fired/,lifecycle-audit.jsonl}` and summarizes:

- watcher outcomes: active/fired/cancelled, timeout count/rate, fire latency;
- active health: expired active jobs, stale active jobs, never-checked jobs;
- delivery health: fired events by status, fired jobs with no observed delivery;
- handler health: failed handlers, stale in-flight handlers, in-flight handlers whose pid is already dead, completed handlers with no summary.

Initial run on current state showed useful signals that the error scanner cannot see: **6 timed-out fired jobs**, **11 expired active jobs**, **12 stale active jobs**, **4 failed handlers**, and **2 in-flight handlers with dead pids**. Fired-event capsules themselves looked healthy (**153 handler-launched, 0 undelivered**).

Additional upgrades in the same pass:

- Extension now appends lifecycle events to `lifecycle-audit.jsonl` for registration, firing/timeouts, delivery marking, handler queue/running/finish/launch-failure, cancellation, and handler reconciliation. This preserves trend data even when retained state is pruned.
- `npm run repair-lifecycle` dry-runs safe cleanup; `-- --apply` marks expired active jobs as timeout-fired with pending fired capsules and reconciles dead in-flight handler pids from their stdout/stderr artifacts.
- `npm run check:lifecycle` fails automation if lifecycle health exceeds threshold env vars (`RETURN_ON_MAX_EXPIRED_ACTIVE`, `RETURN_ON_MAX_STALE_ACTIVE`, `RETURN_ON_MAX_DEAD_HANDLER_PIDS`, `RETURN_ON_MAX_STALE_HANDLERS`, `RETURN_ON_MAX_FAILED_HANDLERS`, `RETURN_ON_MAX_UNDELIVERED_EVENTS`, etc.). CI runs it over the last 7 days after tests.
