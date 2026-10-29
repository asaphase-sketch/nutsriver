import type { Card } from './types'

export const RANK_CHARS = '23456789TJQKA' // rank index 0..12 (0=2, 12=A)
export const SUIT_CHARS = 'shdc' // 0=s,1=h,2=d,3=c

export function cardCode(c: Card): string {
  return RANK_CHARS[c >> 2] + SUIT_CHARS[c & 3]
}

export function cardRank(c: Card): number {
  return (c >> 2) + 2 // 2..14
}

export function cardSuit(c: Card): number {
  return c & 3
}

export function cardRankIndex(c: Card): number {
  return c >> 2
}

/** Parse a card code like "As" or "Td" back into the numeric encoding. */
export function parseCard(code: string): Card {
  const r = RANK_CHARS.indexOf(code[0]?.toUpperCase() ?? '')
  const s = SUIT_CHARS.indexOf(code[1]?.toLowerCase() ?? '')
  if (r < 0 || s < 0) throw new Error(`Invalid card code: ${code}`)
  return r * 4 + s
}

/** Fresh deck of 52 cards, values 0..51 */
export function freshDeck(): Card[] {
  const deck: Card[] = new Array(52)
  for (let i = 0; i < 52; i++) deck[i] = i
  return deck
}

/**
 * Cryptographically secure in-place Fisher-Yates shuffle.
 * Uses crypto-quality random integers (no modulo bias).
 */
export function secureShuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    // uniform random integer in [0, i]
    const j = randomIntBelow(i + 1)
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

/** Uniform random integer in [0, n) using rejection sampling on crypto bytes. */
export function randomIntBelow(n: number): number {
  if (n <= 0) throw new Error('n must be positive')
  const maxUint32 = 0x100000000
  const limit = maxUint32 - (maxUint32 % n)
  const buf = new Uint32Array(1)
  const c = (globalThis as { crypto?: Crypto }).crypto ?? (typeof crypto !== 'undefined' ? crypto : undefined)
  if (!c) throw new Error('Web Crypto unavailable')
  do {
    c.getRandomValues(buf)
  } while (buf[0] >= limit)
  return buf[0] % n
}
