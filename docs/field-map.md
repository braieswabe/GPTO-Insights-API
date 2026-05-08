# Dashboard ↔ Gateway Field Map

> **Purpose.** This is the contract between the GPTO Dashboard (`/Users/braiebook/GPTO/apps/dashboard`) and the Insights Gateway (`/Users/braiebook/gpto-insights-gateway`). Every visible scorecard, KPI, badge, narrative, and tooltip on the dashboard is fed by a specific gateway endpoint and field. The dashboard is a **pure fetch + display layer** — *all* scoring, blending, plain-language strings, OpenAI narration, and severity bands are computed by the gateway.
>
> **Version.** `model_version = gpto.dashboard.insights.v2.1` (additive bump: server-built `executiveSummary.focusLanes`; `journey`, `searchDiagnostics`, `experience` added to export-data).
>
> **Updating this doc.** When you add a new card or rename a field, update the corresponding row below. CI tests in `tests/builders.test.js` and `tests/scoring.test.js` cover the contract shape.

---

## 1. Endpoint overview

| Dashboard surface | Endpoint | Cache TTL | Builder/Service |
|---|---|---|---|
| `/dashboard` (Main) | `GET /v1/dashboard/overview` | 1h | `builders/dashboard-overview.js` |
| `/dashboard` (Main) | `GET /v1/dashboard/bundle` | 1h | `services/dashboard.js → buildDashboardBundle` |
| `/dashboard/gold` | `GET /v1/dashboard/gold` | 1h | `builders/gold.js` |
| `/dashboard/llm-mentions` | `GET /v1/llm-mentions/overview` | 1h | `builders/llm-mentions.js` |
| `/dashboard/llm-mentions` (detail) | `GET /v1/llm-mentions/bundle` | 1h | `services/llm-mentions.js` |
| `/dashboard/csuite` | `GET /v1/dashboard/csuite` | 1h | `builders/csuite.js → buildCsuite` |
| `/dashboard/csuite` (insights stream) | `GET /v1/dashboard/csuite/monthly-insights` | 6h | `builders/csuite.js → buildMonthlyInsights` |
| AI Report card | `GET /v1/dashboard/ai-report` (cache) / `POST /v1/dashboard/ai-report` (regen) | 6h | `services/ai-report.js` |
| `/dashboard/reports/[siteId]` | `GET /v1/dashboard/report-bundle` | 1h | `services/dashboard.js → buildReportBundle` |
| `/dashboard/reports/[siteId]` (export) | `GET /v1/dashboard/export-data` | 1h | `services/dashboard.js → buildExportData` |
| Admin stats | `GET /v1/dashboard/stats` | 1h | `builders/stats.js` |
| Sites list | `GET /v1/sites` | 5m | `services/sites.js` |

All endpoints require `Authorization: Bearer <INTERNAL_API_TOKEN>` and forward `x-gpto-user-*` headers for tenant scoping.

---

## 2. Main Dashboard (`/dashboard`)

Source: `GET /v1/dashboard/overview` and `GET /v1/dashboard/bundle`. The bundle includes a top-level `display` object that the UI renders without recomputation.

### 2.1 Pulse cards (top of page)

| Card | UI shows | Gateway path |
|---|---|---|
| AI Visibility | Composite, band, narrative | `executiveSummary.aiVisibility.{ composite, band, narrative }` (mirrors `telemetry.llmMentionsSignals.composite`) |
| AI Visibility breakdown | Reach / Citation / Competitive / Evidence / Internal Readiness | `executiveSummary.aiVisibility.breakdown.{ reach, citation, competitive, answerEvidence, internalReadiness }` (each: `score`, `band`, `weight`, `redistributedWeight`, `severity`) |
| Friction | Score, contributing signals | `executiveSummary.pulseBlends.frictionScore` + `display.confusion.total` |
| Engagement | Score from page experience | `executiveSummary.pulseBlends.averageEngagementScore` |
| Experience Health | Blended friction + engagement | `executiveSummary.pulseBlends.experienceHealth.{ score, band, severity }`, `executiveSummary.pulseBlends.experienceHealthSource` |
| Coverage Risk | Risk band + label | `executiveSummary.pulseBlends.coverageRisk.{ band, label, priorityFixes, missingFunnelStages }` |

### 2.2 Focus Lanes (server-built, was client-composed pre-v2.1)

`executiveSummary.focusLanes: { performingWell, needsAttention, opportunities }`. Each lane is `{ id, label, description, plainMeaning, items: FocusLaneItem[] }`, and each item is `{ id, label, value, severity: 'good'|'watch'|'warn'|'critical', source, href? }`.

| Lane | Sources blended by the gateway |
|---|---|
| `performingWell` | `telemetry.topPages` (top 3, deduped by URL) + `llmMentions.summary.topPages` (top 2, AI-cited) |
| `needsAttention` | `aiVisibility.signals` filtered to `critical`/`warn` (info/ok dropped) + `coverage.priorityItems` (top 2) + `confusion.signals.deadEnds` (top 2) |
| `opportunities` | `confusion.signals.repeatedSearches` (top 3) |

The `performingWell` lane works in both single-site and all-sites scope (the previous client-side composition needed a selected site).

### 2.3 Signal chips (right rail)

`executiveSummary.signalChips: Array<{ id, label, status: 'strong'|'watch'|'warn'|'critical'|'idle'|'unknown', detail }>` — already mapped to the four-state UI palette by the gateway. *Note:* the dashboard's main page no longer renders the chips strip in the Business Brief (it duplicated the PulseCards directly below it). The chips are still emitted for the Reports page and PDF export.

### 2.3 Module index (left nav)

`dashboardIndex: Array<{ moduleKey, label, dataConnected, confidence }>` — `dataConnected` and `confidence` are derived in `builders/index-module.js` from real telemetry counts, not hard-coded.

### 2.4 Shared display layer

`display: { confusion: { total }, executiveSummary: { aiVisibilityScore, frictionScore, experienceScore }, telemetry: { trendPctLabel } }` — every numeric is rounded; every percent is preformatted as a `+N%` / `-N%` string.

---

## 3. Gold Dashboard (`/dashboard/gold`)

Source: `GET /v1/dashboard/gold` (`builders/gold.js`).

| Card | Field |
|---|---|
| Optimisation axis: Technical | `optimisationAxes.technical.{ score, band, plainLanguage }` |
| Optimisation axis: Conversion | `optimisationAxes.conversion.{ score, band, plainLanguage }` |
| Optimisation axis: Content | `optimisationAxes.content.{ score, band, plainLanguage }` |
| Optimisation axis: Growth | `optimisationAxes.growth.{ score, band, plainLanguage }` |
| Visitor Behavior score | `visitorBehavior.{ score, band, signals }` (no longer hard-coded `65`) |
| AI Visibility breakdown | `aiVisibility.breakdown.{ reach, citation, competitive, answerEvidence, internalReadiness }` (same shape as main dashboard) |
| AI Visibility composite | `aiVisibility.composite` (numeric 0–100) |
| AI Visibility weights | `aiVisibility.breakdown.<bucket>.redistributedWeight` (server-side reweighting when buckets are missing) |
| Customer Insights cards | `customerInsights.{ aiSearchVisibility, brandSentiment, voiceShare, retentionRisk }` |

The dashboard component reads `plainLanguage` directly — no client-side `useMemo` is allowed.

---

## 4. LLM Mentions (`/dashboard/llm-mentions`)

Source: `GET /v1/llm-mentions/overview` (`builders/llm-mentions.js`).

| Card | Field |
|---|---|
| Overview composite | `aiVisibility.composite`, `aiVisibility.band`, `aiVisibility.narrative` |
| Reach bucket | `aiVisibility.breakdown.reach.{ score, band, weight, redistributedWeight, severity, drivers }` |
| Citation Coverage | `aiVisibility.breakdown.citation.{ score, band, weight, redistributedWeight, severity, drivers }` |
| Competitive | `aiVisibility.breakdown.competitive.{ score, band, weight, redistributedWeight, severity, drivers }` |
| Answer Evidence | `aiVisibility.breakdown.answerEvidence.{ score, band, weight, redistributedWeight, severity, drivers }` |
| Internal Readiness | `aiVisibility.breakdown.internalReadiness.{ score, band, weight, severity, drivers }` |
| Signals | `aiVisibility.signals: Array<{ id, label, value, severity }>` |
| Coverage / Freshness | `aiVisibility.coverage`, `aiVisibility.freshness` |
| Source context | `aiVisibility.sourceContext.{ promptCount, lastIngestedAt, location, language }` |
| Search examples | `summary.searchExamples[].suggestions: Array<{ id, label, severity }>` (server-built via `lib/answer-evidence.js`) |
| Tracked prompts | `summary.trackedPrompts` |
| Competitor table | `summary.competitors` |
| Source gaps | `summary.sourceGaps` |

---

## 5. C-suite Dashboard (`/dashboard/csuite`)

Source: `GET /v1/dashboard/csuite` (`builders/csuite.js → buildCsuite`).

| Card | Field |
|---|---|
| Authority | `metrics.authorityScore.{ value, target, trend, band }` |
| Sentiment | `metrics.sentimentScore.{ value, target, trend, band }` |
| AI Search Visibility | `metrics.aiSearchVisibility.{ value, target, trend, band }` |
| Competitor Rank | `metrics.competitorRank.{ value, total, trend }` |
| Monthly Growth | `metrics.monthlyGrowth.{ value, label, trend }` |
| Competitor list | `competitors: Array<{ name, score, trend, status }>` |
| Targets | `targets.{ authority, sentiment, aiVisibility }` (configurable via `CSUITE_TARGET_*` env vars) |

`GET /v1/dashboard/csuite/monthly-insights` returns the month-over-month timeline:
```
monthlyInsights: Array<{ month, authority, sentiment, aiVisibility, growth, summary }>
```

---

## 6. AI Report Card

Source: `GET /v1/dashboard/ai-report` (cached, 6h TTL) and `POST /v1/dashboard/ai-report` with `{ force: true }` to regenerate.

`services/ai-report.js` orchestrates:
1. Loads `report-bundle` for the requested `(siteId, range)`.
2. Summarizes via `summarizeBundleForPrompt`.
3. Builds prompt via `buildPrompt`.
4. Calls OpenAI (`OPENAI_API_KEY`, default model `gpt-4o-mini`).
5. Falls back to a deterministic `fallbackReport` when the key is missing or the call fails.
6. Caches via `upsertCacheRow` keyed by `(siteId, range, model_version)`.

Response shape:
```
{
  envelope: { siteId, range, generatedAt, model_version, source: 'openai'|'fallback' },
  data: {
    report: string,        // markdown narrative for direct render
    narrative: string,     // alias of report
    sections: { executiveSummary, aiVisibility, recommendations, risks }
  }
}
```

The dashboard `AIReportCard` POSTs with `{ force: false }` and renders `envelope.data.report` directly. **No OpenAI calls are made from the dashboard.**

---

## 7. Reports / Export (`/dashboard/reports/[siteId]`)

Source: `GET /v1/dashboard/report-bundle` and `GET /v1/dashboard/export-data`.

The export service includes everything the PDF builder needs:

| Section | Field |
|---|---|
| Executive summary | `executiveSummary` (full block — includes `focusLanes`, `signalChips`, `pulseBlends`) |
| AI visibility | `aiVisibility` (composite + breakdown + signals) |
| AI readability | `aiReadability` (Flesch-Kincaid blend + suggestions) |
| Telemetry | `telemetry.{ totalEvents, trendPct, trendPctLabel, perDay, llmMentionsSignals, topPages }` |
| Authority | `authority.{ score, band, severity, blockers, confidenceGaps }` |
| Schema | `schema.{ score, band, severity, templates }` |
| Coverage | `coverage.{ score, band, riskBand, missingFunnelStages, priorityFixes }` |
| Confusion | `confusion.{ score, signals[].recommendedFix }` |
| Experience | `experience.{ healthScore, band, severity, pages }` ← **added in v2.1** |
| Journey | `journey.{ rowCount, loops, strengthBand, rows }` ← **added in v2.1** |
| Search Diagnostics | `searchDiagnostics.{ rows, insufficientData }` ← **added in v2.1** |
| Display layer | `display.{ confusion, telemetry, executiveSummary, journey, searchDiagnostics, experience }` |

---

## 8. Telemetry block

`telemetry` is shared across overview/bundle/report-bundle:

| Field | Description |
|---|---|
| `totalEvents` | Number of events in range |
| `trendPct` | Numeric trend % vs previous period |
| `trendPctLabel` | Preformatted `+N%` / `-N%` string |
| `perDay` | Array of `{ day, count }` |
| `llmMentionsSignals.composite` | LLM composite for the pulse card |
| `llmMentionsSignals.metrics` | Reach / citation / competitive raw inputs |
| `llmMentionsSignals.freshness` | `{ lastIngestedAt, hoursSince }` |

---

## 9. Module index, sites, dashboardIndex

### Sites list (`GET /v1/sites`)

| UI field | Source |
|---|---|
| Connection badge | `dataConnection: 'connected'|'stale'|'disconnected'|'unknown'` |
| Last seen | `lastTelemetryAt` |
| Active config flag | `hasActiveConfig` |

### Dashboard index (`builders/index-module.js`)

`dashboardIndex[].dataConnected` and `dashboardIndex[].confidence` are derived from real signal counts in:
- `authority_signals`
- `confusion_signals`
- `coverage_signals`
- `experience_signals`
- `journey_signals`
- `llm_mentions_snapshots`
- `readability_signals`
- `schema_signals` (via `telemetry_events.metrics`)
- `search_signals`

`confidenceToStatus` (in `lib/scoring.js`) maps `High → strong`, `Medium → watch`, `Low → weak`, `None → idle`.

---

## 10. Shared scoring + display helpers

All implemented in `src/lib/scoring.js` (single source of truth):

| Function | Used for |
|---|---|
| `clampScore`, `average`, `logScore` | Generic score arithmetic |
| `normalizeDomain`, `isSiteDomainMatch` | Domain matching for citation logic |
| `computeReachScore` | Reach bucket |
| `computeCitationStrengthScore`, `computeCitationCoverageScore`, `computeCitationEvidenceScore` | Citation buckets |
| `computeCompetitiveScore` | Share-of-voice → competitive bucket |
| `computeAnswerEvidenceFromExamples` | Answer Evidence bucket |
| `computeInternalReadinessScore` | Internal Readiness bucket |
| `buildWeightedBucket`, `buildInternalBucket`, `compositeFromBreakdown` | Composite blending with redistributed weights |
| `getScoreBand`, `getScoreSeverity` | Strong/Building/Limited/Weak bands + good/watch/warn/critical/unknown severities |
| `confidenceToStatus` | Confidence label → UI status |
| `deriveCoverageRiskBand`, `coverageRiskLabel` | Coverage risk |
| `deriveJourneyStrengthBand`, `deriveExperienceBand` | Journey + experience bands |
| `frictionScoreFromConfusion`, `averageEngagementScore`, `buildExperienceHealth` | Pulse blends |
| `formatTrendPercent`, `trendPercentNumber` | Trend % strings |

Plain-language suggestion generation lives in `src/lib/answer-evidence.js` (`buildEvidenceSuggestions`).

---

## 11. Cache invalidation

When the data contract changes, bump `MODEL_VERSION` in `src/types.js`. All cache rows include `model_version`; mismatches are treated as cache misses and trigger a refresh job. Current value: **`gpto.dashboard.insights.v2`**.

The hourly cron (`/api/internal/cron/refresh`) prewarms:
- `overview` + `stats` (admin / all-sites + per-site)
- `gold` (per-site, customer scope)
- `csuite` + `monthly_insights` (per-site, admin scope)
- `llm_mentions_overview` (per-site, employee scope)

`ai_report` is **not** prewarmed — it's generated on-demand and cached for 6h.

---

## 12. What the dashboard is NOT allowed to do

These responsibilities live exclusively in the gateway:

- ❌ Compute composite scores (use `aiVisibility.composite`)
- ❌ Average sub-bucket scores (use `aiVisibility.breakdown.*`)
- ❌ Build plain-language descriptions (use `optimisationAxes.*.plainLanguage`, `summary.searchExamples[].suggestions`, `aiVisibility.narrative`)
- ❌ Call OpenAI directly (use `/v1/dashboard/ai-report`)
- ❌ Compute trend % strings (use `telemetry.trendPctLabel`)
- ❌ Re-derive friction / engagement / coverage risk (use `executiveSummary.pulseBlends`)
- ❌ Hard-code mock C-suite metrics (use `/v1/dashboard/csuite`)
- ❌ Map confidence → status (use `dashboardIndex[].confidence` + UI palette)
- ❌ Compose Focus Lanes from telemetry + LLM + coverage + confusion (use `executiveSummary.focusLanes`) ← **added in v2.1**

If a UI component needs a value that isn't yet provided, the fix is to add it to the gateway builder, not to recompute on the client.

## 13. Operational notes (v2.1)

- **Top Pages bug fix.** Pre-v2.1, the daily rollup writer in [`src/services/telemetry-daily-rollup.js`](../src/services/telemetry-daily-rollup.js) wrote `top_pages` and `top_intents` as raw JS arrays, which postgres-js silently coerced to `NULL` in the JSONB column. The fix wraps both in `tx.json(...)` (matching `cache.js`, `jobs.js`, `llm-admin.js`). After deploy, run a force backfill via `POST /internal/rollup/telemetry-daily { from, to, force: true }` for any date range that needs to be repopulated.
- **Today's UTC rollup re-runs.** Past UTC days are immutable once `complete`; today's UTC day always re-runs (events keep arriving). This avoids stale `top_pages` for the in-progress day.
- **Friendly empty states.** The `NoDataState` component in `apps/dashboard/src/app/dashboard/page.tsx` accepts an optional `dataConnection` prop and renders distinct messaging for `connected` (awaiting first events), `pending`/`disconnected` (verify tracker), and `stale` (recent events missing) — backed by `sitesList[].dataConnection`.
- **Removed redundancy.** The Main Dashboard's "Individual Dashboards" section dropped 4 tiles (`telemetry`, `authority`, `coverage`, `llm_ai_visibility`) that duplicated the PulseCards / dedicated detail cards above. The Business Brief signal-chips strip was also removed (same content as the PulseCards directly below). Remaining tiles: `confusion`, `schema` (each unique).
