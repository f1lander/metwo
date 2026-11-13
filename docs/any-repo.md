# mevo on any repo

mevo started as a pipeline for one repo (ENS Labs' apps-monorepo) and one tracker (Linear). This
page covers what makes it work on any repo, what is done, and what comes next.

## Set up a repo

```sh
pnpm init:repo ~/code/your-app                 # GitHub Issues in that repo
pnpm init:repo ~/code/your-app --linear ENG    # Linear, team ENG
pnpm init:repo ~/code/your-app --print         # show the config, write nothing
```

It reads the repo and writes `ticketflow.config.json`:

| Found | Becomes |
|---|---|
| `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, else npm | how scripts run and `repo.commands.install` |
| `origin/HEAD` | `repo.baseBranch` |
| `test`, `typecheck`, `lint`, `dev`, `storybook` scripts | `repo.commands` (missing ones are `true`) |
| Next in the dev script | the port flag: `-p`, otherwise `--port` |
| `.github/pull_request_template.md` | `repo.prTemplate: "repo"` |
| wagmi, viem, ethers… in the dependencies | `project.web3: true` |
| the GitHub remote | `tracker.github.repo` |

Greptile starts off (`github.greptile.enabled: false`); turn it on if the repo has the app.

## Trackers

`tracker.kind` is `linear` or `github`.

**GitHub Issues** (`tracker.github`) goes through your `gh` sign-in; no key.

| | |
|---|---|
| Tickets | open issues assigned to you in `repo` (default: the repo's remote), only those with all of `labels` when set |
| Ids | `<idPrefix>-<number>`, `GH-12` by default |
| Comments | the same moments as Linear (`linear.comments.on`), as issue comments |
| States | open and closed. Done closes the issue. With `stateLabels: true`, In Progress, In Review and QA are a `status: <name>` label |
| PR link | the PR body ends with `Fixes #12`, so GitHub links and closes it |
| Find tickets | Backlog (open, unassigned), Search, and a pasted issue link. No cycles or projects |
| Not there | the leaderboard's issue counts and Linear mentions in Reviews |

**Linear** works as before and needs `LINEAR_API_KEY`.

The core only talks to `Tracker` (`apps/daemon/src/tracker.ts`). Linear is `linear.ts`, GitHub
Issues `github-issues.ts`. A third tracker (Jira, Plane) is one more class.

## What is optional now

| Piece | Off when |
|---|---|
| Telegram | no `TELEGRAM_BOT_TOKEN`: the bot is off, everything else runs |
| Linear | `tracker.kind: "github"` |
| Greptile | `github.greptile.enabled: false` |
| Wallet steps, Test wallet | `project.web3: false` (default: on only when the e2e preset is found) |
| e2e stack | no `e2e` config and no `e2e:infra:up` script |
| Wiki and knowledge | no `wiki.path`, no `knowledge.sources` |
| PR template | `repo.prTemplate`: `builtin`, `repo`, or a path |

## Next

1. **Several projects in one mevo.** Today it is one config, one repo. Next: a `projects` list,
   each with its own repo, tracker and settings, one board per project and one switcher. The
   store, the ports and the worktrees are already per ticket, so most of it is config and UI.
2. **Setup with the AI.** `init:repo` guesses from files. A short read-only lane could read the
   CI workflow, CLAUDE.md and the README and fill what files don't say: the real test command in
   a monorepo, how to start the app, which docs to use as context.
3. **The app's copy.** Many labels still say Linear; they should say the tracker's name
   (`health.tracker.label`).
4. **Custom phases** ([ideas/custom-phases.md](ideas/custom-phases.md)), once the pipeline has no
   hard-wired ENS step left.
5. **Publish.** A fresh public repo without this one's history (it has internal notes, ticket
   ids and wiki paths), a generic example config, a license, and the ENS preset kept as one
   example among others.
