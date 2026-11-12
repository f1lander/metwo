import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `pnpm init:repo <path> [--linear TEAM] [--force] [--print]`: reads a repo and writes a starting
// ticketflow.config.json for it. Everything it guesses is a plain value you can change after.

type Pkg = { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

export interface RepoFacts {
  readonly name: string
  readonly baseBranch: string
  readonly pm: 'pnpm' | 'yarn' | 'bun' | 'npm'
  readonly scripts: Readonly<Record<string, string>>
  readonly github: string | null
  readonly prTemplate: boolean
  readonly web3: boolean
  readonly storybook: boolean
}

const WEB3 = ['wagmi', 'viem', 'ethers', 'web3', '@rainbow-me/rainbowkit', '@reown/appkit', '@web3modal/wagmi', '@coinbase/onchainkit']
const TEMPLATES = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'pull_request_template.md']

const run = (cmd: string, args: string[], cwd: string): string => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

export function readFacts(repo: string): RepoFacts {
  const pkg: Pkg = existsSync(path.join(repo, 'package.json')) ? (JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as Pkg) : {}
  const head = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo).replace(/^origin\//, '')
  const remote = run('git', ['remote', 'get-url', 'origin'], repo)
  const github = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)?.[1] ?? null
  const pm = existsSync(path.join(repo, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(repo, 'yarn.lock')) ? 'yarn' : existsSync(path.join(repo, 'bun.lockb')) || existsSync(path.join(repo, 'bun.lock')) ? 'bun' : 'npm'
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  return {
    name: pkg.name ?? path.basename(repo),
    baseBranch: head || 'main',
    pm,
    scripts: pkg.scripts ?? {},
    github,
    prTemplate: TEMPLATES.some((f) => existsSync(path.join(repo, f))),
    web3: WEB3.some((d) => d in deps),
    storybook: Boolean(pkg.scripts?.storybook) || '@storybook/react' in deps,
  }
}

// the first script that exists, as the package manager runs it
function script(f: RepoFacts, names: readonly string[]): string {
  const name = names.find((n) => f.scripts[n])
  if (!name) return 'true'
  return f.pm === 'npm' ? `npm run ${name}` : `${f.pm} ${name}`
}

export function configFor(repo: string, f: RepoFacts, opts: { linear?: string }): Record<string, unknown> {
  const dev = script(f, ['dev', 'start'])
  // the port is appended: Next takes -p, Vite and most others --port; npm needs "--" first
  const devCmd = dev === 'true' ? 'true' : `${dev}${f.pm === 'npm' ? ' --' : ''} ${/\bnext\b/.test(f.scripts.dev ?? f.scripts.start ?? '') ? '-p' : '--port'}`
  const sb = f.storybook && f.scripts.storybook ? `${script(f, ['storybook'])}${f.pm === 'npm' ? ' --' : ''} --ci --no-open -p` : 'true'
  const linear = Boolean(opts.linear)
  return {
    project: { name: f.name, web3: f.web3 },
    repo: {
      path: repo,
      baseBranch: f.baseBranch,
      branchPattern: linear ? 'linear/{id}' : 'mevo/{id}',
      prTemplate: f.prTemplate ? 'repo' : 'builtin',
      commands: {
        test: script(f, ['test', 'test:unit']),
        typecheck: script(f, ['typecheck', 'type-check', 'check-types', 'tsc']),
        lint: script(f, ['lint', 'check']),
        dev: devCmd,
        storybook: sb,
        install: `${f.pm} install`,
      },
    },
    tracker: { kind: linear ? 'linear' : 'github', github: { repo: f.github ?? '', labels: [], idPrefix: 'GH', stateLabels: false } },
    ...(linear ? { linear: { teamKey: opts.linear } } : {}),
    // Greptile reviews only if the repo has the Greptile app installed
    github: { greptile: { enabled: false } },
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const target = args.find((a) => !a.startsWith('--'))
  if (!target) {
    console.error('usage: pnpm init:repo <path to the repo> [--linear TEAM] [--force] [--print]')
    process.exit(1)
  }
  // pnpm runs this from apps/daemon; INIT_CWD is where you typed the command
  const repo = path.resolve(process.env.INIT_CWD ?? process.cwd(), target.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
  if (!existsSync(path.join(repo, '.git'))) {
    console.error(`${repo} is not a git repo`)
    process.exit(1)
  }
  const li = args.indexOf('--linear')
  const linear = li >= 0 ? args[li + 1] : undefined
  const facts = readFacts(repo)
  const cfg = configFor(repo, facts, linear ? { linear } : {})
  const json = `${JSON.stringify(cfg, null, 2)}\n`
  if (args.includes('--print')) {
    process.stdout.write(json)
    return
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const out = path.join(root, 'ticketflow.config.json')
  if (existsSync(out) && !args.includes('--force')) {
    console.error(`${out} exists. Use --print to see the new one, or --force to replace it.`)
    process.exit(1)
  }
  writeFileSync(out, json)
  console.log(`wrote ${out}`)
  console.log(`- tracker: ${linear ? `Linear, team ${linear} (LINEAR_API_KEY in .env)` : `GitHub Issues in ${facts.github ?? 'the repo (no GitHub remote found)'}`}`)
  console.log(`- ${facts.pm}, base branch ${facts.baseBranch}, PR template: ${facts.prTemplate ? "the repo's" : "mevo's"}${facts.web3 ? ', wallet app' : ''}`)
  console.log('- check repo.commands: scripts not found are "true" (always pass)')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
