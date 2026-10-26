import test, { after } from "node:test"; import assert from "node:assert/strict";
import { fetchDeliveriesSince, selectFailedNeedingRedeliver, redeliverOne, backoffMs, ghFetch, run } from "../src/redeliver.js";

const T0 = Date.parse("2026-10-26T12:00:00Z");
const iso = m => new Date(T0 - m * 60000).toISOString(); // m minutes ago
const d = (id, guid, status, minAgo, event = "push") => ({ id, guid, status, delivered_at: iso(minAgo), event, action: null });
const res = (status, body = null, hdr = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: hdr });
// Mock fetch: route by method + URL, records calls.
function mock(handler) { const calls = []; const f = async (url, init = {}) => { calls.push({ url, method: init.method || "GET" }); return handler(url, init, calls.length); }; f.calls = calls; return f; }
const noSleep = []; const sleep = async ms => { noSleep.push(ms); };
const base = { owner: "o", repo: "r", hookId: "1", token: "t", sinceMs: T0 - 24 * 3600e3 };
let passed = 0; const t = (n, fn) => test(n, async () => { await fn(); passed++; });
after(() => { if (passed === 11) console.log("ALL TESTS PASSED (11/11)"); });

t("empty delivery list -> nothing redelivered", async () => {
  const f = mock(() => res(200, []));
  const out = await run(base, { fetch: f, sleep });
  assert.deepEqual(out, { scanned: 0, results: [] }); assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/repos\/o\/r\/hooks\/1\/deliveries\?per_page=100$/);
});
t(">100 deliveries: follows Link cursor across pages", async () => {
  const pages = [0, 1, 2].map(p => Array.from({ length: p < 2 ? 100 : 30 }, (_, i) => d(p * 100 + i, "g" + (p * 100 + i), "OK", p * 100 + i)));
  const f = mock((url) => { const p = +(new URL(url).searchParams.get("cursor") || 0);
    return res(200, pages[p], p < 2 ? { link: `<https://api.github.com/repos/o/r/hooks/1/deliveries?per_page=100&cursor=${p + 1}>; rel="next"` } : {}); });
  const all = await fetchDeliveriesSince(base, { fetch: f, sleep });
  assert.equal(all.length, 230); assert.equal(f.calls.length, 3);
});
t("stops paging once deliveries are older than since", async () => {
  const f = mock(() => res(200, [d(1, "a", "OK", 10), d(2, "b", "OK", 3000)], { link: '<https://api.github.com/x?cursor=9>; rel="next"' }));
  const all = await fetchDeliveriesSince({ ...base, sinceMs: T0 - 60 * 60000 }, { fetch: f, sleep });
  assert.deepEqual(all.map(x => x.id), [1]); assert.equal(f.calls.length, 1);
});
t("GUID with a later successful delivery is skipped; failures picked once per GUID", () => {
  const pick = selectFailedNeedingRedeliver([d(1, "a", "Invalid HTTP Response: 500", 30), d(2, "a", "OK", 10),
    d(3, "b", "timed out", 20), d(4, "b", "Invalid HTTP Response: 502", 5), d(5, "c", "OK", 1)]);
  assert.deepEqual(pick.map(x => x.id), [4]);
});
t("redeliverOne POSTs to .../attempts and treats 202 as ok", async () => {
  const f = mock(() => res(202, {}));
  const r = await redeliverOne({ ...base, delivery: { ...d(77, "g", "fail", 1), event: "issues", action: "opened" } }, { fetch: f, sleep });
  assert.deepEqual(r, { id: 77, guid: "g", event: "issues.opened", status: 202, ok: true });
  assert.equal(f.calls[0].method, "POST"); assert.match(f.calls[0].url, /\/hooks\/1\/deliveries\/77\/attempts$/);
});
t("429 with Retry-After waits then retries successfully", async () => {
  noSleep.length = 0;
  const f = mock((u, i, n) => n === 1 ? res(429, null, { "retry-after": "7" }) : res(202, {}));
  const r = await redeliverOne({ ...base, delivery: d(1, "g", "x", 1) }, { fetch: f, sleep });
  assert.equal(r.ok, true); assert.deepEqual(noSleep, [7000]); assert.equal(f.calls.length, 2);
});
t("403 primary rate limit waits until x-ratelimit-reset", async () => {
  noSleep.length = 0; const reset = Math.floor(T0 / 1000) + 30;
  const f = mock((u, i, n) => n === 1 ? res(403, null, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }) : res(200, []));
  await fetchDeliveriesSince(base, { fetch: f, sleep, now: () => T0 });
  assert.deepEqual(noSleep, [31000]);
});
t("plain 403 (no rate-limit headers) is not retried and surfaces an error", async () => {
  const f = mock(() => res(403, { message: "Must have admin rights" }));
  await assert.rejects(fetchDeliveriesSince(base, { fetch: f, sleep }), /HTTP 403/); assert.equal(f.calls.length, 1);
});
t("backoff wait beyond maxWaitMs throws instead of hanging", async () => {
  const f = mock(() => res(429, null, { "retry-after": "3600" }));
  await assert.rejects(ghFetch("u", {}, { fetch: f, sleep, maxWaitMs: 60000 }), /exceeds max wait/);
  assert.equal(backoffMs(res(200)), null);
});
t("end to end: only failed GUIDs without success are redelivered", async () => {
  const list = [d(1, "a", "OK", 5), d(2, "b", "Invalid HTTP Response: 500", 6), d(3, "a", "timed out", 9)];
  const f = mock((url, init) => init.method === "POST" ? res(202, {}) : res(200, list));
  const out = await run(base, { fetch: f, sleep });
  assert.equal(out.scanned, 3); assert.deepEqual(out.results.map(r => r.id), [2]);
});
t("org scope is rejected with a clear error", async () => {
  await assert.rejects(run({ ...base, scope: "org" }, { fetch: mock(() => res(200, [])), sleep }), /not supported yet/);
});
