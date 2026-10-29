'use client'

/**
 * Four-color deck preference (PokerStars-style: diamonds blue, clubs green).
 * Stored in localStorage and broadcast via a custom event so every card on the
 * page — felt, seats, hand history — flips together, like the mute store.
 */
const KEY = 'nr-four-color'
const EVT = 'nr-four-color-change'

export function getFourColor(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setFourColor(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* private mode — session-only */
  }
  window.dispatchEvent(new Event(EVT))
}

export function subscribeFourColor(cb: () => void): () => void {
  window.addEventListener(EVT, cb)
  // react to toggles from other tabs too
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVT, cb)
    window.removeEventListener('storage', cb)
  }
}
