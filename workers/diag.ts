/**
 * TEMPORARY production diagnostics — captures fatal DO errors into D1 so the
 * reason survives the "error code: 1101" wall that the client otherwise sees.
 * Remove once the production regression is fixed and verified.
 */
import { setConfig } from './store'
import type { Env } from './env'

export async function captureDiag(env: Env, scope: string, e: unknown): Promise<void> {
  const err = e as Error | undefined
  const payload = JSON.stringify({
    at: Date.now(),
    scope,
    msg: String(err?.message ?? e),
    stack: String(err?.stack ?? '').slice(0, 4000),
  })
  try {
    await setConfig(env.DB, 'diag:last', payload)
  } catch {
    /* D1 itself unavailable — console is all we have left */
  }
  console.error(`[diag:${scope}]`, e)
}
