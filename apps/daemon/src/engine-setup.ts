import { spawn } from 'node:child_process'
import os from 'node:os'
import { ENGINE_SETUP, type EngineSetupStatus } from '@ticketflow/shared'
import { log } from './log.js'
import { openTerminal, type TerminalApp } from './runner/open-claude.js'

// Installs engine CLIs from the app (through a login shell, so npm and curl see your PATH) and
// opens your terminal for the interactive sign-in.
export class EngineSetup {
  private readonly status = new Map<string, EngineSetupStatus>()

  constructor(
    private readonly onChange: () => Promise<void>,
    private readonly terminal: () => TerminalApp,
  ) {}

  list(): readonly EngineSetupStatus[] {
    return [...this.status.values()]
  }

  install(id: string): EngineSetupStatus {
    const setup = ENGINE_SETUP[id]
    if (!setup) throw new Error(`unknown engine ${id}`)
    if (this.status.get(id)?.state === 'installing') throw new Error(`${id} is already installing`)
    let output = ''
    const set = (state: EngineSetupStatus['state']) => this.status.set(id, { id, state, at: new Date().toISOString(), output: output.slice(-3000) })
    set('installing')
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `set -o pipefail; ${setup.install}`], { cwd: os.homedir(), env: { ...process.env, CI: '1', npm_config_yes: 'true' } })
    const add = (b: Buffer) => {
      output = (output + b.toString()).slice(-6000)
      set('installing')
    }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)
    child.on('error', (e) => {
      output += `\n${e.message}`
      set('failed')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && /EACCES|permission denied/i.test(output)) output += '\n\nnpm needs write access to its global folder. Run the install in your terminal (it may ask for your password), or fix npm permissions.'
      set(code === 0 ? 'done' : 'failed')
      log.info(`engine setup: ${id} install exited ${code}`)
      void this.onChange().catch(() => undefined)
    })
    return this.status.get(id) as EngineSetupStatus
  }

  async open(id: string, step: 'install' | 'login'): Promise<string> {
    const setup = ENGINE_SETUP[id]
    const command = step === 'login' ? setup?.login : setup?.install
    if (!command) throw new Error(`${id} has no ${step} command`)
    return openTerminal(os.homedir(), command, `${id} ${step}`, this.terminal())
  }
}
