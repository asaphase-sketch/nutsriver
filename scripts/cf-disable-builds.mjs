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
    console.log('[cf-maintenance] [1/5] discover builds-registered workers');
    const all = await api('GET', `${BASE}/workers`);
    console.log('[cf-maintenance] GET /builds/workers status', all.status);
    console.log(all.text);

    console.log('[cf-maintenance] [2/5] worker record by name');
    const rec = await api('GET', `${BASE}/workers/${WORKER}`);
    console.log('[cf-maintenance] GET /builds/workers/royal-felt status', rec.status);
    console.log(rec.text);

    // external_script_id may be a system tag rather than the worker name.
    const candidates = new Set([WORKER]);
    const collect = (o) => {
      if (!o || typeof o !== 'object') return;
      if (typeof o.external_script_id === 'string') candidates.add(o.external_script_id);
      if (typeof o.externalScriptId === 'string') candidates.add(o.externalScriptId);
      if (typeof o.script_id === 'string') candidates.add(o.script_id);
      if (typeof o.script_name === 'string') candidates.add(o.script_name);
      Object.values(o).forEach(collect);
    };
    collect(all.json?.result);
    collect(rec.json?.result);
    console.log('[cf-maintenance] candidate ids:', [...candidates]);

    for (const id of candidates) {
      console.log(`[cf-maintenance] [3/5] listing triggers for "${id}"`);
      const list = await api('GET', `${BASE}/workers/${id}/triggers`);
      console.log('[cf-maintenance] status', list.status);
      console.log(list.text);

      const items = Array.isArray(list.json?.result)
        ? list.json.result
        : (list.json?.result?.triggers || list.json?.result?.items || []);
      const uuids = items.map((t) => t.uuid || t.id).filter(Boolean);
      if (!uuids.length) continue;

      console.log(`[cf-maintenance] [4/5] patching ${uuids.length} trigger(s) for "${id}"`);
      for (const u of uuids) {
        const patched = await api('PATCH', `${BASE}/triggers/${u}`, {
          branch_includes: ['__disabled__'],
          branch_excludes: ['**'],
        });
        console.log(`[cf-maintenance] PATCH ${u} -> ${patched.status}`);
        console.log(patched.text);
      }
    }

    console.log('[cf-maintenance] [5/5] done');
  } catch (e) {
    console.log('[cf-maintenance] non-fatal error:', e?.message || e);
  }
  process.exit(0);
})();
