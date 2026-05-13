# Inbound Intercom Fork Channel

This design covers a future channel where inbound `pi-intercom` messages can immediately open a background fork handler with delegated authority.

## Problem

Intercom messages can arrive while a parent session is busy. Some asks are large, but only require a small answer that is derivable from context, repo state, or prior user instructions. Interrupting the parent for every message wastes attention and can block the sender longer than necessary.

## Recommended ownership

The inbound message hook should live in **`pi-intercom`**, not `pi-return-on`.

Reasons:

- `pi-intercom` owns peer/session discovery, message threading, pending asks, reply routing, and timeout semantics.
- `return_on` owns condition watchers and fired watcher delivery.
- Both can share the same background event envelope and handler-ledger pattern described in [Background Event Router and Handler Ledger](./background-event-router.md).

`pi-return-on` should not poll or inspect intercom inbox state directly. If a shared router is factored later, both extensions can call it.

## Message routing model

```text
intercom message arrives
→ pi-intercom classifies send vs ask, priority, target session
→ create background event envelope
→ route by policy
→ optional fork handler replies/summarizes/escalates
```

## Event types

- `intercom.message` — non-blocking `send` message.
- `intercom.ask` — sender is blocked waiting for a reply or timeout.
- `intercom.thread_update` — optional follow-up on an existing thread.

## Envelope payload

```ts
interface IntercomEventPayload {
  messageId: string;
  threadId?: string;
  action: "send" | "ask";
  from: string;
  to: string;
  body: string;
  attachments?: Array<{ type: string; name: string; path?: string; content?: string }>;
  replyDeadlineAt?: number;
  senderIsBlocked: boolean;
}
```

## Delegated authority

Default fork-handler authority should be delegated, not notify-only.

The handler may answer directly when the needed response is derivable from:

- the inbound message
- the parent/session snapshot or capsule
- repo files and local artifacts
- prior user instructions and accepted project decisions
- completed tool/subagent outputs available to the handler

Escalate to parent only for:

- destructive actions
- ambiguous user preference
- external side effects
- security/privacy/cost risk
- conflict with current parent work
- low confidence

## `send` behavior

`intercom.send` is fire-and-forget, so handler routing can be relaxed:

1. For low-priority routine updates, record/audit only or summarize later.
2. For actionable but non-urgent messages, open a fork handler.
3. Handler may respond with `intercom.send` if useful, but does not need to block the parent.
4. Parent receives at most a compact summary unless the event is important.

## `ask` behavior

`intercom.ask` blocks the sender, so the handler must minimize delay:

1. Open a fork handler immediately when policy allows.
2. Handler answers directly if safe and derivable.
3. If not safe, handler escalates to parent quickly with the smallest possible question.
4. If parent cannot be reached before the deadline, handler should reply with a clear timeout/blocker message when appropriate.

The fork must not leave the sender blocked while doing unrelated work.

## Handler prompt requirements

An intercom fork handler prompt should include:

- message/thread id
- sender and intended parent target
- whether the sender is blocked
- reply deadline/timeout if any
- exact inbound body and attachment references
- delegated-authority policy
- explicit instruction to answer directly when safe
- escalation boundaries
- final summary/audit format

Suggested final audit summary:

```text
Handled intercom ask <message-id> from <sender>:
- Asked: <one-line summary>
- Answered/escalated: <what happened>
- Basis: <context/files/decision used>
- Parent action: none | decision needed | follow-up suggested
```

## Routing defaults

| Incoming event | Default | Parent interruption |
| --- | --- | --- |
| Low-priority `send` | record/display or fork summary | No |
| Actionable `send` | fork handler | Summary only |
| Routine `ask` | fork handler with answer authority | No if answered |
| Risky/ambiguous `ask` | fork handler then parent ask | Yes, smallest question |
| Urgent/security ask | direct parent wake or ask | Yes |

## Implementation sketch in `pi-intercom`

1. Add configuration for inbound fork routing:

```json
{
  "intercomForkHandlers": {
    "enabled": true,
    "send": "auto",
    "ask": "auto",
    "notify": "summary",
    "escalateUrgent": true
  }
}
```

2. On inbound message, build the background event envelope.
3. Launch a sibling Pi handler using the same pattern as `return_on`:
   - per-handler directory
   - `event.json`
   - `prompt.md`
   - stdout/stderr/session artifacts
   - `--append-system-prompt` guard
4. For asks, provide the handler a reply capability or a structured result that `pi-intercom` uses to reply.
5. Track handler runs in a source-specific or shared ledger.
6. Add `/intercom-handlers` or a shared `/background-handlers` status command.

## Relationship to `return_on`

No immediate `pi-return-on` code change is required. The useful change already made here is the delegated-authority prompt/policy for fork handlers and the shared router design doc. Future extraction can factor common launcher/ledger code if `pi-intercom` implements this channel.

## Open questions

- Should an ask-handler reply directly through `intercom.reply`, or return a structured reply to `pi-intercom` for sending?
- How much of the parent transcript should an intercom fork inherit by default?
- Should urgent asks bypass fork routing entirely?
- Should users be able to opt specific peers/threads into or out of fork handling?
- Should handler summaries be written to observational memory in addition to local ledger state?
