# spool-mcp

An MCP server that lets an agent propose a plan, hear what people said about it, and be
stopped by a comment until it acknowledges one.

It is the agent's side of the Plan Spool lifecycle. Everything it does is one call to a
route in [CONTRACTS.md](../CONTRACTS.md) — the draft lane, the decision API, the blocking
comment rule and the event cursor — and it adds exactly two things a raw HTTP client does
not give you:

- **A block you cannot miss.** While a comment on the current revision is unacknowledged,
  every tool that would move work forward answers with the block first, names each steer,
  and prints the exact call that clears it.
- **A cursor that survives.** `await_events` holds open across the platform's 25-second
  long polls and keeps its position on disk, so a restarted server resumes instead of
  replaying the whole history.

And one thing MCP by itself cannot do: **wake an idle agent**. That is `spool mcp watch`.

## Install and configure

The server ships inside the CLI, so there is nothing extra to install.

```bash
npm i -g @spoolkit/cli
spool login                      # or: export SPOOL_TOKEN=spk_...
claude mcp add spool -- spool mcp serve
```

`spool mcp status` prints the host it resolved, whether a token is set, and where the
cursor lives.

<details>
<summary>Configure it by hand (<code>.mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "spool": {
      "command": "spool",
      "args": ["mcp", "serve"],
      "env": {
        "SPOOL_HOST": "https://spoolkit.dev",
        "SPOOL_TOKEN": "spk_..."
      }
    }
  }
}
```
</details>

**Configuration** is the CLI's own resolution order, so the MCP server and `spool publish`
can never disagree about who they are: `SPOOL_TOKEN`, then `SPOOL_PUBLISH_TOKEN`, then
`~/.spool.json`, then the default host. `SPOOL_MCP_HOME` moves the state directory
(default `~/.spool-mcp`).

A missing token does not stop the server from starting — every tool that needs one says so
in its own answer, which an MCP client will show you. A process that exits at launch is a
process whose error message nobody reads.

## Tools

| Tool | Route | What it is for |
| --- | --- | --- |
| `plan_propose` | `POST /api/plans` | Open a plan from a packet alone. Lands in `draft`. |
| `plan_read` | `GET /api/plans/{id}` | The whole state of one plan: status, decision, `nextAction`, `may`, lineage delta, open questions, `blockedBy`. |
| `gate_check` | derived from the read | May I move this plan forward right now? |
| `await_events` | `GET /api/events` | Block until something happens on any plan you own. |
| `ack_comment` | `POST .../questions/{qid}/ack` | Record that you READ a steer. The only call that clears a block. |
| `answer_question` | `POST .../questions/{qid}/replies` | Reply in a thread. Never blocked. |
| `send_message` | `POST .../questions` (`general` anchor) | Say something to the humans on a plan that nobody asked you about. The other half of `answer_question`. |
| `plan_sources` | `POST .../sources` | Store the raw capture; returns the upload grants you must PUT. |
| `plan_record_start` | `POST .../record/start` | `draft → recording`. |
| `plan_render` | `POST .../render` | Have the platform build the video. Returns a `queued` job, not a video. |
| `plan_publish` | `POST .../publish` | Make it watchable, or land revision N+1. |
| `plan_request_decision` | `POST .../request-decision` | `published → awaiting_decision`. |
| `plan_revise` | `POST .../revisions` then `.../publish` | Redraft a plan that came back. Two steps, `step: "open" \| "publish"`. |
| `implementation_start` | `POST .../implementation/start` | `approved → implementing`, carrying the gate policy in force. |
| `proof_submit` | `POST .../implementation/proved` | `implementing → proved`. Terminal. |
| `status_report` | *(no route — see below)* | Scaffold an implementation status spool. |

The draft lane, in order:

```
plan_propose → plan_sources → plan_record_start → plan_render → plan_publish
             → plan_request_decision → (a human decides) → implementation_start → proof_submit
```

`plan_read`, `gate_check` and `await_events` are readable at every point.

**Every answer is two blocks**: a first line of prose that says what happened, and the
platform's payload verbatim as JSON underneath. Nothing is renamed, dropped or tidied —
the payloads are additive-stable and downstream agents branch on their documented fields.

**`status_report` has no route on purpose.** A status is a `kind: "status"` reply, and a
reply is a published child recording; the video is the point. So the tool validates the
report against the live parent plan, refuses one that contradicts itself, writes
`reply.json` and a narration skeleton, and tells you the two commands that finish it
(`spool live <dir>`, `spool publish <dir>`). It never claims a status was published.

## A comment blocks

> comment = steer, decide = approve/redirect, merge = PR. **An agent may not proceed past
> an unacknowledged comment.**

The platform enforces this twice: `nextAction` becomes `acknowledge_comments`, and the
write paths independently answer `409 unacked_comments`. This server's job is that a stock
agent cannot walk past it by accident, so a refusal looks like this:

```
BLOCKED: 1 thread on this plan's current revision has unacknowledged messages, so you may
not start implementation.
Acknowledging is not answering: the ack records that you READ the steer, the question
stays open until you reply to it.
An ack covers a thread only up to its newest message. If somebody adds another one, you
are blocked again.

  1. from the owner on chapter: approach: Use the queue, not a cron.
     then the owner added: Actually no — the batch size is what I meant.
     (2 unacknowledged messages in this thread; one ack covers all of them)
     clear it with: ack_comment { "spoolId": "dL_Hh…", "questionId": "9c927a1a-…" }
     answer it with: answer_question { "spoolId": "dL_Hh…", "questionId": "9c927a1a-…", "body": "…" }
```

A steer is a conversation, so the whole unacknowledged tail is printed and not only the
message that opened it. An agent shown one line of a thread whose last line reverses it
will confidently do the thing it was told to stop doing.

`blocked` is the first key of the JSON object as well as the first word of the prose, so a
client that renders only the head of a result still shows the reason.

The list comes from the refusal itself and from nowhere else. Every lifecycle edge answers
through one response builder, so a 409 that names `unacked_comments` always carries
`blockedBy`; if one ever does not, this server says so and refuses to proceed rather than
reading the list back off the plan. A silent repair would work, and it would also make the
next route that drops the field indistinguishable from one that never had the bug.

**Acknowledging is not answering.** After an ack the plan is unblocked and the questions
are still `open`; `nextAction` becomes `answer_questions`. The ack stops an agent running
past feedback. It must never become a way to declare the feedback handled.

**An ack reaches the newest message and no further.** Ack a thread, reply to it, and the
plan is clear — until somebody adds another message, which blocks it again. That is what
makes steering a conversation rather than one instruction: an ack keyed to the thread would
let every correction after the first through unread.

**Enumerate your options in the packet.** You weighed two or three ways to do the work
before you picked one; put each in `alternatives` as `{id, summary, tradeoffs}` and list
the pickable ones in `decision.options` as `"alternative:<id>"`. The reviewer decides by
tapping an option, so an alternative buried in prose is one they cannot choose, and one
described but left out of `decision.options` renders as context they cannot pick. State
what each COSTS — an option with no stated cost reads as free.

The read payload resolves all of it into `options[]`: the proposed approach and every
alternative in one shape, each with `optionId`, `label`, `summary`, `tradeoffs`,
`recommended`, `selectable` and `chosen`.

**Read `decision`, not just `status`.** Three verbs land on `approved` (`approve`,
`approve_alternative`, `approve_with_conditions`) and two on `redirected`
(`request_changes`, `redirect`), so the status alone no longer says what was decided.
`plan_read` and `gate_check` lead with the verb, the option that WON — by label and
summary, including for a plain `approve`, which names no optionId and means the
recommended option — and whether it carried conditions — which are ordinary steers, and block until acked. A `parked` plan is
on hold, not slowly approving; a `rejected` one is over.

## Waiting, and the cursor

`await_events` loops the platform's 25-second long poll until its own timeout (default 60s,
max 600s) and returns the moment anything lands. An empty answer is a valid one — call it
again.

`from` decides where a fresh follower starts:

- `cursor` (default) — resume from the stored position. With no stored position it replays
  from the beginning, which is the platform's own default and the only start with no silent
  gap in it.
- `now` — anchor at the head. Only what happens next.
- `beginning` — forget the cursor and replay everything.

**Delivery is at-least-once.** Two positions are kept in
`~/.spool-mcp/cursor-<hash-of-host-and-token>`: `committed` is the last page the caller is
known to have taken, `pending` is the page just handed over. A call commits the pending
position and then polls from it, so a normal loop never sees a duplicate — and a crash
between two calls resumes from `committed` and replays exactly the last page. The
alternative loses events on the same crash, and a lost steer is what this stream exists to
prevent.

The file is named by a hash of the host and the token and never contains the token; it is
written `0600` through a temp file and a rename.

## Waking an idle agent

An MCP tool only runs when something is already running to call it. An agent that finished
its turn and went quiet will never see the comment that just blocked it. So the wake lives
outside the protocol:

```bash
spool mcp watch --on '<a command that pokes your harness>'
```

`watch` holds the same cursor, long-polls forever, and hands each event to every configured
sink. By default it wakes on `plan_decision_submitted`, `plan_question_created`,
`plan_question_replied` and `plan_reply_created` — somebody decided, somebody steered,
somebody answered. `--all` delivers every type (the vocabulary is open, so an unknown type
is logged, never dropped silently), and `--type` replaces the default set.

**Sinks**, all additive:

- `log` — stderr. Always on, so a watch is never silent about its own work.
- `command` (`--on`, or `SPOOL_MCP_WAKE_CMD`) — runs a shell command per event. The event
  arrives three ways: as JSON on stdin, as `$SPOOL_EVENT`, and split into
  `$SPOOL_EVENT_TYPE`, `$SPOOL_PLAN_ID`, `$SPOOL_PLAN_URL`, `$SPOOL_EVENT_AT`.
- `notify` (`--notify`, or `SPOOL_MCP_NOTIFY=1`) — a macOS notification. This is the
  fallback, not the mechanism: a notification cannot resume an agent, it can only tell
  somebody to. A no-op off macOS.

**The cursor advances only after every sink accepted.** A sink that throws leaves the
position where it was and the batch is retried on the next poll. A wake delivered twice
costs one wasted read; a wake lost costs the steer it was supposed to stop for.

A first start anchors at the head rather than replaying the history — a wake per row of
everything you ever did is not a wake.

### Wiring it to a Claude Code session

Pin a session id, then have the watch daemon re-prompt that exact session:

```bash
SID=$(uuidgen | tr 'A-Z' 'a-z')

# The session that does the work. It keeps its context across every wake.
claude --session-id "$SID" -p "You own spool plan <id>. Call gate_check and act on it."

# The daemon that pokes it.
spool mcp watch --on "claude --resume $SID -p \
  'A spool event arrived: \$SPOOL_EVENT. Call gate_check on plan \$SPOOL_PLAN_ID and act on it.' \
  < /dev/null"
```

`--resume` keeps the session's context, so the woken agent already knows what it proposed
and why. Redirect stdin (`< /dev/null`) or Claude Code will read the event JSON the sink
writes there as its prompt input; use `$SPOOL_EVENT` instead.

Two notes worth having:

- **This does not loop.** The agent's own acks and replies are not wake types, so acting on
  a wake does not cause another one.
- **Run one watch per token.** Two daemons sharing a cursor file will each deliver part of
  the stream and neither will have all of it.

## Verified

Against a real local platform (`next dev` on a throwaway Neon branch, MCP over stdio,
every agent-side call through the protocol):

```
── 01. the agent proposes a plan ───────────────────────────────────
agent> plan_propose
       plan SVmTTJdmDQDu4ylQkTcqGQ opened in draft at revision 1.

── 04. the agent walks the draft lane to a decision request ────────
agent> plan_record_start → recording
agent> plan_publish      → published
agent> plan_request_decision → awaiting_decision

── 06. the agent goes to sleep on the event stream ─────────────────
── 07. the reviewer approves, in a session the agent could never hold
── 08. await_events delivers the decision ──────────────────────────
agent> await_events returned after 5.3s over 1 poll(s)
       1 event after 5.3s: plan_decision_submitted
       event plan_decision_submitted actor=owner payload={"type":"approve",…}

── 09. the reviewer leaves a comment — a steer ─────────────────────
── 10. the agent checks the gate and finds itself blocked ──────────
       mayProceed=false blockingCount=1
── 11. the agent tries to start work anyway and is refused ─────────
       isError=true reason=unacked_comments blockedBy=1
       (the 409 carries the list itself — nothing here re-reads the plan to fill it in)
── 12. the agent acknowledges the steer ────────────────────────────
       acknowledged. Nothing is blocking this plan now. The question is still OPEN.
── 13. now the work may start ──────────────────────────────────────
       the plan is now implementing at revision 1.

── 17. the cursor resumed: everything since the decision, exactly once
       plan_question_created, plan_comment_acked, implementation_started,
       plan_question_replied, plan_marked_proved
```

And the wake story, with a real Claude Code session that had nothing but this MCP config:

```
[wake] plan_question_created plan=V2SQqMv3l2IIyC7Ld4e-0w — the owner commented — it blocks
       until you acknowledge it
woken agent> Acked all 3 blocking comments on the "approach" chapter … nothing blocks now,
             but all three questions remain open until answered.
[watch] skipped plan_comment_acked (not a wake type)
```
