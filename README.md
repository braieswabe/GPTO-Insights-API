# GPTO Insights API Gateway

Dashboard and LLM Mentions processing engine for the GPTO platform. The GPTO Suite calls this service for dashboard read models, LLM Mentions processing, DataForSEO console operations, cache refresh, and report/export source payloads.

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
| `DATAFORSEO_AUTH_HEADER` | No | Basic auth header for DataForSEO live LLM Mentions calls |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | No | Alternative DataForSEO credentials |

## API Endpoints

### Dashboard Read (cache-first)

- `GET /v1/dashboard/overview` – full aggregated dashboard
- `GET /v1/dashboard/module/:moduleKey` – single module data
- `GET /v1/dashboard/gold` – client-facing Gold dashboard payload
- `GET /v1/dashboard/stats` – dashboard stats payload
- `GET /v1/dashboard/export-data` – consolidated export/report source data
- `GET /v1/llm-mentions/overview` – LLM mentions aggregation
- `GET /v1/llm-mentions` – legacy GPTO-compatible LLM summary payload
- `GET /v1/llm-mentions/trends` – LLM mentions trend data
- `GET /v1/llm-mentions/competitors` – competitor comparison
- `GET /v1/llm-mentions/prompt-intelligence` – prompt analysis
- `GET /v1/llm-mentions/source-gap` – source gap analysis
- `GET/POST /v1/llm-mentions/raw` – DataForSEO console passthrough/history
- `GET /v1/llm-mentions/locations` – location metadata
- `GET/POST /v1/llm-mentions/tracked-prompts` – tracked prompt list/create
- `PATCH/DELETE /v1/llm-mentions/tracked-prompts/:id` – tracked prompt update/delete
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

## GPTO Suite Integration

Set the GPTO Suite environment to point at this service:

```
INSIGHTS_API_BASE_URL=https://<this-gateway>
INTERNAL_API_TOKEN=<same-token-as-gateway>
```

The Suite should keep public `/api/dashboard/*` and `/api/integrations/dataforseo/llm-mentions/*` paths stable, but those handlers should only proxy to this gateway and forward user context headers.
