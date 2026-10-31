'use client'

/**
 * NutsRiver sound engine — every effect is synthesized with WebAudio, so the
 * site ships zero audio assets (fast loads, no licensing, tiny bundle).
 *
 * "Soft & slow" voicing: everything runs through a warm lowpass → gentle
 * compressor → short synthetic room reverb, gains sit low, attacks are slow
 * and every rhythm is unhurried. No square waves, no harsh transients.
 *
 * Global mute is persisted in localStorage under `nr-muted`.
 * All synthesis is defensive: audio is best-effort and never throws.
 */

type Ctx = AudioContext & { __nrMaster?: GainNode }

/** overall loudness — kept low; individual effects stay quiet on top of it */
const MASTER_GAIN = 0.55

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
      // slow fade in/out — never a click
      master.gain.setTargetAtTime(next ? 0 : MASTER_GAIN, ctx.currentTime, 0.08)
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

/** Short exponential-decay noise impulse — a small soft room, not a cathedral. */
function reverbImpulse(c: AudioContext, seconds = 1.6, decay = 2.8): AudioBuffer {
  const len = Math.max(1, Math.floor(c.sampleRate * seconds))
  const buf = c.createBuffer(2, len, c.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
    }
  }
  return buf
}

function ensureCtx(): Ctx | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ctx = new AC() as Ctx
      master = ctx.createGain()
      master.gain.value = muted ? 0 : MASTER_GAIN

      // warm the top end so nothing clicks or hisses
      const warm = ctx.createBiquadFilter()
      warm.type = 'lowpass'
      warm.frequency.value = 3800
      warm.Q.value = 0.4

      // gentle glue — smooths the loudest peaks instead of clamping them
      const glue = ctx.createDynamicsCompressor()
      glue.threshold.value = -26
      glue.knee.value = 24
      glue.ratio.value = 3.5
      glue.attack.value = 0.02
      glue.release.value = 0.32

      master.connect(warm)
      warm.connect(glue)
      glue.connect(ctx.destination)

      // soft room tail (decorative — never let it break audio)
      try {
        const conv = ctx.createConvolver()
        conv.buffer = reverbImpulse(ctx)
        const wet = ctx.createGain()
        wet.gain.value = 0.16
        glue.connect(conv)
        conv.connect(wet)
        wet.connect(ctx.destination)
      } catch {
        /* no reverb — still fine */
      }
    } catch {
      return null
    }
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
  return ctx
}

/**
 * Soft filtered-noise burst — the workhorse for card sounds. The buffer gets
 * a short fade-in so bursts never start with a click, then fall off slowly.
 */
function noiseBurst(opts: { dur: number; freq: number; q?: number; gain?: number; type?: BiquadFilterType; delay?: number }) {
  const c = ensureCtx()
  if (!c || !master || muted) return
  try {
    const dur = opts.dur
    const start = c.currentTime + (opts.delay ?? 0)
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length
      const attack = Math.min(1, i / (data.length * 0.12)) // 12% fade-in
      data[i] = (Math.random() * 2 - 1) * attack * (1 - t) * (1 - t)
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

/** Sine/triangle blip with pitch envelope and a slow, soft attack. */
function tone(opts: {
  freq: number
  dur: number
  gain?: number
  type?: OscillatorType
  slideTo?: number
  delay?: number
  /** seconds to reach full level — slow attacks feel soft, never percussive */
  attack?: number
}) {
  const c = ensureCtx()
  if (!c || !master || muted) return
  try {
    const start = c.currentTime + (opts.delay ?? 0)
    const attack = Math.min(opts.attack ?? 0.018, opts.dur * 0.6)
    const osc = c.createOscillator()
    osc.type = opts.type ?? 'sine'
    osc.frequency.setValueAtTime(opts.freq, start)
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, start + opts.dur)
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, start)
    g.gain.linearRampToValueAtTime(opts.gain ?? 0.25, start + attack)
    g.gain.exponentialRampToValueAtTime(0.001, start + opts.dur)
    osc.connect(g)
    g.connect(master)
    osc.start(start)
    osc.stop(start + opts.dur + 0.05)
  } catch {
    /* ignore */
  }
}

// ---------------- public effects (soft & slow voicing) ----------------

/** Airy card swishes dealing around the table — unhurried, one per card. */
export function playDeal(cards = 2) {
  for (let i = 0; i < cards; i++) {
    noiseBurst({ dur: 0.16, freq: 2100 + i * 260, q: 0.6, gain: 0.14, delay: i * 0.17 })
  }
}

/** Single card flip (board runout / showdown reveal) — a soft turn, not a snap. */
export function playFlip() {
  noiseBurst({ dur: 0.13, freq: 2600, q: 0.8, gain: 0.13 })
  tone({ freq: 560, dur: 0.12, gain: 0.05, type: 'sine', delay: 0.03, attack: 0.02 })
}

/** Chips sliding into the pot — a slow cascade of warm ceramic clicks. */
export function playChips() {
  for (let i = 0; i < 4; i++) {
    tone({ freq: 1500 + Math.random() * 600, dur: 0.07, gain: 0.055, type: 'triangle', delay: i * 0.065 })
    noiseBurst({ dur: 0.05, freq: 3400, gain: 0.06, delay: i * 0.065 })
  }
}

/** Soft fold — a long, low cloth swish as the cards slide away. */
export function playFold() {
  noiseBurst({ dur: 0.24, freq: 640, q: 0.5, gain: 0.09, type: 'lowpass' })
}

/** Your turn — gentle two-note prompt that swells in instead of popping. */
export function playYourTurn() {
  tone({ freq: 523.25, dur: 0.35, gain: 0.11, type: 'sine', attack: 0.05 })
  tone({ freq: 783.99, dur: 0.45, gain: 0.1, type: 'sine', delay: 0.2, attack: 0.05 })
}

/** All-in drama — a slow cinematic swell (no aggressive saw buzz). */
export function playAllIn() {
  tone({ freq: 196, dur: 1.2, gain: 0.12, type: 'sine', slideTo: 392, attack: 0.4 })
  tone({ freq: 98, dur: 1.3, gain: 0.09, type: 'sine', attack: 0.5 })
  noiseBurst({ dur: 0.6, freq: 900, q: 0.4, gain: 0.05, type: 'lowpass', delay: 0.1 })
}

/** Win fanfare — slower arpeggio over a soft low pad. */
export function playWin() {
  const seq = [523.25, 659.25, 783.99, 1046.5, 1318.5]
  seq.forEach((f, i) => tone({ freq: f, dur: 0.5, gain: 0.09, type: 'triangle', delay: i * 0.16, attack: 0.03 }))
  tone({ freq: 261.63, dur: 1.1, gain: 0.06, type: 'sine', attack: 0.1 })
}

/** Tournament finish — bigger, still gentle. */
export function playFanfare() {
  const seq = [392, 523.25, 659.25, 783.99, 1046.5]
  seq.forEach((f, i) => tone({ freq: f, dur: 0.6, gain: 0.11, type: 'triangle', delay: i * 0.18, attack: 0.04 }))
  tone({ freq: 196, dur: 1.4, gain: 0.08, type: 'sine', delay: 0.1, attack: 0.15 })
}

/** Blind level up — warm chime pair (no square wave buzz). */
export function playLevelUp() {
  tone({ freq: 440, dur: 0.3, gain: 0.08, type: 'sine', attack: 0.03 })
  tone({ freq: 659.25, dur: 0.4, gain: 0.08, type: 'sine', delay: 0.18, attack: 0.03 })
}
