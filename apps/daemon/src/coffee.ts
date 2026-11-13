import { COFFEE, drain, drink, isEmpty } from '@mevo/mascot/coffee'
import type { JournalEntry, MascotStatus } from '@ticketflow/shared'
import type { Config } from './config.js'
import type { Store } from './store.js'

export const NO_COFFEE = 'Mo is out of coffee: click him a few times in the app to start lanes again'

// Mo's coffee: closing an issue and every lane turn drain it, clicks refill it, empty blocks new lanes.
export class Coffee {
  constructor(
    private readonly cfg: () => Config,
    private readonly store: Pick<Store, 'mascot' | 'setMascot' | 'get' | 'on'>,
  ) {
    this.sync()
    store.on('closed', (id: string) => queueMicrotask(() => store.get(id)?.status === 'done' && this.spend(COFFEE.issue)))
    store.on('journal', (_id: string, e: Omit<JournalEntry, 'at'>) => e.kind === 'run' && this.spend(COFFEE.turn))
  }

  status(): MascotStatus {
    return this.store.mascot()
  }

  // the switches from settings, copied into the state the app sees
  sync(): void {
    const m = this.cfg().mascot
    const s = this.store.mascot()
    if (s.enabled !== m.enabled || s.coffee !== m.coffee) this.store.setMascot({ enabled: m.enabled, coffee: m.coffee })
  }

  sip(sips: number): MascotStatus {
    const n = Math.max(1, Math.min(20, Math.round(sips)))
    return this.store.setMascot({ energy: drink(this.store.mascot().energy, n) })
  }

  // cheat codes from the app: decaf (0), sleepy, espresso (1)
  set(energy: number): MascotStatus {
    return this.store.setMascot({ energy: Math.max(0, Math.min(1, energy)) })
  }

  // why a new lane can't start, or null
  blocked(): string | null {
    const m = this.cfg().mascot
    return m.enabled && m.coffee && isEmpty(this.store.mascot().energy) ? NO_COFFEE : null
  }

  private spend(amount: number): void {
    const m = this.cfg().mascot
    if (!m.enabled || !m.coffee) return
    const e = this.store.mascot().energy
    if (e > 0) this.store.setMascot({ energy: drain(e, amount) })
  }
}
