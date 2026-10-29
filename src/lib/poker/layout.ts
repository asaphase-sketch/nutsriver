/**
 * Seat anchoring around the oval felt.
 *
 * Layouts are SELF-CENTRIC: display slot 0 is always the bottom-center seat
 * (the viewing player), and the remaining slots continue clockwise around the
 * ellipse. The client maps every real seatIndex to a display slot via a
 * rotation offset so the local player automatically renders center-south.
 * Positions are percentages of the table container; the seat panel is
 * centered on the anchor with translate(-50%,-50%).
 */

export interface SeatAnchor {
  x: number
  y: number
  /** true when the hole cards should render below the name plate */
  cardsBelow: boolean
  align: 'left' | 'center' | 'right'
}

/**
 * Anchor clamps for seat plates.
 *
 * Seat plates are ~100px wide/~100px tall and centered on their anchor.
 * On a phone the felt is only ~366×420px, so an anchor at x=4.7% (9-max,
 * φ=280°) pushed the plate past the felt edge and got clipped by the felt's
 * overflow-hidden. Clamping X into [14, 86] keeps the plate fully inside at
 * phone widths while barely moving seats on desktop (14% of a 1100px felt is
 * 154px — visually still an oval ring). Y is clamped to [18, 88] for the
 * same reason: plates must survive short landscape felts and the self plate
 * must not graze the bottom rail in portrait.
 */
const SEAT_X_MIN = 14
const SEAT_X_MAX = 86
const SEAT_Y_MIN = 18
const SEAT_Y_MAX = 88

/** seat on an ellipse: φ measured clockwise on screen starting at the bottom */
function onOval(phiDeg: number, rx = 46, ry = 40): { x: number; y: number } {
  const rad = (phiDeg * Math.PI) / 180
  const rawX = 50 + rx * Math.sin(rad)
  const rawY = 50 + ry * Math.cos(rad)
  const x = Math.min(SEAT_X_MAX, Math.max(SEAT_X_MIN, rawX))
  const y = Math.min(SEAT_Y_MAX, Math.max(SEAT_Y_MIN, rawY))
  return {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
  }
}

/** build n slots clockwise from bottom-center, auto cardsBelow + align */
function ring(n: number): SeatAnchor[] {
  return Array.from({ length: n }, (_, i) => {
    const { x, y } = onOval((i * 360) / n)
    return {
      x,
      y,
      cardsBelow: y < 50,
      align: x >= 72 ? 'left' : x <= 28 ? 'right' : 'center',
    }
  })
}

const LAYOUTS: Record<number, SeatAnchor[]> = {
  2: ring(2),
  6: ring(6),
  9: ring(9),
}

/**
 * Anchor for a real seat, viewed with `rotation` as the bottom-center seat.
 * rotation = the seatIndex that should render at slot 0 (usually self).
 */
export function seatAnchor(seatIndex: number, maxSeats: number, rotation = 0): SeatAnchor {
  const layout = LAYOUTS[maxSeats] ?? LAYOUTS[9]!
  const n = layout.length
  if (seatIndex < 0 || seatIndex >= n) return { x: 50, y: 50, cardsBelow: false, align: 'center' }
  const slot = (((seatIndex - rotation) % n) + n) % n
  return layout[slot]!
}

/** display slot of a seat for the current rotation — 0 = bottom center */
export function displaySlot(seatIndex: number, maxSeats: number, rotation = 0): number {
  const n = LAYOUTS[maxSeats]?.length ?? 9
  return (((seatIndex - rotation) % n) + n) % n
}

/** Pull a point from a seat anchor toward the felt center (for bet chips). */
export function towardCenter(x: number, y: number, factor: number): { x: number; y: number } {
  return {
    x: x + (50 - x) * factor,
    y: y + (50 - y) * factor,
  }
}
