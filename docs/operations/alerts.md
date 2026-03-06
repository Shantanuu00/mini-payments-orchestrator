# Alert Thresholds

- API availability < 99.5% over 5 minutes -> page
- p95 confirm latency > 500ms over 10 minutes -> warn
- `INVALID_WEBHOOK_SIGNATURE` rate > 2% over 5 minutes -> warn
- pending deliveries > 1000 or oldest pending > 15 minutes -> page
- dead-lettered deliveries increase > 50 in 10 minutes -> page
