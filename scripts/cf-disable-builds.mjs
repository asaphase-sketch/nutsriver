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
    console.log('[cf-maintenance] [1/4] account-wide trigger list');
    const all = await api('GET', `${BASE}/triggers`);
    console.log('[cf-maintenance] GET /builds/triggers status', all.status);
    console.log(all.text);

    // Collect every trigger uuid; prefer ones tied to royal-felt but patch
    // anything that references our worker name.
    const items = Array.isArray(all.json?.result)
      ? all.json.result
      : (all.json?.result?.triggers || all.json?.result?.items || []);
    const mine = items.filter((t) => {
      const blob = JSON.stringify(t).toLowerCase();
      return blob.includes(WORKER);
    });
    const uuids = mine.map((t) => t.uuid || t.id).filter(Boolean);
    console.log('[cf-maintenance] royal-felt trigger uuids:', uuids);

    if (uuids.length) {
      console.log('[cf-maintenance] [2/4] patching triggers (never-match branch filters)');
      for (const u of uuids) {
        const patched = await api('PATCH', `${BASE}/triggers/${u}`, {
          branch_includes: ['__disabled__'],
          branch_excludes: ['**'],
        });
        console.log(`[cf-maintenance] PATCH ${u} -> ${patched.status}`);
        console.log(patched.text);
      }
    } else {
      console.log('[cf-maintenance] [2/4] no matching triggers in account list');
    }

    console.log('[cf-maintenance] [3/4] recent builds for royal-felt (context)');
    const builds = await api('GET', `${BASE}/workers/royal-felt/builds?per_page=2`);
    console.log('[cf-maintenance] status', builds.status);
    console.log(builds.text);

    console.log('[cf-maintenance] [4/4] done');
  } catch (e) {
    console.log('[cf-maintenance] non-fatal error:', e?.message || e);
  }
  process.exit(0);
})();
