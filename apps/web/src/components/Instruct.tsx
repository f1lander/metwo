import type { Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState } from 'react'
import { actions } from '../lib/api.js'
import { Button } from './ui.js'

interface Shot {
  readonly name: string
  readonly data: string
}

const read = (file: File) =>
  new Promise<Shot>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve({ name: file.name || 'pasted.png', data: String(r.result) })
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })

// Your own instruction for the lane, with screenshots pasted, dropped or picked.
export function Instruct({ ticket: t }: { ticket: Ticket }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [shots, setShots] = useState<readonly Shot[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const running = t.status === 'running' || t.status === 'queued'
  if (!t.worktree) return null

  const add = async (files: readonly File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/')).slice(0, 6 - shots.length)
    const next = await Promise.all(images.map(read))
    setShots((s) => [...s, ...next])
  }

  const send = async () => {
    setBusy(true)
    setNote(null)
    try {
      await actions.instruct(t, text, shots)
      setText('')
      setShots([])
      setOpen(false)
      setNote('Sent. The lane is on it; it comes back to review when done.')
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={running}
          onClick={() => setOpen(true)}
          title={running ? 'a lane is running on this ticket' : 'describe a change, attach screenshots'}
          className="group flex w-full items-center gap-3 rounded-lg border border-dashed border-accent/60 bg-accent/5 px-3.5 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent/20 text-[15px] text-accent-fg" aria-hidden="true">
            ✎
          </span>
          <span className="flex flex-col">
            <span className="text-[13px] font-medium text-fg">Tell the agent what to change</span>
            <span className="text-[11.5px] text-muted">{running ? 'A lane is running on this ticket; try when it finishes' : 'Describe it in your words, paste a screenshot. Nothing is pushed.'}</span>
          </span>
          <span className="ml-auto text-xs text-accent-fg opacity-0 transition-opacity group-hover:opacity-100 max-md:hidden">Open</span>
        </button>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex flex-col gap-2 rounded-lg border px-3 py-3 transition-colors ${over ? 'border-accent bg-raised' : 'border-line-2 bg-panel'}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        void add([...e.dataTransfer.files])
      }}
    >
      <label htmlFor={`instruct-${t.id}`} className="text-xs font-medium text-fg">
        What should change?
      </label>
      <textarea
        id={`instruct-${t.id}`}
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.length) {
            e.preventDefault()
            void add(files)
          }
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) void send()
        }}
        placeholder="The title overlaps the back button on the renew screen at mobile width. Keep the title on one line beside the icon."
        className="rounded-md border border-line-2 bg-bg px-3 py-2 text-[13px] leading-relaxed outline-none transition-colors focus:border-accent max-md:text-[16px]"
      />
      <AnimatePresence initial={false}>
        {shots.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex flex-wrap gap-2">
            {shots.map((s, i) => (
              <motion.div key={`${s.name}-${i}`} layout initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="relative">
                <img src={s.data} alt={s.name} className="h-20 rounded-md border border-line object-cover" />
                <button type="button" aria-label={`remove ${s.name}`} onClick={() => setShots((all) => all.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-raised text-[11px] text-muted ring-1 ring-line-2 hover:text-fg">
                  ✕
                </button>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => void add([...(e.target.files ?? [])])} />
        <Button variant="ghost" onClick={() => picker.current?.click()} disabled={shots.length >= 6}>
          Attach screenshot
        </Button>
        <span className="text-[11px] text-dim max-md:hidden">or paste / drop an image · ⌘↵ to send</span>
        <span className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !text.trim() || running} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send to the lane'}
          </Button>
        </span>
      </div>
      {note && <div className="text-xs text-bad">{note}</div>}
      <p className="text-[11px] leading-relaxed text-dim">The lane reproduces it, fixes it in the worktree, re-checks it visually and comes back for your review. Nothing is pushed.</p>
    </motion.div>
  )
}
