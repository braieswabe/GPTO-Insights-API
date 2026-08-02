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
| `GPTO_DASHBOARD_BASE_URL` | Recommended (prod) | HTTPS origin of the GPTO Next dashboard (no trailing slash). Hourly cron calls `POST /api/internal/signals/materialize` here before prewarm. |
| `GPTO_SIGNAL_MATERIALIZE_TOKEN` | Recommended (prod) | Bearer secret shared with GPTO `GPTO_SIGNAL_MATERIALIZE_TOKEN` for that route. If unset, cron skips materialization (cache-only). |
| `GPTO_MATERIALIZE_RANGES` | No | Comma-separated `7d` and/or `30d` sent to GPTO (default `7d`). |
| `GPTO_SIGNAL_MATERIALIZE_TIMEOUT_MS` | No | Fetch timeout for materialize (default `110000`). |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins |
| `PORT` | No | Local dev port (default: 4011) |
| `DASHBOARD_REFRESH_COOLDOWN_SECONDS` | No | Min seconds between refresh attempts (default: 300) |
| `DASHBOARD_PREWARM_LIMIT` | No | Max dashboard cache targets to prewarm per cron run (default: 20) |
| `DATAFORSEO_AUTH_HEADER` | No | Basic auth header for DataForSEO live LLM Mentions calls |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | No | Alternative DataForSEO credentials |
| `DATAFORSEO_AUTOMATION_ENABLED` | No | Set to `1` after the automation migration and one-site smoke test; scheduled batches cover ChatGPT and Google AI Overviews |
| `GPTO_DATAFORSEO_AUTOMATION_TOKEN` | For automation | Dedicated bearer shared with the GPTO dashboard executor |
| `TELEMETRY_ROLLUP_WITH_DASHBOARD_CRON` | No | When `1`, `/internal/cron/refresh` also runs a bounded UTC telemetry rollup before prewarm |
| `TELEMETRY_ROLLUP_CRON_DAYS_BACK` | No | UTC days to cover in rollup cron (default `2`) |
| `TELEMETRY_ROLLUP_CRON_MAX_SITES` | No | Max active sites per rollup cron run (default `40`) |
| `TELEMETRY_ROLLUP_CRON_MAX_RUNS` | No | Max site×day jobs per rollup cron (default `120`) |
| `TELEMETRY_ROLLUP_MAX_SPAN_DAYS` | No | Max UTC days per `POST /internal/rollup/telemetry-daily` (default `366`) |
| `TELEMETRY_ROLLUP_MAX_SITES` | No | Max sites per manual rollup POST (default `80`) |
| `TELEMETRY_ROLLUP_MAX_RUNS` | No | Max site×day jobs per manual rollup POST (default `500`) |
| `DASHBOARD_TELEMETRY_CONNECTED_MS` | No | Milliseconds of telemetry freshness required for `sitesList[].dataConnection === connected` (default 1h) |
| `DASHBOARD_TELEMETRY_STALE_MS` | No | Milliseconds after last event before `disconnected` (default 24h; must be ≥ connected window) |

## API Endpoints

### Dashboard Read (cache-first)

- `GET /v1/dashboard/overview` – full aggregated dashboard
- `GET /v1/dashboard/bundle` – page-ready dashboard bundle for GPTO Suite
- `GET /v1/dashboard/report-bundle` – report/export/AI-report source bundle
- `GET /v1/dashboard/module/:moduleKey` – single module data
- `GET /v1/dashboard/gold` – client-facing Gold dashboard payload
- `GET /v1/dashboard/stats` – dashboard stats payload
- `GET /v1/dashboard/export-data` – consolidated export/report source data
- `GET /v1/admin/automation-runs` – admin-only Refresh Data, DataForSEO, and AI Scanner run history (`days`, `limit`)
- `GET /v1/llm-mentions/overview` – LLM mentions aggregation
- `GET /v1/llm-mentions/bundle` – page-ready LLM Mentions bundle
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
- `POST /internal/refresh/prewarm` – precompute common dashboard cache payloads
- `POST /internal/refresh/process` – claim and process queued jobs
- `POST /internal/rollup/telemetry-daily` – materialize `dashboard_rollups_daily` from `telemetry_events` (UTC `from` / `to` as `YYYY-MM-DD`; optional `siteId`, `siteCursor`, `force`, `maxSites`, `maxRuns`; returns `nextSiteCursor`)
- `GET /internal/rollup/telemetry-daily/progress` – per-day rollup status for a site (`siteId`, `from`, `end` or `to` query params, UTC dates)

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

The Vercel cron job runs **hourly** (`0 * * * *` UTC → `/api/internal/cron/refresh`). When `GPTO_DASHBOARD_BASE_URL` and `GPTO_SIGNAL_MATERIALIZE_TOKEN` are set, it first materializes `*_signals` in Postgres via the GPTO Suite, then prewarms cache and processes queued refresh jobs. If those env vars are missing, the cron still refreshes cache but **does not** populate signal tables. Overview and stats cache TTLs are **one hour** to match. A second cron (`/api/internal/cron/rollup-telemetry`, default `5 2 * * *` UTC) materializes **daily telemetry rollups** from `telemetry_events` into `dashboard_rollups_daily` and records progress in `dashboard_telemetry_daily_rollup_progress` so custom dashboard date ranges have underlying facts. On materialize failure the hourly handler returns **502** and skips prewarm (fail-fast).

Dashboard `sitesList` entries include `lastTelemetryAt`, `hasActiveConfig`, and `dataConnection`, keyed to the same `sites.id` as `telemetry_events.site_id`. Migration `0003_sites_last_telemetry_at.sql` adds `sites.last_telemetry_at`, backfills from events, and rollups keep it updated alongside rollup progress.

Daily boundaries are **UTC calendar days** (`day` stored as `00:00:00Z` for that date).

Set the GPTO Suite environment to point at this service:

```
INSIGHTS_API_BASE_URL=https://<this-gateway>
INTERNAL_API_TOKEN=<same-token-as-gateway>
```

The Suite should keep public `/api/dashboard/*` and `/api/integrations/dataforseo/llm-mentions/*` paths stable, but those handlers should only proxy to this gateway and forward user context headers.
