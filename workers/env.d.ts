/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Workers bindings for NutsRiver.
 * Deployed on the free plan: Workers (static assets + API) + D1 (accounts
 * ledger) + Durable Objects (one per cash table, one per tournament;
 * alarm-driven, hibernation-ready).
 */
export interface Env {
  DB: D1Database
  TABLE: DurableObjectNamespace
  TOURNAMENT: DurableObjectNamespace
  LOBBY: DurableObjectNamespace
  ASSETS: Fetcher
  AUTH_SECRET: string
  /** set to "1" in dev/CI to shorten game timings for fast E2E */
  E2E_FAST?: string
}
