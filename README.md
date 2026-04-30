# GPTO Insights API Gateway

Pre-computed dashboard read-model service for the GPTO platform. Eliminates multi-minute query times by caching dashboard payloads and serving them instantly via a stale-while-revalidate pattern.

## Quick Start

```bash
pnpm install
cp .env.example .env   # then fill in real values
pnpm migrate
pnpm dev
```

The server starts at `http://127.0.0.1:4011`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Pooled Postgres connection string |
| `DATABASE_URL_UNPOOLED` | No | Direct connection for migrations |
| `INTERNAL_API_TOKEN` | Yes | Bearer token for all `/v1/` and `/internal/` routes |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins |
| `PORT` | No | Local dev port (default: 4011) |
| `DASHBOARD_REFRESH_COOLDOWN_SECONDS` | No | Min seconds between refresh attempts (default: 300) |

## API Endpoints

### Dashboard Read (cache-first)

- `GET /v1/dashboard/overview` – full aggregated dashboard
- `GET /v1/dashboard/module/:moduleKey` – single module data
- `GET /v1/llm-mentions/overview` – LLM mentions aggregation
- `GET /v1/llm-mentions/trends` – LLM mentions trend data
- `GET /v1/llm-mentions/competitors` – competitor comparison
- `GET /v1/llm-mentions/prompt-intelligence` – prompt analysis
- `GET /v1/llm-mentions/source-gap` – source gap analysis
- `GET /v1/sites` – list accessible sites
- `GET /v1/sites/:id/config` – site configuration
- `GET /v1/auth/me` – current user context

### Internal (refresh / admin)

- `GET /internal/health` – health check
- `POST /internal/refresh/dashboard` – force-refresh modules
- `POST /internal/refresh/llm-mentions` – force-refresh LLM data
- `POST /internal/refresh/process` – claim and process queued jobs

### Auth

All `/v1/` and `/internal/` endpoints require:

```
Authorization: Bearer <INTERNAL_API_TOKEN>
```

User context is forwarded via headers:

```
x-gpto-user-id: <uuid>
x-gpto-user-role: admin|employee|viewer|client
x-gpto-tenant-id: <uuid>
```

## Deployment

Deploy as a standalone Vercel project. Set environment variables in Vercel project settings.

```bash
vercel --prod
```

The Vercel cron job refreshes cache every 15 minutes automatically.
