// Pure logic for redelivering failed GitHub webhook deliveries. fetch/sleep/now are injectable for tests.
export const API = "https://api.github.com";
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// How long to wait before retrying a 403/429, from GitHub rate-limit headers. null = not a rate limit.
export function backoffMs(res, now = Date.now(), attempt = 0) {
  if (res.status !== 429 && res.status !== 403) return null;
  const h = k => res.headers.get(k);
  const ra = h("retry-after");
  if (ra != null && !isNaN(+ra)) return Math.max(0, +ra * 1000);
  if (h("x-ratelimit-remaining") === "0" && h("x-ratelimit-reset")) return Math.max(0, +h("x-ratelimit-reset") * 1000 - now) + 1000;
  if (res.status === 429) return Math.min(60000 * 2 ** attempt, 15 * 60000); // secondary limit, no headers: >=1 min, exponential
  return null; // plain 403 = permission problem, don't retry
}

// fetch with rate-limit backoff. maxWaitMs caps a single wait so a job never hangs past its timeout.
export async function ghFetch(url, init, { fetch = globalThis.fetch, sleep: zz = sleep, now = Date.now, retries = 4, maxWaitMs = 10 * 60000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    const wait = backoffMs(res, now(), attempt);
    if (wait == null || attempt >= retries) return res;
    if (wait > maxWaitMs) throw new Error(`Rate limited; reset in ${Math.ceil(wait / 1000)}s exceeds max wait`);
    await zz(wait);
  }
}

const headers = token => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "webhook-redeliver-action" });
const nextLink = link => (link || "").split(",").map(s => s.match(/<([^>]+)>;\s*rel="next"/)).find(Boolean)?.[1] || null;

// Pages newest-first through GET /repos/{o}/{r}/hooks/{id}/deliveries (cursor, per_page=100) until older than sinceMs.
export async function fetchDeliveriesSince({ owner, repo, hookId, token, sinceMs, maxPages = 50 }, opt = {}) {
  let url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${encodeURIComponent(hookId)}/deliveries?per_page=100`;
  const out = [];
  for (let page = 0; url && page < maxPages; page++) {
    const res = await ghFetch(url, { headers: headers(token) }, opt);
    if (!res.ok) throw new Error(`List deliveries failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
    const batch = await res.json();
    let done = false;
    for (const d of batch) { if (Date.parse(d.delivered_at) < sinceMs) { done = true; break; } out.push(d); }
    if (done || !batch.length) break;
    url = nextLink(res.headers.get("link"));
  }
  return out;
}

// Failed deliveries (status !== "OK"), one per GUID (latest), skipping any GUID that has a later OK delivery.
export function selectFailedNeedingRedeliver(deliveries) {
  const byGuid = new Map();
  for (const d of deliveries) { const a = byGuid.get(d.guid) || []; a.push(d); byGuid.set(d.guid, a); }
  const pick = [];
  for (const list of byGuid.values()) {
    list.sort((a, b) => Date.parse(b.delivered_at) - Date.parse(a.delivered_at) || b.id - a.id);
    const latest = list[0];
    if (latest.status === "OK") continue;                 // later success already exists
    if (list.some(d => d.status === "OK")) continue;      // any success for this GUID -> skip
    pick.push(latest);
  }
  return pick.sort((a, b) => Date.parse(a.delivered_at) - Date.parse(b.delivered_at));
}

// POST /repos/{o}/{r}/hooks/{id}/deliveries/{delivery_id}/attempts -> 202 Accepted on success.
export async function redeliverOne({ owner, repo, hookId, token, delivery }, opt = {}) {
  const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${encodeURIComponent(hookId)}/deliveries/${encodeURIComponent(delivery.id)}/attempts`;
  const res = await ghFetch(url, { method: "POST", headers: headers(token) }, opt);
  return { id: delivery.id, guid: delivery.guid, event: delivery.action ? `${delivery.event}.${delivery.action}` : delivery.event, status: res.status, ok: res.status === 202 || res.ok };
}

export async function run({ owner, repo, hookId, token, sinceMs, scope = "repo", maxRedeliveries = 100 }, opt = {}) {
  if (scope !== "repo") throw new Error(`scope "${scope}" is not supported yet; only "repo" is supported`);
  const all = await fetchDeliveriesSince({ owner, repo, hookId, token, sinceMs }, opt);
  const failed = selectFailedNeedingRedeliver(all).slice(0, maxRedeliveries);
  const results = [];
  for (const delivery of failed) results.push(await redeliverOne({ owner, repo, hookId, token, delivery }, opt));
  return { scanned: all.length, results };
}
