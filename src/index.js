import * as core from "@actions/core";
import * as cache from "@actions/cache";
import fs from "node:fs";
import path from "node:path";
import { run } from "./redeliver.js";

const DEFAULT_LOOKBACK_MS = 24 * 3600 * 1000; // cache miss + no `since`: last 24h (GitHub keeps deliveries ~3 days)

async function main() {
  const [defOwner, defRepo] = (process.env.GITHUB_REPOSITORY || "/").split("/");
  const hookId = core.getInput("hook_id", { required: true });
  const owner = core.getInput("owner") || defOwner;
  const repo = core.getInput("repo") || defRepo;
  const scope = core.getInput("scope") || "repo";
  const since = core.getInput("since");
  const token = core.getInput("token") || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("No token: pass `token: ${{ secrets.WEBHOOK_REDELIVER_TOKEN }}` (needs admin:repo_hook / repo admin)");
  if (!/^\d+$/.test(hookId)) throw new Error("hook_id must be numeric");
  core.setSecret(token);

  const dir = path.join(process.env.RUNNER_TEMP || "/tmp", "webhook-redeliver");
  const file = path.join(dir, "cursor.json");
  const key = `webhook-redeliver-${owner}-${repo}-${hookId}`;
  fs.mkdirSync(dir, { recursive: true });
  let sinceMs = since ? Date.parse(since) : NaN;
  if (since && isNaN(sinceMs)) throw new Error("since must be an ISO-8601 timestamp");
  if (!since) {
    try { if (await cache.restoreCache([dir], key + "-", [key + "-"])) sinceMs = JSON.parse(fs.readFileSync(file, "utf8")).lastRunMs; }
    catch (e) { core.warning(`cache restore failed: ${e.message}`); }
    if (!Number.isFinite(sinceMs)) sinceMs = Date.now() - DEFAULT_LOOKBACK_MS;
  }
  const startedMs = Date.now();
  const { scanned, results } = await run({ owner, repo, hookId, token, sinceMs, scope }, { sleep: ms => { core.info(`rate limited, waiting ${Math.ceil(ms / 1000)}s`); return new Promise(r => setTimeout(r, ms)); } });

  const failed = results.filter(r => !r.ok);
  core.setOutput("scanned", scanned); core.setOutput("redelivered", results.length - failed.length); core.setOutput("failed", failed.length);
  await core.summary.addHeading("Webhook Redeliver", 2)
    .addRaw(`Scanned ${scanned} deliveries since ${new Date(sinceMs).toISOString()} for ${owner}/${repo} hook ${hookId}.`, true)
    .addTable([[{ data: "Delivery ID", header: true }, { data: "GUID", header: true }, { data: "Event", header: true }, { data: "Status", header: true }],
      ...results.map(r => [String(r.id), r.guid, r.event, r.ok ? `${r.status} redelivered` : `${r.status} failed`])])
    .write();

  if (failed.length === 0) { // only advance the cursor after a clean run, so failures are retried next time
    try { fs.writeFileSync(file, JSON.stringify({ lastRunMs: startedMs })); await cache.saveCache([dir], `${key}-${startedMs}`); }
    catch (e) { core.warning(`cache save failed: ${e.message}`); }
  } else core.setFailed(`${failed.length} redelivery request(s) failed`);
}
main().catch(e => core.setFailed(e.message));
