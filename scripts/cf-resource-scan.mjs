/**
 * TEMPORARY Cloudflare resource audit — runs inside the Deploy job (which has
 * CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) and prints every resource on
 * the account plus DO-vs-Worker request usage, so stray stuff can be cleaned
 * and the free-tier burn quantified. Read-only. Remove after the audit.
 */

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID
const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const base = `https://api.cloudflare.com/client/v4`

async function api(path) {
  try {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    const data = await res.json()
    return data.result ?? data.errors ?? data
  } catch (e) {
    return `FETCH FAILED: ${String(e)}`
  }
}

const gql = async (query) => {
  try {
    const res = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    return await res.json()
  } catch (e) {
    return { errors: String(e) }
  }
}

const today = new Date().toISOString().slice(0, 10)
const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)

const scripts = await api(`/accounts/${ACCOUNT}/workers/scripts`)
console.log('--- workers/scripts ---')
console.log(JSON.stringify(Array.isArray(scripts) ? scripts.map((s) => ({ id: s.id, modified: s.modified_on, created: s.created_on })) : scripts, null, 1))

const kv = await api(`/accounts/${ACCOUNT}/storage/kv/namespaces`)
console.log('--- kv namespaces ---')
console.log(JSON.stringify(kv, null, 1))

const r2 = await api(`/accounts/${ACCOUNT}/r2/buckets`)
console.log('--- r2 buckets ---')
console.log(JSON.stringify(r2, null, 1))

const d1 = await api(`/accounts/${ACCOUNT}/d1/database`)
console.log('--- d1 databases ---')
console.log(JSON.stringify(Array.isArray(d1) ? d1.map((x) => ({ name: x.name, id: x.uuid, size: x.file_size, tables: x.num_tables, version: x.version })) : d1, null, 1))

const queues = await api(`/accounts/${ACCOUNT}/queues`)
console.log('--- queues ---')
console.log(JSON.stringify(queues, null, 1))

const cronTriggers = await api(`/accounts/${ACCOUNT}/workers/scripts`)
console.log('--- workers/subdomain ---')
console.log(JSON.stringify(await api(`/accounts/${ACCOUNT}/workers/subdomain`), null, 1))

const usage = await gql(`query {
  viewer {
    accounts(filter: {accountTag: "${ACCOUNT}"}) {
      durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {date_geq: "${twoDaysAgo}", date_leq: "${today}"}) {
        dimensions { date }
        sum { requests }
      }
      workersInvocationsAdaptive(limit: 100, filter: {date_geq: "${twoDaysAgo}", date_leq: "${today}"}) {
        dimensions { date }
        sum { requests }
      }
    }
  }
}`)
console.log('--- request usage (GraphQL, DO + Worker) ---')
console.log(JSON.stringify(usage, null, 1))
