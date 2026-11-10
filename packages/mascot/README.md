# @mevo/mascot

Mo, the "o" of the mevo logo with its pupil, as an animated mascot. No animation library: SVG plus one `requestAnimationFrame` loop. Works with or without React.

```
src/
  shape.ts    the ring path, the pupil and the colors
  pose.ts     the Pose type, keyframe helpers, and the 13 states (idle, look, working, thinking,
              focus, asking, failed, merged, sleep, drag, coffee, tired, empty)
  brain.ts    autoPose(t, mood): which state to show for a mood (working, asking, energy…)
  render.ts   MascotRenderer / createMascot: draws Mo into an <svg>, set(pose) moves him
  coffee.ts   the coffee game rules, no DOM (safe to import on a server)
  react.tsx   <Mascot> and <FloatingMascot>
```

## Use it in another project

From this monorepo: `pnpm add @mevo/mascot@workspace:*`. From anywhere else, build it and install the folder, or publish it:

```sh
pnpm --filter @mevo/mascot build    # writes dist/ with .js and .d.ts
pnpm add /path/to/packages/mascot   # or: npm publish (publishConfig points at dist/)
```

React is an optional peer dependency (18 or 19). Without React, import from `@mevo/mascot` only.

## React

```tsx
import { FloatingMascot, Mascot } from '@mevo/mascot/react'

// one state on a loop
<Mascot state="working" width={120} />

// the floating assistant
<FloatingMascot
  mood={{ energy, coffee: true, working, asking, sleeping }}
  flash={{ state: 'merged', key: prNumber }}       // a new key plays the reaction once
  bubble={{ text: '#1695 merged 🎉', key: Date.now() }}
  onPress={openChat}                               // one click
  onCoffee={(sips) => setEnergy((e) => Math.min(1, e + sips * 0.1))} // clicks in a row
  onHide={() => setHidden(true)}                   // ✕, or thrown off the screen
  hidden={hidden}
  dock={() => document.querySelector('#logo-o')}   // where he flies when hidden
  storageKey="my-app.mo.corner"                    // remembers the corner
/>
```

`FloatingMascot` handles:

- dragging with stretch toward the motion;
- snapping to the nearest corner with a bounce;
- single click vs. clicks in a row (`COFFEE.multiClickMs`);
- flying into and out of the dock element;
- the cursor-following pupil;
- speech bubbles;
- keyboard: Enter presses, `c` gives coffee.

Under `prefers-reduced-motion` he keeps his expressions but doesn't bounce. Theme the bubble with `--mo-bubble-bg`, `--mo-bubble-fg`, `--mo-line` and `--mo-muted`.

## Without React

```ts
import { autoPose, createMascot, STATES } from '@mevo/mascot'

const { renderer } = createMascot(document.querySelector('#mo')!)
const t0 = performance.now()
function frame() {
  const t = (performance.now() - t0) / 1000
  renderer.set(autoPose(t, { energy: 0.7, working: true }))
  // or one state: renderer.set(STATES.thinking.pose(t % STATES.thinking.dur))
  requestAnimationFrame(frame)
}
frame()
```

## The coffee game

`COFFEE` holds the numbers:

- closing an issue costs 18%;
- each lane turn costs 3%;
- each click adds 10%;
- after he fills up, he stays fast for 2.6 s.

`drink`, `drain` and `isEmpty` are pure, so the server can own the energy and the app only shows it.

## Adding a state

Add an id to `MascotStateId` and an entry to `STATES` in `pose.ts`. Its `pose(t)` returns only the fields that change (see `Pose`), and `keys`, `blink` and `breathe` cover most motion. To use it as a reaction, pass `flash={{ state: 'yourState', key }}`. To make it part of the automatic moods, add it to `autoPose`.
