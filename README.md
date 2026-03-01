# Mini Payment Orchestrator

A small monorepo payment orchestration demo inspired by Hyperswitch.

## Architecture Overview

This repository is organized as a monorepo with app and package boundaries:

- `apps/api` (Fastify + TypeScript)
  - Exposes payment APIs and OpenAPI docs at `/docs`.
  - Handles payment create/confirm/fetch and provider webhook ingestion.
- `apps/worker` (Node.js + TypeScript)
  - Periodically resolves expired `processing` payments to `manual_review`.
  - Handles merchant webhook delivery retries with backoff.
- `apps/web` (Next.js App Router)
  - Demo dashboard for creating/confirming payments and simulating webhooks.
  - Reads API origin from `NEXT_PUBLIC_API_BASE_URL`.
- `packages/core`
  - Payment domain/state transition logic (`applyPaymentTransition`) and shared schemas.
- `packages/db`
  - PostgreSQL schema and DB helpers.

## Environment Variables

### API (`apps/api`)

- `DATABASE_URL` - PostgreSQL connection string (read by DB layer used by API).
- `PORT` - API listen port (default: `8080`).

### Worker (`apps/worker`)

- `DATABASE_URL` - PostgreSQL connection string.
- `MERCHANT_WEBHOOK_URL` - demo destination URL for outbound merchant webhook deliveries.

### Web (`apps/web`)

- `NEXT_PUBLIC_API_BASE_URL` - public base URL for API requests from the browser.

## Local Run

### 1) Install dependencies

```bash
npm install
```

### 2) Start Postgres

You can run Postgres with your preferred setup (Docker/local/cloud). Example `DATABASE_URL`:

```bash
export DATABASE_URL='postgres://postgres:postgres@localhost:5432/mini_payments'
```

### 3) Apply schema

```bash
npm run db:apply -w packages/db
```

### 4) Run services

API:

```bash
npm run dev:api
```

Worker:

```bash
export MERCHANT_WEBHOOK_URL='https://webhook.site/your-id'
npm run worker:dev
```

Web:

```bash
export NEXT_PUBLIC_API_BASE_URL='http://localhost:8080'
npm run dev:web
```

## Cloud Deployment (Neon + Render + Vercel)

### 1) Neon (Postgres)

1. Create a Neon project and database.
2. Copy the Neon connection string as `DATABASE_URL`.
3. Run schema apply once:

```bash
DATABASE_URL='<neon-url>' npm run db:apply -w packages/db
```

### 2) Render (API + Worker)

Create two Render services from this repo:

- **API service** (Node web service)
  - Build command: `npm install && npm run build -w apps/api`
  - Start command: `npm run start -w apps/api`
  - Env vars:
    - `DATABASE_URL=<neon-url>`
    - `PORT=10000` (or Render-provided port)

- **Worker service** (Node background worker)
  - Build command: `npm install && npm run build -w apps/worker`
  - Start command: `npm run start -w apps/worker`
  - Env vars:
    - `DATABASE_URL=<neon-url>`
    - `MERCHANT_WEBHOOK_URL=<your-merchant-endpoint-or-webhook.site-url>`

### 3) Vercel (Web)

1. Import repo in Vercel.
2. Set project root to `apps/web` (or use monorepo settings).
3. Add env var:
   - `NEXT_PUBLIC_API_BASE_URL=https://<your-render-api-domain>`
4. Deploy.

## Useful Commands

```bash
npm run test --workspaces
npm run typecheck --workspaces
npm run build --workspaces
```
