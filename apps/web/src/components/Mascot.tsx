import { drink, type MascotStateId } from '@mevo/mascot'
import { FloatingMascot } from '@mevo/mascot/react'
import type { DaemonState, Ticket } from '@ticketflow/shared'
import { useEffect, useRef, useState } from 'react'
import { mascotActions } from '../lib/api.js'
import { failed } from '../lib/notice.js'
import { mascot, useMascotHidden, useSummons } from '../lib/mascot.js'
import type { Route } from '../lib/route.js'
import { MoChat } from './MoChat.js'

const CHEATS = [
  { code: 'decaf', energy: 0, says: 'Decaf?! 😴 No new lanes until I get real coffee' },
  { code: 'sleepy', energy: 0.15, says: 'So… sleepy… one more coffee?' },
  { code: 'espresso', energy: 1, says: 'ESPRESSO! ⚡ Ready for anything' },
] as const

const working = (t: Ticket) => t.status === 'running' || t.status === 'queued'

// Mo in mevo: his mood comes from the lanes, questions, Night Shift and his coffee; he reacts to
// merges, approvals and failures, and a click opens the agent's chat.
export function MevoMascot({ state, route }: { state: DaemonState; route: Route }) {
  const status = state.mascot ?? { energy: 1, enabled: true, coffee: true }
  const hidden = useMascotHidden()
  const summons = useSummons()
  const [energy, setEnergy] = useState(status.energy)
  useEffect(() => setEnergy(status.energy), [status.energy])
  const [flash, setFlash] = useState<{ state: MascotStateId; key: number } | null>(null)
  const [bubble, setBubble] = useState<{ text: string; key: number } | null>(null)
  const say = (text: string) => setBubble({ text, key: Date.now() })
  const react = (s: MascotStateId) => setFlash({ state: s, key: Date.now() })

  const tickets = Object.values(state.tickets).filter((t) => !t.replay)
  const here = route.page === 'ticket' ? state.tickets[route.id] : undefined
  const isWorking = here ? working(here) : tickets.some((t) => t.status === 'running')
  const isAsking = here ? here.status === 'needs_input' : tickets.some((t) => t.status === 'needs_input')

  // what changed since the last snapshot: merged, approved, failed, a question
  const prev = useRef<Map<string, Ticket> | null>(null)
  useEffect(() => {
    const before = prev.current
    prev.current = new Map(tickets.map((t) => [t.id, t]))
    if (!before) return
    for (const t of tickets) {
      const b = before.get(t.id)
      if (!b) continue
      if (t.pr?.state === 'MERGED' && b.pr?.state !== 'MERGED') {
        react('merged')
        say(`#${t.pr.number} merged 🎉`)
      } else if (t.pr?.reviewDecision === 'APPROVED' && b.pr?.reviewDecision !== 'APPROVED') {
        react('merged')
        say(`#${t.pr.number} was approved ✓`)
      } else if ((t.journal?.length ?? 0) > (b.journal?.length ?? 0) && t.journal?.at(-1)?.kind === 'failure') {
        react('failed')
        say(`${t.id}: ${t.journal.at(-1)?.title ?? 'something failed'}`)
      } else if (t.status === 'needs_input' && b.status !== 'needs_input') {
        say(`${t.id} has a question for you`)
      } else if (t.status === 'review_ready' && b.status === 'running') {
        say(`${t.id} is ready for you to look at`)
      }
    }
  }, [state.tickets])

  const wasEmpty = useRef(energy <= 0)
  useEffect(() => {
    const empty = status.coffee && energy <= 0
    if (empty && !wasEmpty.current) say('I’m out of coffee ☕ Click me a few times, no new lanes until then')
    wasEmpty.current = empty
  }, [energy, status.coffee])

  // clicks batch into one request
  const pending = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onCoffee = (sips: number) => {
    if (!status.coffee) return
    setEnergy((e) => drink(e, sips))
    pending.current += sips
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const n = pending.current
      pending.current = 0
      mascotActions.coffee(n).catch(failed)
    }, 250)
  }

  // cheat codes, typed anywhere outside a text field: decaf empties him, sleepy leaves him tired,
  // espresso fills him up
  useEffect(() => {
    if (!status.enabled) return
    let typed = ''
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return
      if (el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return
      typed = (typed + e.key.toLowerCase()).slice(-12)
      const hit = CHEATS.find((c) => typed.endsWith(c.code))
      if (!hit) return
      typed = ''
      setEnergy(hit.energy)
      say(hit.says)
      if (hit.energy >= 1) react('coffee')
      mascotActions.set(hit.energy).catch(failed)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [status.enabled])

  // a click opens his chat; it asks about this ticket when you are on one
  const [chat, setChat] = useState(false)
  const [thinking, setThinking] = useState(false)
  const onPress = () => setChat((c) => !c)
  useEffect(() => {
    if (hidden) setChat(false)
  }, [hidden])

  const mobile = typeof innerWidth === 'number' && innerWidth < 768
  if (!status.enabled) return null
  return (
    <FloatingMascot
      mood={{ energy, coffee: status.coffee, working: isWorking || thinking, asking: isAsking, sleeping: state.nightShift?.active ?? false }}
      flash={flash}
      bubble={bubble}
      onPress={onPress}
      popover={chat ? <MoChat state={state} here={here} onClose={() => setChat(false)} onBusy={setThinking} /> : null}
      onCoffee={onCoffee}
      onHide={() => mascot.setHidden(true)}
      hidden={hidden}
      summon={summons}
      onPresence={mascot.setPresent}
      dock={() => mascot.ring()}
      width={mobile ? 64 : 76}
      insets={{ top: mobile ? 96 : 64, right: mobile ? 12 : 20, bottom: mobile ? 84 : 36, left: mobile ? 12 : 20 }}
      storageKey="mevo.mo.corner"
      label={`Mo, ${Math.round(energy * 100)}% coffee: click to tell the agent, click a few times for coffee, drag to move`}
    />
  )
}

