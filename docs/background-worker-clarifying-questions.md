# Background Worker + Waiting UI Clarifying Questions

This document captures the original open design questions for strengthening `pi-return-on` with a background worker, better wake delivery, and improved visibility into what is being waited on.

> Clarification: the immediate problem is not that `return_on` blocks itself. The immediate problem is that agents sometimes choose direct blocking waits instead of starting background work and using `return_on`. The chosen first step is documented in [Direct Wait Policy](./direct-wait-policy.md): Option A prompt guidance plus Option C high-confidence blocking. Background-worker questions remain useful for future hardening, but they are not the first implementation target.

## Current decision

We are **not** adding an always-running background worker/daemon for now.

The accepted scope is restart-safe persistence:

- Jobs persist in `~/.local/state/pi-return-on/jobs.json` and resume checking when the matching Pi session starts again.
- Fired-event capsules persist in `~/.local/state/pi-return-on/fired/<job-id>.json` so a fired event can be delivered after a restart/session reopen.
- The extension remains responsible for evaluation while Pi is open, UI/status/listing, cancellation, and wake/handler delivery.

This is intentionally simpler than an always-on evaluator. It does **not** guarantee that files/ports/URLs are watched while Pi is closed, and that is acceptable for the current product direction.

Revisit a detached worker only if users later need conditions to keep evaluating while Pi is not running.

## How we will decide

For each future major question, review concrete options, pick a recommended default, and record the decision before implementation.

## 1. Background process / self-blocking

1. What exactly does “return_on blocks itself” mean?
   - The Pi extension process/event loop gets busy?
   - Tool execution waits until the condition fires?
   - File/url/exec polling delays the current assistant turn?
   - Watchers stop during session shutdown/reload?
2. Should watcher evaluation always happen in a separate Node process?
3. Should the parent Pi extension only register jobs, display/list/cancel jobs, watch for fired job files, and wake the session?
4. Should the worker be one shared daemon per machine/user, or one worker per Pi session?
5. If Pi exits, should the worker keep running and fire jobs later?
6. If Pi is not running when a job fires, should it persist a fired marker and wake next time Pi opens that session?
7. Should the worker auto-start on `session_start` if active jobs exist?
8. Should it auto-stop when there are no active jobs?
9. Should stale/orphan workers be killed automatically?
10. Should we support systemd/user services eventually, or just spawn detached Node workers?

## 2. Wake mechanism

11. Should the worker wake Pi by writing a fired file that the extension watches?
12. Or should the worker directly append/send into the session somehow?
13. Should the parent extension use `fs.watch` on a fired directory plus fallback polling?
14. Should fired events be idempotent if both worker and parent see the same job repeatedly?
15. Should jobs have a `deliveryStatus`: `pending`, `delivered`, `failed`?

## 3. UI / “little tags”

16. Where should the small display tags appear?
   - Footer status?
   - Widget above editor?
   - Tool result renderer?
   - Message renderer?
   - All of the above?
17. What should the compact footer say? Examples:
   - `⏰ 2 waiting`
   - `⏰ build 3m · port 3000`
   - `return_on: 2`
18. Should active waits show labels only, or condition summaries too?
19. Should tags include elapsed time / timeout countdown?
20. Should latched leaves be shown in the UI before final firing?
21. Should there be color coding?
   - timer = blue
   - file = green
   - exec = yellow
   - webhook = purple
   - timeout/error = red
22. Should completed/fired jobs remain visible briefly, or disappear once delivered?
23. Should cancelled jobs be hidden by default?

## 4. “See what is being waited on”

24. Should `return_on_list` output richer summaries by default?
25. Should `/return-on-list` show only active jobs, or all session jobs?
26. Should there be `/return-on-watch` or `/return-on-panel` that opens an interactive panel?
27. Should `/return-on-status <id>` show condition tree, last check time, last summary, latches, timeout, worker pid, and incoming webhook URL?
28. Should the tool result after registering a watcher include a human-readable “waiting for…” summary?
29. Should the assistant get injected context like “currently waiting on X” at the next turn?
30. Should jobs expose “next check in” for polling leaves?

## 5. Worker state model

31. Should the jobs file remain the source of truth?
32. Should the worker write to the same `jobs.json`, or only read it and write separate event files?
33. Do we need file locking to avoid parent/worker clobbering state?
34. Is atomic rename enough for now?
35. Should we migrate to per-job JSON files instead of one shared `jobs.json`?
36. Should state be per-user global under `~/.local/state/pi-return-on`, or per-project/session?
37. Should session isolation remain strict?

## 6. Exec watchers

38. Should exec watchers always run in the background worker?
39. Should we further sandbox exec checks?
40. Should exec output be retained in job state, or only last summary?
41. Should long-running exec checks be prevented from overlapping?
42. If an exec check hangs, should the worker kill it and continue?
43. Should exec checks have a default max concurrency?

## 7. Webhooks

44. Should the incoming webhook server live in the worker instead of the Pi extension?
45. If so, should the registration response still immediately include the webhook URL?
46. Should the worker keep the webhook server alive across Pi restarts?
47. Should there be a fixed/default webhook port for discoverability?

## 8. Compatibility / scope

48. Do we need backward compatibility with existing `jobs.json`?
49. Is it okay to add `src/worker.mjs`, or should this stay pure TypeScript?
50. Should tests exercise true detached process behavior, or is an in-process worker harness acceptable for smoke tests?
51. Should the package expose the worker as a bin script?
52. Should this remain private/local, or be designed as a reusable Pi package?

## Proposed decision sequence

1. Define the failure mode: what “self-blocking” means and what must be prevented.
2. Choose worker topology and lifecycle.
3. Choose wake delivery and idempotency model.
4. Choose state ownership and locking strategy.
5. Choose UI surfaces for waiting tags and detail views.
6. Choose command/tool output shape.
7. Choose exec watcher safety constraints.
8. Choose webhook hosting model.
9. Choose compatibility and test scope.
