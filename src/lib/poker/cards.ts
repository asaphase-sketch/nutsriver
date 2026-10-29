/** Client-side card + chip display helpers. */

export type SuitChar = 's' | 'h' | 'd' | 'c'

const SUIT_SYMBOLS: Record<SuitChar, string> = {
  s: '♠',
  h: '♥',
  d: '♦',
  c: '♣',
}

/** "As" → { rank: "A", suit: "s" } — null when the code is invalid. */
export function splitCard(code: string): { rank: string; suit: SuitChar } | null {
  if (!code || code.length !== 2) return null
  const rank = code[0].toUpperCase()
  const suit = code[1].toLowerCase() as SuitChar
  if (!'23456789TJQKA'.includes(rank)) return null
  if (!(suit in SUIT_SYMBOLS)) return null
  return { rank: rank === 'T' ? '10' : rank, suit }
}

export function suitSymbol(suit: SuitChar): string {
  return SUIT_SYMBOLS[suit]
}

export function isRedSuit(suit: SuitChar): boolean {
  return suit === 'h' || suit === 'd'
}

/** 12345 → "12,345" */
export function formatChips(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** Compact form for tight spaces: 12.5k / 3.4M */
export function formatChipsShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return formatChips(n)
}

export const PHASE_LABEL: Record<string, string> = {
  WAITING: 'Waiting for players',
  PREFLOP: 'Pre-flop',
  FLOP: 'Flop',
  TURN: 'Turn',
  RIVER: 'River',
  SHOWDOWN: 'Showdown',
}
