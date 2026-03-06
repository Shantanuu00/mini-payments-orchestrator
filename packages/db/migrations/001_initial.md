# Migration 001_initial

## Purpose
Creates baseline schema objects used by the payment orchestration system.

## Forward safety
- Idempotent creation (`IF NOT EXISTS` and duplicate guards) where possible.
- Intended to be applied once in new environments.

## Rollback policy
- **Not safe for production rollback** because it drops core tables and data.
- `001_initial.down.sql` exists for controlled local/dev resets only.
- In production, prefer forward-fix migrations instead of destructive rollback.
