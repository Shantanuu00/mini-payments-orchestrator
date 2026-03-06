# SLO / SLI

## API availability
- SLI: successful responses / total requests
- Target: 99.9% monthly

## Confirm latency
- SLI: p95 `POST /payments/:id/confirm`
- Target: < 300ms (excluding provider timeout paths)

## Webhook processing
- SLI: webhook accepted and persisted within 1s
- Target: 99%

## Delivery reliability
- SLI: terminal payments with at least one successful merchant delivery within 10 minutes
- Target: 99%
