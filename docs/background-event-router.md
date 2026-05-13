# Background Event Router and Handler Ledger

`return_on` fork delivery establishes a reusable pattern:

```text
event arrives
→ write/audit an event capsule
→ optionally launch a sibling Pi handler
→ handler uses delegated authority
→ parent receives ack, summary, ask, or no-op
```

This document describes how to generalize that pattern beyond watcher firings to async agent completions and inbound intercom messages.

## Goals

- Keep the main/parent session undistracted while routine background events are triaged.
- Let a fork handler answer or act directly when the result is derivable from the event, context, repo state, or prior user instructions.
- Escalate to the parent only for destructive actions, ambiguous preference, external side effects, security/privacy/cost risk, conflict with current parent work, or low confidence.
- Preserve an audit trail of event payloads, handler prompts, stdout/stderr, summaries, errors, and parent linkage.
- Reuse normal top-level Pi extension/tool discovery in handlers.

## Event envelope

Every routed background event should be reducible to a common envelope:

```ts
interface BackgroundEventEnvelope {
  version: 1;
  type: string;                 // return_on.fired, subagent.complete, intercom.message, intercom.ask, ...
  id: string;                   // event id
  source: string;               // extension/tool/session that produced it
  createdAt: number;
  cwd?: string;
  parentSessionFile?: string;
  parentSessionId?: string;
  parentSessionName?: string;
  parentIntercomTarget?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  payload: unknown;             // source-specific event body
  artifacts?: Array<{ kind: string; path?: string; url?: string; description?: string }>;
  resume?: string;              // handler instruction / desired outcome
  authority?: AuthorityPolicy;
  delivery?: DeliveryPolicy;
}
```

Source-specific payloads remain source-owned. The router only needs enough common metadata to choose delivery and create a useful handler capsule.

## Authority policy

Handlers should default to delegated authority for routine work:

```ts
interface AuthorityPolicy {
  mode: "delegated" | "notify-only" | "parent-decision";
  mayAnswerWhenDerivable: boolean;
  escalateOn: Array<
    | "destructive-action"
    | "ambiguous-user-preference"
    | "external-side-effect"
    | "security-privacy-cost-risk"
    | "parent-work-conflict"
    | "low-confidence"
  >;
}
```

Recommended default:

```json
{
  "mode": "delegated",
  "mayAnswerWhenDerivable": true,
  "escalateOn": [
    "destructive-action",
    "ambiguous-user-preference",
    "external-side-effect",
    "security-privacy-cost-risk",
    "parent-work-conflict",
    "low-confidence"
  ]
}
```

## Delivery policy

The router can choose one of several delivery outcomes:

- `noop` — record/audit only.
- `display` — show a parent message without triggering a turn.
- `wake` — trigger the parent directly.
- `fork` — launch a sibling/background Pi handler.
- `intercom-send` — send a non-blocking notice to a target.
- `intercom-ask` — ask only when a blocking decision is unavoidable.

For `fork`, useful notification modes mirror current `return_on` behavior:

- `ack-and-summary`
- `summary`
- `none`

## Handler ledger

The current `return_on` handler state maps cleanly to a common ledger entry:

```ts
interface BackgroundHandlerRun {
  id: string;
  eventId: string;
  eventType: string;
  parentSessionFile?: string;
  parentSessionId?: string;
  parentIntercomTarget?: string;
  status: "starting" | "running" | "complete" | "failed";
  pid?: number;
  dir: string;
  eventPath: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  sessionDir: string;
  summary?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
```

`return_on` already persists this shape under `~/.local/state/pi-return-on/handlers.json` and per-handler directories. A future shared router can either reuse that store or migrate to `~/.local/state/pi-background-events/` once multiple extensions produce events.

## Source mappings

### `return_on.fired`

Current implementation already writes:

- fired event: `~/.local/state/pi-return-on/fired/<job-id>.json`
- handler capsule: `~/.local/state/pi-return-on/handlers/<handler-id>/event.json`
- prompt/stdout/stderr/session artifacts

The envelope payload is the fired watcher: condition, latches, resume instruction, cwd, and handler metadata.

### `subagent.complete` / `subagent.failed` / `subagent.needs_attention`

A subagent orchestrator can route events by watching existing artifacts:

- async result JSON files
- `events.jsonl`
- output/progress files
- child process state

The envelope payload should include run id, child agent name, status, result path, error/needs-attention summary, and artifact paths. A fork handler can read the full result, reduce it to the small parent-relevant decision, and optionally continue follow-up work.

### `intercom.message` / `intercom.ask`

An inbound intercom router can create an envelope containing sender, target, thread/message id, body, attachments, and whether the sender is blocked waiting for a reply.

Recommended behavior:

- `send`: fork handler may process asynchronously and summarize/audit.
- `ask`: fork handler may answer directly if safe and derivable; otherwise escalate to parent quickly.
- urgent/risky asks: route directly to parent or trigger parent immediately.

## Routing defaults

Suggested default matrix:

| Event | Default route | Notes |
| --- | --- | --- |
| Timer/file/process/url watcher fired | fork or wake per watcher config | Existing `return_on` behavior. |
| Long command finished | fork summary | Handler inspects logs and reports only relevant outcome. |
| Log marker `READY` | display/fork summary | Parent usually does not need a full turn. |
| Log marker `ERROR`/`BLOCKED` | fork, maybe wake parent | Handler triages and asks only for required decision. |
| Subagent complete | fork summary | Reduce large result to parent-relevant summary. |
| Subagent failed/needs_attention | fork then maybe parent ask | Handler distinguishes retryable failure from user decision. |
| Intercom send | fork/no-op/display | Non-blocking by default. |
| Intercom ask | fork with answer authority; wake if unsafe | Sender is blocked, so escalation must be fast. |

## Implementation sequence

1. Keep `return_on`'s current handler ledger as the working implementation.
2. Add tests/examples for source-specific events using existing watchers and fake handlers.
3. Factor common event/handler prompt construction if another source needs it.
4. Coordinate with `pi-intercom` for an inbound message hook rather than making `return_on` poll intercom state.
5. Only introduce a separate shared package/store if at least two extensions need to write handler runs directly.

## Open questions

- Should the shared ledger live in `pi-return-on`, `pi-intercom`, a new extension, or Pi core?
- What API should source extensions call to route an event?
- Should handler runs be visible in one global `/background-handlers` UI or source-specific commands like `/return-on-handlers`?
- How should ask-timeout behavior be represented when a fork handler is answering an intercom ask?
- Should event envelopes be written to observational memory in addition to local state?
