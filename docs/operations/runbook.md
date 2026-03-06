# Operations Runbook

## Service startup order
1. Postgres reachable
2. Apply migrations: `npm run db:migrate -w packages/db`
3. Start API
4. Start worker
5. Start web dashboard

## Incident: webhook failures spike
- Check API `/health` and logs for `INVALID_WEBHOOK_SIGNATURE` or `UNAUTHORIZED_WEBHOOK`.
- Validate signing secrets/shared tokens on producer and API.
- Confirm DB is healthy and `provider_webhook_events` inserts succeed.

## Incident: delivery backlog growth
- Query `merchant_webhook_deliveries` pending rows and `next_retry_at` distribution.
- Validate `MERCHANT_WEBHOOK_URL` endpoint health.
- Scale worker replicas and confirm no dead-letter saturation.

## Incident: high 429s
- Inspect `RATE_LIMIT_RPM` configuration.
- If abusive traffic: keep threshold and filter at ingress.
- If legitimate traffic: increase threshold and add tiered limits.
