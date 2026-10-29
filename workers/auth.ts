/**
 * Auth primitives for the Workers runtime (WebCrypto only — no node:crypto).
 *
 * Session tokens keep the exact same wire format as the original scheme:
 *   token = base64url(JSON {uid, exp}).base64url(HMAC-SHA256(body))
 *
 * Passwords: PBKDF2-SHA256 with a per-user salt. Iterations are tuned for the
 * Workers free plan (10ms CPU budget per invocation) — paired with strict
 * rate limiting on the auth endpoints this is appropriate for a play-money
 * game where chips have no monetary value.
 */

const PBKDF2_ITERATIONS = 25_000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface SessionPayload {
  uid: string
  exp: number
}

// ---------- base64url helpers ----------

function bytesToB64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlToBytes(s: string): Uint8Array | null {
  try {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function textToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

// ---------- HMAC session tokens ----------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', textToBytes(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signToken(payload: SessionPayload, secret: string): Promise<string> {
  const body = bytesToB64url(textToBytes(JSON.stringify(payload)))
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, textToBytes(body) as BufferSource)
  return `${body}.${bytesToB64url(new Uint8Array(sig))}`
}

export async function verifyToken(token: string, secret: string): Promise<SessionPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const sigBytes = b64urlToBytes(sig)
  if (!sigBytes) return null
  const key = await hmacKey(secret)
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes as BufferSource, textToBytes(body) as BufferSource)
  if (!ok) return null
  const json = b64urlToBytes(body)
  if (!json) return null
  try {
    const payload = JSON.parse(new TextDecoder().decode(json)) as SessionPayload
    if (!payload.uid || typeof payload.exp !== 'number') return null
    if (payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export function sessionExpiry(): number {
  return Date.now() + SESSION_TTL_MS
}

// ---------- password hashing (PBKDF2-SHA256) ----------

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(v)) return null
    out[i] = v
  }
  return out
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const keyMaterial = await crypto.subtle.importKey('raw', textToBytes(password) as BufferSource, 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    256,
  )
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(new Uint8Array(bits))}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  const salt = fromHex(parts[2] ?? '')
  const expected = fromHex(parts[3] ?? '')
  if (!salt || !expected || !Number.isFinite(iterations) || iterations < 1 || iterations > 5_000_000) return false
  const keyMaterial = await crypto.subtle.importKey('raw', textToBytes(password) as BufferSource, 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    keyMaterial,
    expected.length * 8,
  )
  return timingSafeEqual(new Uint8Array(bits), expected)
}

// ---------- cookies ----------

export function parseCookie(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!cookieHeader) return out
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

export function sessionCookie(token: string): string {
  return `poker_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
}

export function clearedSessionCookie(): string {
  return 'poker_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0'
}
