# Problem Brief: Mini Payment Orchestrator

## User
Merchant backend engineers integrating payments.

## Problem
Payments involve unreliable external systems. Requests can be duplicated and results can be delayed. Merchants need a reliable way to avoid double charging and to eventually know the final status.

## What we’re building (V1)
A service that provides unified payment APIs and maintains a consistent payment state by using idempotency, attempt logging, and webhook reconciliation.

## Not building
No PCI/card storage, no bank integration, no fraud, no chargebacks.
