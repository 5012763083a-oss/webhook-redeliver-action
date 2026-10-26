# Sources

- Handling failed webhook deliveries (GitHub does not auto-redeliver; script pattern): https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
- Automatically redelivering failed deliveries for a repository webhook: https://docs.github.com/en/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-a-repository-webhook
- REST: Repository webhooks (list deliveries, redeliver attempts): https://docs.github.com/en/rest/repos/webhooks
- REST pagination (Link header, cursor): https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
- REST rate limits (retry-after, x-ratelimit-*): https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Actions cache toolkit: https://github.com/actions/toolkit/tree/main/packages/cache
- Job summaries: https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-job-summary
