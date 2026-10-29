/**
 * Stand up lingering human seats on a production table (zombie cleanup).
 * Usage: bun scripts/standup-users.ts <tableKey> user1:pass1 [user2:pass2 ...]
 */
export {}

const BASE = process.env.E2E_BASE ?? 'https://royal-felt.aj-poker-app.workers.dev'
const table = process.argv[2]
const creds = process.argv.slice(3)

if (!table || creds.length === 0) {
  console.error('usage: bun scripts/standup-users.ts <tableKey> user:pass [user:pass ...]')
  process.exit(2)
}

async function standUpOne(cred: string): Promise<void> {
  const [username, password] = cred.split(':')
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const setCookie = login.headers.get('set-cookie') ?? ''
  const token = /poker_session=([^;]+)/.exec(setCookie)?.[1]
  if (!token) {
    console.error(`✗ ${username}: login failed (${login.status})`)
    return
  }
  const cookie = `poker_session=${token}`

  const url = BASE.replace(/^http/, 'ws') + `/api/poker-socket?table=${table}`
  const ws = new WebSocket(url, { headers: { cookie } } as unknown as string[])

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    setTimeout(() => reject(new Error('ws open timeout')), 8000)
  })

  const done = new Promise<void>((resolve) => {
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string)
        if (data.t === 'state' && data.view?.selfSeat == null) resolve()
      } catch {
        /* ignore */
      }
    }
    setTimeout(resolve, 6000)
  })

  ws.send(JSON.stringify({ t: 'hello' }))
  await new Promise((r) => setTimeout(r, 500))
  ws.send(JSON.stringify({ t: 'stand' }))
  await done
  ws.close()

  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })
  const body = (await me.json()) as { user?: { chips: number } }
  console.log(`✓ ${username}: stood up, balance ${body.user?.chips ?? '?'}`)
}

for (const cred of creds) {
  await standUpOne(cred)
}
console.log('cleanup done')
process.exit(0)
