# Requests: asks for changes, triaged by mevo, sent to a lane by you

**Status: built (2026-11-12).** All four phases; the automatic rules of phase 5 are not.
How to use it is in [how-it-works.md](../how-it-works.md#requests).

## The problem

People ask for changes on your tickets in four places:

- a Linear comment;
- a PR review or a PR comment (QA, a teammate, Greptile);
- a Slack thread or DM;
- a Linear thread synced to Slack.

Today mevo already handles the GitHub ones: Analyze, then fix with the lane or a quick fix. The
rest you read yourself, decide whether it makes sense, and turn into an instruction for the
lane by hand. At night nobody answers in Linear at all.

## What it does

1. **mevo reads every new message about your tickets**, wherever it lands, and decides what it
   is: a change request, a bug found in QA, a question, an approval or nothing to do.
2. **A change request or a bug becomes a Request.** A Request is a card with:
   - who asked, where, and the quote;
   - mevo's read of it;
   - the instruction it would give the lane.

   Nothing runs yet.
3. **Requests wait in their own column on the board** until you look. You send them to the
   lane, edit the instruction, answer, or decline.
4. **At night, mevo answers in the Linear thread** the way Night Shift already answers on Slack.
   A change request gets "got it, Sam will look at it in the morning", and its Request is waiting
   in the column when you wake up.
5. **When the lane is done and pushed**, mevo replies in the thread where the request came from:
   "Addressed in `abc1234`". It replies in Linear, Slack or GitHub, and only after you approve.

## Sources

| Source | How mevo sees it | Notes |
|---|---|---|
| Linear comments on your tickets | `humanComments` per ticket, polled while the ticket is open (running, review ready, PR draft, in review) | New. Comments posted by mevo and by bots are left out, as today. |
| Linear mentions of you | Linear notifications (`mentionedPrs` already reads them) | Covers issues that aren't on your board yet. |
| GitHub PR reviews and comments | pr-sync, as today | Human comments that ask for a change become Requests. Today's Analyze flow stays; it's the same request with a different entry point. |
| Slack | the mentions Night Shift and Today already read | Only when the message points to a ticket or PR on your board, through a link, an id or a synced thread. |

The same ask can arrive twice: a Linear thread synced to Slack, or a QA note on both Linear and
the PR. mevo keeps one Request and lists both sources on it.

## Reading a message

There is one cheap read-only call per new message (the readiness engine, Sonnet or Haiku, about
$0.01). It gets the message, the thread it's in, and the ticket's brief and acceptance criteria.
When the ticket has a PR, it also gets the diff stat and the PR body. It answers with JSON:

```json
{
  "kind": "change | bug | question | approval | fyi",
  "ticket": "ENG-42",
  "ask": "Remove the 'This total is an estimate' line under You pay",
  "read": "makes sense | check | out of scope",
  "why": "design asked for no extra lines under the receipt",
  "instruction": "In the checkout summary, drop the estimate note under 'You pay'; keep the warning above the button. Update the stories.",
  "size": "quick | lane",
  "reply": "makes sense, queued for the morning"
}
```

- **Change and bug** become Requests.
- **Question** goes down Night Shift's path: answered from what mevo knows, or held for you.
- **Approval and fyi** only show in the morning handoff.
- **Read "out of scope"** offers **New ticket** instead of Send to lane, with the ask as the
  description, created in Linear.
- **The message text is data, not instructions.** It goes into the prompt inside a data tag, the
  same as Linear comments in the brief today.

## The Requests column

It is a new column, after Assigned. Its cards are requests, not tickets: one card per request,
grouped under the ticket when there are several.

```
ENG-42 · Checkout total                                     2 requests
┌─────────────────────────────────────────────────────────────────┐
│ Ana · Linear comment · 7h ago                          bug  ●  │
│ "the 'This total is an estimate' line should go…"               │
│ mevo: makes sense: design asked for no extra lines              │
│ Instruction ▸ Drop the estimate note under You pay…  (editable) │
│ [Send to lane] [Quick fix] [Reply] [Decline] [New ticket]       │
└─────────────────────────────────────────────────────────────────┘
```

- **Send to lane** and **Quick fix** use `runner.instruct` (it already queues an instruction when
  the lane is busy). The instruction carries the quote and the link. Images in the comment, such
  as QA screenshots, are downloaded into `feedback/` as today.
- **Send all** sends every open request on that ticket as one instruction, in one run.
- **Reply** posts your answer in the source thread. **Decline** does the same with a reason, and
  closes the card.
- **The ticket's card** shows a "2 requests" chip. Today and the morning handoff list them.
  Telegram gets "2 new requests on ENG-42", with an Open button.

After a run, the card moves to **sent**, then **done** once the commit is pushed and the reply
is posted. Done cards drop off after a day, and stay in the ticket's journal.

## Night Shift in Linear

It uses the same classes as Slack: info, fact, decision, action and urgent, plus the new change
and bug.

| Kind | At night |
|---|---|
| fact | answered from your tickets and PRs, as on Slack |
| change, bug | a Request, plus "got it, Sam will look at it when they're back (~07:30)" |
| decision, action | held for you: "Sam will answer this in the morning" |
| urgent | wakes you on Telegram, as on Slack |

**Threads.** The reply goes under the comment it answers, in the same thread, through Linear's
`commentCreate` with `parentId`.

**Who it posts as.** The Linear API key is yours, so a reply would show up as you. There are two
options:

- **As you, with a label** (like `dmAsMe` on Slack): "🤖 mevo, Sam's assistant: Sam is offline
  until ~07:30." It works today with no setup.
- **As a mevo app user.** This needs a Linear OAuth app with `actor=app`. It's cleaner, but needs
  a one-time setup in the workspace, and probably an admin.

Decided: the first. The second stays for later.

**A new setting**, `nightShift.linear`: `off`, `draft` or `post`.

- `draft` is the default. The replies wait in the handoff, as Slack's do today.
- `post` sends facts and acks by itself, the same as Slack's facts mode.

**Synced threads.** When a Linear thread is synced to Slack, the comment arrives in both places
(Linear shows its author as "Slack"). mevo answers once, where the message was written.

## Phases

1. **The Request and the column.** This covers:
   - the shared `Request` type and the store;
   - the API routes `GET /api/requests`, `POST /api/requests/:id/send|quick|reply|decline|ticket`;
   - the column, the ticket chip and the Today line.

   You can already make one by hand from any PR comment.
2. **Sources and the read.** This covers:
   - the Linear comments poll for open tickets;
   - GitHub human comments from pr-sync;
   - Slack mentions that point to a ticket;
   - the classifier call and merging duplicates.
3. **Closing the loop.** The "Addressed in" reply in the source thread, which you approve or which
   posts by itself, and the card going to done.
4. **Night Shift in Linear.** The thread replies (with `parentId`), the `nightShift.linear`
   setting, and Linear in the morning handoff.
5. **Later.**
   - Rules for sending by itself, for example a quick change from a reviewer that "makes sense"
     on a ticket with an open PR. Off by default.
   - The mevo app identity in Linear.
   - Requests on PRs you review for others.

## Where it goes in the code

| Where | What |
|---|---|
| `packages/shared` | `Request`, `RequestSource`, `RequestRead`; `Ticket.requests` counts |
| `apps/daemon/src/requests.ts` | new: intake from the three sources, classify, merge, actions |
| `apps/daemon/src/linear.ts` | `comments(uuid, since)` with ids and parents; `reply(uuid, parentId, body)` |
| `apps/daemon/src/nightshift.ts` | a Linear path next to the Slack one |
| `apps/daemon/src/pr-sync.ts` | hands new human comments to requests |
| `apps/daemon/src/runner/index.ts` | `instruct` gets the source, so the run knows what to reply to |
| `apps/web/src/components/Requests.tsx` | the column and the cards |

## Decided (2026-11-12)

1. **In Linear at night, mevo posts as you with the label.** The mevo app identity stays for later.
2. **Requests get their own column**, after Assigned.
3. **All three sources go in the first version:** Linear comments, PR reviews and QA, and Slack.
