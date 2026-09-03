# Bake-off scripts — four modes, four real chains

Every line was read aloud before it went in. Bar: a high schooler follows it
cold, and a person would actually say it in conversation. Visual directions in
brackets. Target 60–90s each at spoken pace.

---

## 1. SPL-41 — POV story (a plan asking for approval)

The agent makes its case first-person.

[cold open: a phone showing the dashboard — no hint anything is waiting]

"Right now, if one of your agents is waiting on a decision, there's exactly
one way you'd know: somebody sends you the link. Lose the link, and the agent
waits forever."

[cut: mockup of the "Needs you" list dropping onto the dashboard]

"I'm the dashboard agent. I want to put a list at the top: every plan waiting
on you, newest first, with how long it's been sitting there. Tap one, decide,
done."

"Here's why this is cheap. The database query I need already exists in the
code — someone built it and nobody ever wired it to the page. So: no new
database work, no new plumbing. I'm reusing a part that was already there."

[risk beat: red tint, the dashboard load bar]

"What could go wrong: the dashboard is the first page everyone sees. If my
list is slow, every single load gets slower. So I'm riding along with the
page's existing load — one more query next to the ones it already runs."

"There are two bigger versions of this. One shows the actual question each
plan is asking — needs a heavier query. One also shows plans you've been
invited to decide, not just your own — needs a database change. I'd start
small and earn those."

[the decision card slides up]

"So the ask: an inbox for your own plans, made of parts that already exist.
Say yes — or tell me which bigger version you want instead."

---

## 2. SPL-54 — Commentary (a deviation, the house character reacting)

Character on the rail, footage/diagrams full-bleed. Reactions are the triage.

[cold open: character leaning in]

"This agent got caught. And what it did next is the whole reason this app
exists."

"Backstory: nothing tells you when a plan is waiting for you. You find out by
opening a link. So this agent's job was simple — the moment a plan starts
waiting, ping the owner. Slack, Discord, whatever you've set up."

[footage: the test run, the delivered ping]

"It builds it. Tests pass. Ships the proof. Looking good."

[record scratch. character squints]

"Then the reviewer bot asks one question: what happens when a plan gets
*revised*?"

"Turns out — revised plans told nobody. Which is the exact moment you'd most
want the ping. You asked for changes. The changes came back. Silence."

[footage: the second fix, both paths lighting up]

"So it went back and fixed both paths. And then it told on itself. The change
it made that *wasn't* in the approved plan? Filed. On the record. Two
functions changed shape, you never approved it, and the robot is the one
telling you."

[character, deadpan]

"Honest robot. Approve the work, or send it back again — your call, right
here."

---

## 3. SPL-49 — Broadcast (a proof; the thing running is the star)

Fast cuts, kinetic type, no persona on screen. Narrator minimal.

[cold open: the real PR page, check spinner running]

"This is a robot getting its permission slip checked. Live. On a real pull
request."

"The rule: every time an agent opens a PR, one check runs and asks one
question — did a human approve a plan for this work?"

[the check completes; zoom on the verdict comment]

"PR eleven. Check runs. Verdict lands right on the page: warning — no plan on
file."

"It warns. It doesn't block. That's on purpose — this week every repo is in
warn-only mode. See how it feels first. Flip one setting, and warnings become
walls."

[receipt montage: timer, the comment, the merge button still green]

"The receipt: under a minute, verdict visible to everyone, and the merge
button still works. That's the proof. Done."

---

## 4. SPL-47 — Ambient mode (CLI work, nothing to show)

One satisfying ambient loop full-bleed. Kinetic captions carry key phrases.
Narrator carries everything else.

[ambient loop starts. caption: "an agent asked permission to delete code"]

"An agent asked permission to delete some code — and while it was *asking*,
it found three bugs in the tool it was using to ask. Stay with me."

"The problem it wanted to fix: the same rule was written in two places, in
two different programming languages. It's the rule that decides where the
chapters land in these videos. And two copies of one rule always ends the
same way — they drift apart. These two already had, once."

[caption: "one copy is the truth"]

"The fix: keep one copy as the truth. Generate the second one from it. And
add a test that fails the second they ever disagree."

"And while it was recording the video to ask permission — the narrator
glitched. The video literally said the words 'object Object' out
loud. A bug was turning a risk description into gibberish. So the agent fixed
that. Then found a second bug hiding behind it. Then a third behind that one."

[caption: "600 tests pass"]

"Everything passed — six hundred tests. And the chapters in this video land
exactly where they're supposed to. Which is itself the proof that the fix
works."

"One rule. One copy. And a tripwire if they ever disagree again."
