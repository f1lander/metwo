# Custom phases

Plan, not built yet. Today the phases are fixed in the runner's code: you can tune each one
(see [../pipeline.md](../pipeline.md)), but you can't add one. This plan lets a team add phases
(an accessibility pass, an i18n check, a bundle-size budget) without touching mevo's code.

## The shape

A phase is data:

```json
{
  "stages": {
    "phases": [
      {
        "id": "a11y",
        "title": "Accessibility pass",
        "after": "review",
        "kind": "agent",
        "engine": "claude:sonnet",
        "effort": "low",
        "context": ["repoRules", "diff", "shots"],
        "instructions": "Check the changed UI for labels, focus order and contrast. Fix what is clearly wrong.",
        "writes": "commits",
        "gate": "warn",
        "when": { "labels": ["UI"], "paths": ["apps/*/src/components/**"] }
      },
      {
        "id": "bundle",
        "title": "Bundle size",
        "after": "beforePr",
        "kind": "command",
        "run": "pnpm --filter manager build && node scripts/bundle-budget.mjs",
        "gate": "block"
      }
    ]
  }
}
```

| Field | |
|---|---|
| `after` | Where it runs: after `implement`, `review`, `supervisor`, `beforePr`, `pr`, or after a follow-up round. |
| `kind` | `agent`: a model call with a prompt built from blocks. `command`: a shell command in the worktree. |
| `context` | The same blocks as the built-in steps, plus `diff`, `shots`, `summary`. |
| `writes` | `nothing` (read-only, reports), `commits` (may fix), `report` (writes `PHASE-<id>.json`). |
| `gate` | `block` (holds the push like a red local check), `warn` (shows on the ticket and in the PR), `off`. |
| `when` | Only for tickets with these labels or diffs touching these paths. Empty: always. |

## Contract

Every phase ends by writing `PHASE-<id>.json`:

```json
{ "verdict": "pass | concerns | fail", "summary": "...", "findings": [{ "severity": "P1", "file": "path:line", "note": "..." }] }
```

A command phase gets it from its exit code and output tail. mevo shows it in the journal and on
the ticket, and adds it to the PR's Verification section.

## In the app

- A **Custom phases** panel at the end of each stage in Settings → Pipeline: add, edit, turn off,
  reorder.
- The pipeline map shows them in place.
- A **Preview** like the built-in steps, and **Run on this ticket** to try a phase on one ticket
  before turning it on for all.
- The cost per phase in the journal, so a phase that never finds anything can go.

## Built-in phases

Next step after this: describe the built-in phases (review pass, supervisor, visual check, local
checks) with the same shape. The runner then walks one list, and turning off, reordering or
replacing a built-in phase is the same as for a custom one. The contracts mevo reads
(ARM-SUMMARY, SUPERVISE.json, VISUAL.json) stay as they are.

## Safety

- Agent phases follow the same hard rules as the lanes: no push, no network writes, nothing
  outside the worktree.
- Command phases run with the gates' permissions, in the worktree, with the same sandbox when it
  is on.
- A phase can't remove the task contract or the safety rules from a built-in step's prompt.
- A `block` phase can always be pushed past with Push anyway, like local checks.

## Phases of the work

1. Command phases (`kind: command`) at `beforePr`, with `block` / `warn`. Small, and covers
   budgets, scanners and scripts the team already has.
2. Agent phases with context blocks, `PHASE-<id>.json`, the panel and Preview.
3. `when` filters, Run on this ticket, cost per phase.
4. The built-in phases on the same list.
