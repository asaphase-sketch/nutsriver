/**
 * Raw WS handshake probe — prints the exact HTTP status of the upgrade.
 * Usage: bun scripts/ws-probe.ts <base> <table>
 */
import http from 'node:http'
import https from 'node:https'

const base = process.argv[2] ?? 'http://localhost:3000'
const table = process.argv[3] ?? 'beginners'
const url = new URL(`${base}/api/auth/register`)
const reg = await fetch(`${base}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: `Probe${Math.floor(Math.random() * 999999)}`, password: 'probe-pass-123' }),
})
const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0]
if (!cookie) {
  console.error('register failed', reg.status)
  process.exit(1)
}

const wsUrl = new URL(`${base.replace(/^http/, 'ws')}/api/poker-socket?table=${table}`)
const isHttps = wsUrl.protocol === 'wss:'
const mod = isHttps ? https : http
const req = mod.request(
  {
    hostname: wsUrl.hostname,
    port: wsUrl.port || (isHttps ? 443 : 80),
    path: wsUrl.pathname + wsUrl.search,
    method: 'GET',
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      cookie,
    },
  },
  (res) => {
    console.log('upgrade status:', res.statusCode)
    console.log('headers:', JSON.stringify(res.headers, null, 2).slice(0, 500))
    let body = ''
    res.on('data', (d) => (body += d))
    res.on('end', () => {
      if (body) console.log('body:', body.slice(0, 300))
      process.exit(0)
    })
  },
)
req.on('error', (e) => {
  console.error('req error', e.message)
  process.exit(1)
})
req.end()
setTimeout(() => {
  console.log('no response in 15s')
  process.exit(1)
}, 15000)
