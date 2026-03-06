# Alert Queries (Prometheus-style examples)

## Signature failure rate
sum(rate(webhook_invalid_signature_total[5m])) / sum(rate(api_requests_total[5m])) > 0.02

## API rate-limited pressure
sum(rate(api_rate_limited_total[5m])) > 5

## Merchant auth failures spike
sum(rate(merchant_auth_forbidden_total[5m])) > 10

## Worker dead-letter spike
sum(rate(delivery_dead_letter_total[10m])) > 5

## Delivery retries abnormal growth
sum(rate(delivery_retry_scheduled_total[10m])) > 20
