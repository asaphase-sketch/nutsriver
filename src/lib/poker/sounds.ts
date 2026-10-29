'use client'

/**
 * NutsRiver sound engine — every effect is synthesized with WebAudio, so the
 * site ships zero audio assets (fast loads, no licensing, tiny bundle).
 *
 * Global mute is persisted in localStorage under `nr-muted`.
 * All synthesis is defensive: audio is best-effort and never throws.
 */

type Ctx = AudioContext & { __nrMaster?: GainNode }

let ctx: Ctx | null = null
let master: GainNode | null = null
let muted = false

const MUTE_KEY = 'nr-muted'

export function initSounds() {
  if (typeof window === 'undefined') return
  try {
    muted = window.localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    muted = false
  }
}

export function isMuted(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

export function setMuted(next: boolean) {
  muted = next
  try {
    window.localStorage.setItem(MUTE_KEY, next ? '1' : '0')
  } catch {
    /* private mode */
  }
  if (master && ctx) {
    try {
      master.gain.setTargetAtTime(next ? 0 : 0.9, ctx.currentTime, 0.01)
    } catch {
      /* ignore */
    }
  }
  if (!next) playChips() // audible confirmation that sound is back on
  try {
    window.dispatchEvent(new Event(MUTE_EVENT))
  } catch {
    /* ignore */
  }
}

const MUTE_EVENT = 'nr-muted-changed'

/** useSyncExternalStore bindings for the mute preference (hydration-safe). */
export function subscribeMute(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(MUTE_EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(MUTE_EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

export function getMuteSnapshot(): boolean {
  return isMuted()
}

function ensureCtx(): Ctx | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ctx = new AC() as Ctx
      master = ctx.createGain()
      master.gain.value = muted ? 0 : 0.9
      master.connect(ctx.destination)
    } catch {
      return null
    }
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
  return ctx
}

/** Short filtered-noise burst — the workhorse for card sounds. */
function noiseBurst(opts: { dur: number; freq: number; q?: number; gain?: number; type?: BiquadFilterType; delay?: number }) {
  const c = ensureCtx()
  if (!c || !master || muted) return
  try {
    const dur = opts.dur
    const start = c.currentTime + (opts.delay ?? 0)
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
    }
    const src = c.createBufferSource()
    src.buffer = buf
    const filter = c.createBiquadFilter()
    filter.type = opts.type ?? 'bandpass'
    filter.frequency.value = opts.freq
    filter.Q.value = opts.q ?? 1
    const g = c.createGain()
    g.gain.setValueAtTime(opts.gain ?? 0.5, start)
    g.gain.exponentialRampToValueAtTime(0.001, start + dur)
    src.connect(filter)
    filter.connect(g)
    g.connect(master)
    src.start(start)
    src.stop(start + dur)
  } catch {
    /* ignore */
  }
}

/** Simple sine/triangle blip with pitch envelope. */
function tone(opts: {
  freq: number
  dur: number
  gain?: number
  type?: OscillatorType
  slideTo?: number
  delay?: number
}) {
  const c = ensureCtx()
  if (!c || !master || muted) return
  try {
    const start = c.currentTime + (opts.delay ?? 0)
    const osc = c.createOscillator()
    osc.type = opts.type ?? 'sine'
    osc.frequency.setValueAtTime(opts.freq, start)
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, start + opts.dur)
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, start)
    g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.25, start + 0.012)
    g.gain.exponentialRampToValueAtTime(0.001, start + opts.dur)
    osc.connect(g)
    g.connect(master)
    osc.start(start)
    osc.stop(start + opts.dur + 0.02)
  } catch {
    /* ignore */
  }
}

// ---------------- public effects ----------------

/** Two quick card swishes — the deal. */
export function playDeal(cards = 2) {
  for (let i = 0; i < cards; i++) {
    noiseBurst({ dur: 0.09, freq: 2600 + i * 400, q: 0.8, gain: 0.32, delay: i * 0.09 })
  }
}

/** Single card flip (board runout / showdown reveal). */
export function playFlip() {
  noiseBurst({ dur: 0.07, freq: 3200, q: 1.2, gain: 0.3 })
  tone({ freq: 720, dur: 0.06, gain: 0.06, type: 'triangle', delay: 0.02 })
}

/** Chips sliding into the pot. */
export function playChips() {
  for (let i = 0; i < 3; i++) {
    tone({ freq: 1900 + Math.random() * 700, dur: 0.05, gain: 0.1, type: 'triangle', delay: i * 0.035 })
    noiseBurst({ dur: 0.04, freq: 4200, gain: 0.12, delay: i * 0.035 })
  }
}

/** Soft fold. */
export function playFold() {
  noiseBurst({ dur: 0.14, freq: 900, q: 0.7, gain: 0.16 })
}

/** Your turn — gentle two-note prompt. */
export function playYourTurn() {
  tone({ freq: 660, dur: 0.12, gain: 0.16, type: 'sine' })
  tone({ freq: 880, dur: 0.16, gain: 0.16, type: 'sine', delay: 0.13 })
}

/** All-in drama. */
export function playAllIn() {
  tone({ freq: 220, dur: 0.5, gain: 0.22, type: 'sawtooth', slideTo: 440 })
  tone({ freq: 440, dur: 0.45, gain: 0.12, type: 'triangle', slideTo: 880, delay: 0.08 })
}

/** Win fanfare (short, pleasant). */
export function playWin() {
  const seq = [523.25, 659.25, 783.99, 1046.5]
  seq.forEach((f, i) => tone({ freq: f, dur: 0.22, gain: 0.16, type: 'triangle', delay: i * 0.09 }))
}

/** Tournament finish — bigger fanfare. */
export function playFanfare() {
  const seq = [392, 523.25, 659.25, 783.99, 1046.5]
  seq.forEach((f, i) => tone({ freq: f, dur: 0.3, gain: 0.2, type: 'triangle', delay: i * 0.12 }))
  tone({ freq: 196, dur: 0.9, gain: 0.1, type: 'sine', delay: 0.1 })
}

/** Blind level up. */
export function playLevelUp() {
  tone({ freq: 440, dur: 0.14, gain: 0.15, type: 'square' })
  tone({ freq: 587.33, dur: 0.2, gain: 0.15, type: 'square', delay: 0.15 })
}
