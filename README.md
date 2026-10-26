# Webhook Redeliver (GitHub Action)

GitHub does **not** automatically redeliver failed webhook deliveries. This Action does, on a schedule, with no server or database:

- pages through `GET /repos/{owner}/{repo}/hooks/{hook_id}/deliveries` (cursor pagination, `per_page=100`, past the 100 limit)
- picks deliveries whose `status` is not `OK`, skipping any GUID that already has a successful delivery
- redelivers via `POST .../deliveries/{delivery_id}/attempts`
- backs off on 403/429 using `Retry-After` / `x-ratelimit-reset` headers
- stores its cursor (last clean run time) in the Actions cache and writes a job summary table

## Install

Add `.github/workflows/redeliver.yml`:

```yaml
name: Redeliver failed webhooks
on:
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:
permissions:
  contents: read
  actions: write
jobs:
  redeliver:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: 5012763083a-oss/webhook-redeliver-action@v1
        with:
          hook_id: "123456789"   # Settings > Webhooks > number in the hook URL
          token: ${{ secrets.WEBHOOK_REDELIVER_TOKEN }}
```

### Token

Listing and redelivering hook deliveries needs repo admin rights. The default `GITHUB_TOKEN` usually cannot do this, so store a PAT as a secret:

- classic PAT: `admin:repo_hook` scope (or `repo` + admin on the repo), or
- fine-grained PAT: **Webhooks: Read and write** on the repository.

The token is only read from the `token` input or the `GITHUB_TOKEN` env var and is masked in logs. Never commit it.

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `hook_id` | yes | | numeric webhook ID |
| `owner` | no | current repo owner | |
| `repo` | no | current repo | |
| `scope` | no | `repo` | only `repo` is supported; `org` fails with a clear error |
| `since` | no | cached cursor | ISO-8601; overrides the cache |
| `token` | no | env `GITHUB_TOKEN` | see above |

**Cursor:** after a run where every redelivery was accepted, the run start time is cached under `webhook-redeliver-{owner}-{repo}-{hook_id}`. On a cache miss with no `since`, the Action looks back **24 hours** (GitHub keeps delivery history for a few days, and 24h catches outages that started before the first run). If any redelivery fails, the cursor is not advanced so the next run retries.

Outputs: `scanned`, `redelivered`, `failed`.

## Develop

```
npm ci && npm test && npm run build   # dist/index.js is committed so the Action runs without install
```

## Want more?

- **Pro pack ($9):** Slack/Discord alert step, multi-hook matrix workflow, org-wide template notes: https://webhook-relay.gmitchell-relay.workers.dev/go/redeliver?ref=github
- **Webhook Relay Kit ($19):** catch and replay webhooks locally: https://webhook-relay.gmitchell-relay.workers.dev/go/kit?ref=redeliver

---

Not affiliated with or endorsed by GitHub. MIT licensed.
