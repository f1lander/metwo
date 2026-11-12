# Let the AI write the test, let a program run it

*How a Linear ticket becomes a reviewable PR in mevo, and what we changed about the part where an
AI checks its own work in a browser.*

---

> **Update:** after more real runs we paused steps mode. Scripted steps kept breaking on the app's
> own state (a wallet that was already connected, for one), so the lane takes the screenshots again
> and the steps live on in Test by hand. The rest of this post still describes how mevo works.

Most of the web team works while I sleep. By the time I start my day, the questions, reviews and
decisions from the last eight hours are waiting, and whatever I ship has to be reviewable by
people who will look at it while I'm offline. That's the reason mevo exists. It's a local
pipeline that takes the Linear tickets assigned to me and carries each one to a draft PR that a
teammate can review in one sitting.

This post walks through how it does that, phase by phase. Then it goes into a change we just made
to one of those phases: instead of letting the AI click around the app to prove its work, we ask
it to write the test, and a plain program runs it.

## A ticket's trip

Every ticket gets its own git worktree, its own branch named after the Linear issue, and its own
port, so several can run side by side without stepping on each other. From there:

**1. Intake.** mevo watches Linear and sizes each new ticket into a small ("lite") or a full
lane. A cheap model reads the ticket and its discussion and says whether it's ready to start,
needs clarification, or should wait. Autopilot can start small, clear tickets by itself; anything
bigger, urgent or sensitive waits for me.

**2. Implement.** The lane works from a brief that mevo writes:

- the ticket and its Linear comments;
- Figma frames and linked Slack threads;
- the team's docs and the repo's own rules (CLAUDE.md, the style guide, the Greptile rules);
- review feedback from past PRs on similar code;
- a size target, because a 900-line PR is not reviewable.

It commits locally and never pushes. When it needs a decision, it stops and asks, with the options
as buttons.

**3. Review and gates.**

- A second pass reads the diff with the team's review lenses and fixes what it finds.
- mevo re-runs typecheck, lint and tests itself instead of trusting the lane.
- A supervisor, by default a model from another vendor, checks each acceptance criterion against
  evidence. Every serious finding has to come with proof: a failing test, a repro, the command and
  its output. Concerns without proof don't send the work back for another paid round.

**4. Before the PR.** mevo runs locally what CI would run: the gates, then the e2e specs related to
the change, on a local Anvil fork with a headless wallet. Red keeps the PR closed until it's fixed,
or until I push anyway.

**5. PR.** The draft PR opens with a description in the team's template: summary, before and
after, a review guide, screenshots, verification checklists, a regression section, what needs
human testing. Greptile is asked to review. **Ready for review is always my button**, never
mevo's.

**6. Follow-ups.** Review comments, Greptile findings and failing CI come back to a lane or to a
small "quick fix". Replies go into the threads, and reviews are re-requested.

The longer version, with what each phase reads and writes, is in
[how-it-works.md](../how-it-works.md). The one idea that runs through all of it: **the AI does the
work, and the pipeline makes the work checkable**, by itself, by another model, by the gates, by
CI and finally by people.

## The problem with "I checked it in the browser"

A UI change isn't done until someone has looked at it. So the lane looks: it opens the app through
a browser tool, clicks to the changed screen, takes before and after screenshots at two
viewports, records a short video and writes down what it verified.

It worked. It was also the part of the pipeline we liked least:

- **Too much evidence.** Recent tickets had 15 to 48 screenshots each. Reviewers don't need 48
  screenshots. They need the three that prove the change works.
- **Videos nobody wanted to watch.** They were whatever the AI happened to click, at real speed,
  page loads included, with no hint of what each moment was checking.
- **Expensive looking.** Every time the AI looks at a page, the page goes into its context: a few
  thousand tokens for a screenshot, often far more for the page's structure. A fix round that
  retakes the screenshots pays it all again.
- **Nothing to reuse.** When I sat down to test the ticket by hand, I started from nothing.

The first fix was simple: rules. Plan the screenshots from the acceptance criteria, 8 at most,
mobile only when the layout changes, before shots only for states that actually look different,
video only when a still can't show the change, and only the screenshots the verdict refers to go
into the PR. That alone cut the noise. But the AI was still doing the clicking.

## Write the steps, run the steps

In **steps mode**, the lane does what a good engineer does before handing over a UI change: it
writes down how to test it. Three to eight steps, each with a route, a few lines of Playwright,
what should be on screen, how to tell it worked, and whether to take a screenshot there:

```json
{
  "title": "Open the renew modal on a name in grace",
  "go": "/test-grace.eth",
  "do": "await page.getByRole('button', { name: 'Renew' }).click()",
  "expect": "One expiry banner, under the title",
  "check": { "kind": "text", "value": "Renew test-grace.eth" },
  "shot": { "viewports": ["desktop"], "before": true }
}
```

Then mevo, which is a program and not a model, runs those steps:

- the app runs from the worktree on the local e2e stack;
- the test wallet is connected and transactions are approved on the fork;
- each step's check is waited for, and the screenshots it asks for are taken;
- before shots come from a checkout of main;
- one video is recorded, then cut to the steps and sped up, with each step's title on screen.

It costs no tokens: it's an e2e run.

Only then does a model come back, briefly. It opens the few screenshots the steps produced and
judges each against what the step said should be there.

Three things come out of this:

1. **Fewer, better screenshots.** Each one exists because a step asked for it to prove a criterion.
2. **A video worth watching.** Short, in order, and labelled.
3. **A test you can run yourself.** "Test it by hand" now starts from the same steps, without asking
   a model to plan. With the test wallet, mevo can even play the steps for you while you watch, and
   hand over at the step only a human can judge.

## What went wrong the first time

The first real run of steps mode cost about twice as much as the original ticket. That's why we
build ways to measure before we switch anything on (more on that below). Looking into it:

- **The app was smarter than the script.** It reconnected the test wallet by itself on load, so
  the step that pressed "Connect" waited for a button that never appeared, timed out, and every
  step after it was skipped. Zero screenshots, and a 30-second video of a page waiting.
- **The verdict reloaded everything.** The AI that judged the screenshots resumed the lane's own
  session, which meant reloading the whole implementation, several dollars, to look at a handful
  of images.

The fixes:

- The connect helper now handles both a Connect button and an already-connected wallet.
- The verdict runs in a fresh, small session.
- Supervisor rounds re-run the steps for free without asking for a new verdict.
- A failed run no longer attaches its video.

The bigger lesson was about brittleness. A script fails when the app isn't what it expected; an
AI looking at the screen adapts. So steps mode now has a net: **if a step fails, the AI takes the
screenshots itself that round, exactly as before.** The steps stay, for the hand test and for the
next try. Steps can save a lot when they work and cost a few extra minutes when they don't, but
they can never leave you with less than you had.

## Measuring instead of guessing

Every one of these changes is a guess until it runs on real tickets. So mevo has a **replay**: take
a ticket that already ran and run it again from the same commit, with the same discussion and
today's settings, under its own id and branch. It never pushes, never posts and never touches
Linear.

The original's first pass and each replay's then sit side by side:

- cost, time and turns;
- supervisor rounds;
- lines and files, and whether they're the same files;
- the verdicts;
- how many screenshots.

The replay's own page shows everything else: the lane log, the steps and the PR it would have
opened.

One replay proves little, because two runs with the same settings never come out identical. But
three or four replays of finished tickets are enough to tell whether a setting is worth turning on
for everyone. That's how steps mode will earn its place, or not.

## Where it's going

Steps mode is off by default while we measure it. Next on the list:

- **Presets by label.** A cheap, fast profile for support fixes and a thorough one for features,
  each picking its own engines, effort and checks.
- **Custom phases.** A team can add its own step to the pipeline, like an accessibility pass or a
  bundle-size budget, without touching mevo's code.

The pattern behind all of it stays the same. Let the AI decide what to do and do the creative
part. Let programs do the repeatable part. Measure before you trust either one.

---

*More detail: [how-it-works.md](../how-it-works.md) (every phase), [visual-steps.md](../visual-steps.md)
(steps mode reference), [pipeline.md](../pipeline.md) (every setting).*
