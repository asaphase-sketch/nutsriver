/**
 * TEMP one-shot Cloudflare cleanup — runs inside the Deploy job (wrangler
 * build.command) where CLOUDFLARE_API_TOKEN exists. Removed right after.
 *
 * Steps (each fail-soft, loud output, never fails the deploy):
 *  1. Re-verify only `royal-felt` exists as a Worker → nothing else can bind
 *     the orphan resources, so deleting them cannot break any app.
 *  2. Delete orphan KV namespace HEARTS_KV (exact id pinned below).
 *  3. Delete orphan D1 databases `poker-demo` and `poker-db` (exact ids).
 *  4. Try to create a Cloudflare Web Analytics site (free plugin); print the
 *     site tag + token so it can be wired into the app in the next commit.
 */
const ACCOUNT = '52eaa8e8f08d38e99d542c2b309663e8'
const KV_HEARTS_ID = '1ef2accf8ae848ee8e6d1e7e168ac1eb'
const D1_ORPHANS = [
  { name: 'poker-demo', id: '555eb6ea-df04-4ce5-b700-e6e543edacca' },
  { name: 'poker-db', id: 'd907295b-cdf4-48a4-a7a9-c7e5e58ac9f6' },
]

const api = async (path, init) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    /* non-json */
  }
  return { status: res.status, body }
}

const j = (x) => JSON.stringify(x)
const guard = []

// 1 — workers: only royal-felt may exist
try {
  const { status, body } = await api(`/accounts/${ACCOUNT}/workers/scripts`)
  const ids = (body?.result ?? []).map((w) => w.id)
  console.log(`[cf-clean] workers (${status}):`, j(ids))
  if (ids.length === 1 && ids[0] === 'royal-felt') {
    guard.push('workers-ok')
  } else {
    console.log('[cf-clean] ABORT deletes — unexpected worker set')
  }
} catch (e) {
  console.log('[cf-clean] workers list failed:', e?.message)
}

// 2 — orphan KV
try {
  const { status, body } = await api(`/accounts/${ACCOUNT}/storage/kv/namespaces`)
  const list = (body?.result ?? []).map((n) => ({ id: n.id, title: n.title }))
  console.log(`[cf-clean] kv namespaces (${status}):`, j(list))
  if (guard.includes('workers-ok') && list.some((n) => n.id === KV_HEARTS_ID)) {
    const del = await api(`/accounts/${ACCOUNT}/storage/kv/namespaces/${KV_HEARTS_ID}`, { method: 'DELETE' })
    console.log(`[cf-clean] delete HEARTS_KV: ${del.status} success=${del.body?.success} errors=${j(del.body?.errors)}`)
  } else {
    console.log('[cf-clean] HEARTS_KV not found or guard failed — skip')
  }
} catch (e) {
  console.log('[cf-clean] kv step failed:', e?.message)
}

// 3 — orphan D1 databases
try {
  const { status, body } = await api(`/accounts/${ACCOUNT}/d1/database`)
  const list = (body?.result ?? []).map((d) => ({ id: d.uuid ?? d.id, name: d.name, size: d.file_size }))
  console.log(`[cf-clean] d1 databases (${status}):`, j(list))
  for (const orphan of D1_ORPHANS) {
    if (!guard.includes('workers-ok') || !list.some((d) => d.id === orphan.id)) {
      console.log(`[cf-clean] skip ${orphan.name} (not found or guard failed)`)
      continue
    }
    const del = await api(`/accounts/${ACCOUNT}/d1/database/${orphan.id}`, { method: 'DELETE' })
    console.log(`[cf-clean] delete D1 ${orphan.name}: ${del.status} success=${del.body?.success} errors=${j(del.body?.errors)}`)
  }
} catch (e) {
  console.log('[cf-clean] d1 step failed:', e?.message)
}

// 4 — free Cloudflare Web Analytics (best effort)
try {
  const create = await api(`/accounts/${ACCOUNT}/websaas/analytics/site`, {
    method: 'POST',
    body: JSON.stringify({ host: 'royal-felt.aj-poker-app.workers.dev' }),
  })
  const r = create.body?.result ?? {}
  console.log(`[cf-clean] web analytics (${create.status}): tag=${r.site_tag ?? r.tag ?? '?'} token=${r.site_token ?? r.token ?? '?'} errors=${j(create.body?.errors)}`)
} catch (e) {
  console.log('[cf-clean] web analytics failed:', e?.message)
}

// final state
try {
  const kv = await api(`/accounts/${ACCOUNT}/storage/kv/namespaces`)
  const d1 = await api(`/accounts/${ACCOUNT}/d1/database`)
  console.log('[cf-clean] FINAL kv:', j((kv.body?.result ?? []).map((n) => n.title)))
  console.log('[cf-clean] FINAL d1:', j((d1.body?.result ?? []).map((d) => d.name)))
} catch (e) {
  console.log('[cf-clean] final listing failed:', e?.message)
}
console.log('[cf-clean] done (exit 0)')
