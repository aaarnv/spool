# Plan Spool examples

Four worked sequences for the Plan Spool workflow in [SKILL.md](SKILL.md): a new feature, a
risky change, an ambiguous request, and an agent handoff. Each one gives the prompt you were
given, the commands in order, and **the point where you stop and hand back to the human**.

Every packet quoted here is a real fixture in the spool repo under
`test/fixtures/skill/<example>/`, and `npm test` replays the offline half of each sequence
(`test/skill-examples.test.mjs`). The packets validate with `--strict` and generate a clean
script, so copying their shape is safe.

The examples share one product for continuity: a coaching app whose cards a coach wants to
dismiss.

---

## 1. New feature

> **Prompt:** "Add a way for a coach to dismiss a coaching card for good."

Clear request, ordinary risk. The plan exists so the reviewer can check the shape of the
data before it is written, not because the change is dangerous.

```bash
# 1. Ask the gate first. Declare the files, because they do not exist yet.
spool gate check --paths web/app/coach/CoachingCard.tsx web/app/coach/feed.ts --json
#    → "decision": "warn", "reasons": ["plan_missing"], exit 0.
#      Advisory lets you proceed, but a reviewer would rather see the shape of the
#      data before it is written, so write the plan.

# 2. Scaffold the packet.
spool plan init dismiss-pill \
  --goal "Let a coach dismiss a coaching card for good." \
  --task SPL-101 \
  --outcome "A card a coach dismisses stays dismissed, on every device and after a re-login."

# 3. Author it: replace every TODO:, point the evidence at real files, then validate.
spool plan validate spool/dismiss-pill --strict
#    → valid — 0 error(s), 0 warning(s).

# 4. Generate the narration and the driver.
spool plan generate spool/dismiss-pill --steps --url http://localhost:3000/coach
#    → plan script: 5 chapters, ~69.2s (voice: direct-technical, visuals: product-forward)

# 5. Record and publish.
spool plan build spool/dismiss-pill
```

The packet (`test/fixtures/skill/new-feature/plan.json`), trimmed to the parts that carry
the decision:

```jsonc
{
  "goal": "Let a coach dismiss a coaching card for good.",
  "outcome": "A card a coach dismisses stays dismissed, on every device and after a re-login.",
  "approach": [
    {"id": "record", "summary": "Store one dismissal row per coach and card, written when the coach dismisses it.",
     "chapterId": "approach", "evidence": ["ev-card"]},
    {"id": "filter", "summary": "Filter dismissed cards out of the coaching feed query.", "chapterId": "approach"},
    {"id": "undo",   "summary": "Offer an undo for ten seconds, so a mis-click is not permanent.", "chapterId": "approach"}
  ],
  "alternatives": [],
  "noAlternativesReason": "No credible alternative: the feed already reads per-coach state, so a dismissal row is the same shape as the data beside it.",
  "decision": {"type": "approval",
               "prompt": "Approve storing dismissals per coach, with a ten-second undo.",
               "options": ["approve", "redirect", "ask-question"]}
}
```

**STOP HERE.** Report the watch link. Do not start the branch.

When the human decides:

```bash
spool read spool/dismiss-pill --plan --json
#    → "status": "approved", "nextAction": {"action": "start_implementation", …}

spool gate run -- npm run test:coach       # the gate records the start against the plan
# ... implement the three approach steps ...

# Close the loop: record the work running, and enumerate what it verified.
spool reply https://spoolkit.dev/l/<id> --kind proof --verifies all \
  --approach record --dir spool/proof-dismiss-pill \
  --summary "A dismissed card is still gone after a re-login."
spool live spool/proof-dismiss-pill --url http://localhost:3000/coach
spool publish spool/proof-dismiss-pill
```

---

## 2. Risky change

> **Prompt:** "Dismissals need to survive a re-login, so move them out of the profile blob
> and migrate the existing ones."

A migration on a table the login flow writes. The gate blocks this before any code exists,
which is the point.

```bash
# 1. The gate is the first command, not the last.
spool gate policy
#    → policy: required (repo)
#      config: /repo/spool.config.json
spool gate check --paths web/db/migrations/0021_dismissals.sql --command "npm run db:migrate"
#    → spool gate: BLOCKED — `npm run db:migrate` may not run yet.
#        policy     required (repo)
#        reason     the active plan is not approved yet
#      exit 1. Do NOT pass --bypass. Write the plan.

spool plan init dismissals-table \
  --goal "Move card dismissals into their own table, so they survive a re-login." \
  --task SPL-102
spool plan validate spool/dismissals-table --strict
spool plan generate spool/dismissals-table --steps --url http://localhost:3000/coach
spool plan build spool/dismissals-table
```

Two things a risky packet must carry that an ordinary one need not
(`test/fixtures/skill/risky-change/plan.json`):

```jsonc
{
  // The alternative you rejected, offered to the reviewer as a real option.
  "alternatives": [
    {"id": "profile-column",
     "summary": "Keep dismissals on the profile, in a column login never rewrites.",
     "tradeoffs": ["No migration and no backfill", "The profile row grows with every card"]}
  ],
  // Risks that name the cost, with evidence a reviewer can open.
  "risks": [
    {"claim": "The backfill locks the profiles table while it copies.",
     "evidence": ["ev-migration"], "chapterId": "risks"},
    "A dismissal written during the cutover is lost."
  ],
  "decision": {"type": "approval",
               "prompt": "Approve the dismissals table, or send it back for the profile column.",
               "options": ["approve", "alternative:profile-column", "redirect", "ask-question"]}
}
```

**STOP HERE.** The reviewer redirects: "do the backfill in batches, and keep a dual write
through the cutover."

```bash
spool read spool/dismissals-table --plan --json
#    → "status": "redirected", "decision": {"notes": "do the backfill in batches …"},
#      "nextAction": {"action": "revise", …}
```

That is a change to `approach` and `risks`, so it is **material**: the video no longer argues
the plan. Edit the packet, re-record, and publish revision 2 against the new recording. The
plan keeps one watch link, and the reviewer sees the delta above the decision buttons.

```bash
spool plan validate spool/dismissals-table --strict
spool plan generate spool/dismissals-table --steps --url http://localhost:3000/coach
spool plan build spool/dismissals-table
spool read spool/dismissals-table --plan --json
#    → "revision": 2, "changeSummary": "Revision 2 changes 2 approach steps and 1 risk. …"
```

Only once that reads `approved` does the migration run:

```bash
spool gate run --paths web/db/migrations/0021_dismissals.sql -- npm run db:migrate
```

---

## 3. Ambiguous request

> **Prompt:** "Dismissals are annoying people. Make them better."

Two credible readings, and the tickets do not say which. **Do not pick one.** The plan's job
here is to make the human choose, so the decision is a `selection` and the alternatives are
the options.

```bash
spool plan init dismissal-shape \
  --goal "Decide what \"better dismissals\" means before any of it is built." \
  --task SPL-103
spool plan validate spool/dismissal-shape --strict
spool plan generate spool/dismissal-shape --steps --url https://linear.app/acme/issue/SPL-103
spool plan build spool/dismissal-shape
```

The shape that makes it a choice (`test/fixtures/skill/ambiguous-request/plan.json`):

```jsonc
{
  "goal": "Decide what \"better dismissals\" means before any of it is built.",
  "approach": [
    {"id": "chosen-reading",
     "summary": "Build whichever reading you pick below, and nothing else in this round.",
     "chapterId": "approach"}
  ],
  "alternatives": [
    {"id": "sticky", "summary": "Sticky: the card never returns.",
     "tradeoffs": ["A mis-click is permanent."]},
    {"id": "snooze", "summary": "Snooze: the card returns after a week.",
     "tradeoffs": ["The repeats return, a week apart."]}
  ],
  "decision": {"type": "selection",
               "prompt": "Choose sticky dismissals or a one-week snooze.",
               "options": ["alternative:sticky", "alternative:snooze", "ask-question", "needs-input"]}
}
```

**STOP HERE.** A `selection` plan you answer yourself is not a plan.

The reviewer asks a question instead of choosing, and the plan comes back `needs_input`:

```bash
spool read spool/dismissal-shape --plan --json
#    → "status": "needs_input",
#      "nextAction": {"action": "answer_questions", …},
#      "openQuestions": [{"id": "q_01H…", "body": "How many of the eleven tickets are repeat dismissals?", …}]
```

Answer it where it was asked. A number belongs in a text reply; a thing you have to show
belongs in a recording:

```bash
spool reply https://spoolkit.dev/l/<id> --questions
#    → q_01H…  [open] (approach Build whichever reading you pick below.) How many of the eleven …

spool reply https://spoolkit.dev/l/<id> --kind answer --question q_01H… \
  --dir spool/answer-repeat-count \
  --summary "Nine of the eleven are the same card dismissed twice or more."
spool live spool/answer-repeat-count --url https://linear.app/acme/issue/SPL-103
spool publish spool/answer-repeat-count
```

The answer opens on the moment the question was asked. Then read the plan again and wait for
the selection. You still do not choose.

---

## 4. Agent handoff

> **Prompt:** "Another agent left a plan at https://spoolkit.dev/l/kQ7m2xR9pL4vN8tB. Pick it
> up."

You did not write this plan, so read it before you believe anything about it. One command
gives you the status, the caveat, and what you are allowed to do.

```bash
spool read https://spoolkit.dev/l/kQ7m2xR9pL4vN8tB --plan --json
```

Branch on `nextAction.action`, never on your own reading of `status`:

| `status` | `nextAction.action` | What you do |
|---|---|---|
| `approved` | `start_implementation` | Check the gate, then implement the approach as written. |
| `awaiting_decision` | `await_decision` | Stop. Report the watch link. |
| `needs_input`, `redirected` | `answer_questions`, `revise` | Stop, unless you are the plan's agent. |
| `implementing` | `mark_proved` | Finish, then publish a proof reply. |
| `draft`, `unknown` | `publish_plan`, `none` | Stop. Neither is an approval. |

The handoff often arrives as a travelling `share/` bundle rather than a link. Read it
offline, and read the refusal literally:

```bash
spool read ./share --plan --offline
#    plan: unknown
#    next: none
#      The decision status could not be read, so this plan must not be treated as approved.
```

The gate says the same thing, with an exit code you can branch on:

```bash
spool gate check --plan ./share --policy required --paths web/db/migrations/0021_dismissals.sql
#    → BLOCKED … reason: the plan status could not be read, so it is treated as not approved
#      exit 1
```

An unreachable host is not an approval. Report what you found and ask for a reachable link.

When it does read `approved`, carry these forward — they are the handover, not the video:

- **`approach[].id`** — implement those steps, under those ids. A proof reply names one.
- **`decision.notes`** on an `approved_with_notes` decision — a caveat you must honour.
- **`assumptions`** — if one is false in your checkout, that is a redirect, not a detail.
- **`evidence[].ref`** — what the other agent actually read, pinned to a commit.

Then work, and say so on the plan:

```bash
spool gate run --plan https://spoolkit.dev/l/kQ7m2xR9pL4vN8tB -- npm run db:migrate
# ... implement ...
spool status https://spoolkit.dev/l/kQ7m2xR9pL4vN8tB --verdict on_plan --done backfill \
  --next "Run the cutover behind the flag."
# The cutover shipped without the read-path switch, so the proof says so as a field.
spool reply https://spoolkit.dev/l/kQ7m2xR9pL4vN8tB --kind proof --approach cutover \
  --verifies outcome --verifies table,backfill \
  --verifies cutover:partial="writes cut over; reads still hit the old column" \
  --deviation approach:cutover="The read switch waits for a full backfill verification." \
  --summary "Dismissals survive a re-login on staging."
```

Record each of those, then publish it. One status at the milestone, one at a blocker, one
when the work needs a new decision — never one per commit. If the plan stops holding, say
so in the verdict rather than in a note nobody reads:

```bash
spool status https://spoolkit.dev/l/kQ7m2xR9pL4vN8tB --verdict blocked \
  --blocked "The staging replica lags 40 minutes, so the backfill cannot be verified." \
  --next "Ask for a decision: cut over anyway, or wait for the replica."
```

---

## The one rule under all four

You may record a proposal, read a decision, and act on an approval. You may never decide.
When the packet needs a fact you do not have, when the request has two readings, or when the
status is anything but `approved` or `implementing`, the deliverable is the watch link and
the question — not a branch.
