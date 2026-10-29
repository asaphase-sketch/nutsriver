// One-off maintenance: disable the redundant Cloudflare Workers Builds
// git-integration triggers for royal-felt. Runs inside `wrangler deploy`
// (build.command) where CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are set.
// NEVER fails the deploy: all errors are logged and swallowed.
const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const WORKER = 'royal-felt';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/builds`;

if (!ACCT || !TOKEN) {
  console.log('[cf-maintenance] missing env, skipping (non-fatal)');
  process.exit(0);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, json, text: text.slice(0, 1500) };
}

(async () => {
  try {
    console.log('[cf-maintenance] listing build triggers for', WORKER);
    const list = await api('GET', `${BASE}/workers/${WORKER}/triggers`);
    console.log('[cf-maintenance] GET triggers status', list.status);
    console.log(list.text);

    const items = Array.isArray(list.json?.result)
      ? list.json.result
      : (list.json?.result?.triggers || list.json?.result?.items || []);
    const uuids = items
      .map((t) => t.uuid || t.id)
      .filter(Boolean);
    console.log('[cf-maintenance] trigger uuids:', uuids);

    for (const u of uuids) {
      const patched = await api('PATCH', `${BASE}/triggers/${u}`, {
        branch_includes: ['__disabled__'],
        branch_excludes: ['**'],
      });
      console.log(`[cf-maintenance] PATCH ${u} -> ${patched.status}`);
      console.log(patched.text);
    }

    const verify = await api('GET', `${BASE}/workers/${WORKER}/triggers`);
    console.log('[cf-maintenance] verify status', verify.status);
    console.log(verify.text);
  } catch (e) {
    console.log('[cf-maintenance] non-fatal error:', e?.message || e);
  }
  process.exit(0);
})();
