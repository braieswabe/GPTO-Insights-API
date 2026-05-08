# Gateway ↔ Dashboard parity audit — what we did

> **In one paragraph:** The GPTO Dashboard (the website) and the Insights Gateway (the data engine behind it) had drifted apart — the dashboard was quietly doing a lot of math, calling OpenAI, and faking C-suite numbers on its own. We audited every scorecard, moved every calculation, every plain-English explanation, and every AI narration into the gateway, and turned the dashboard into a clean "ask, receive, display" layer. We also built two new gateway features the dashboard now needs (real C-suite metrics and a server-side AI report). Result: one source of truth, faster pages, and no more "the dashboard says one thing, the gateway says another".

---

## The two parts of the system

| What it is | What it does | Where it lives |
|---|---|---|
| **GPTO Dashboard** *(the website)* | The screens, charts, badges, and PDFs the user sees. | `/Users/braiebook/GPTO` |
| **Insights Gateway** *(the data engine)* | A behind-the-scenes service that crunches raw signals into the numbers the dashboard reads. | `/Users/braiebook/gpto-insights-gateway` |

The whole point of this project: **the dashboard should never compute a score itself.** It should ask the gateway, get back ready-to-render values, and just display them.

---

## Why this needed doing

When we started, the dashboard was doing a surprising amount of work in the user's browser:

- **Recomputing scores** — averaging sub-scores, blending friction with engagement, weighting LLM citation evidence — even though the gateway already had most of those numbers.
- **Writing plain-English text** — sentences like "Your technical score is solid; focus on conversion next" were being assembled live in the browser from raw numbers.
- **Calling OpenAI directly** — the "AI Report" card was sending the user's data straight to OpenAI from the browser, paying for it, and rendering whatever came back.
- **Faking the C-suite page** — the entire `/dashboard/csuite` page was hard-coded mock numbers; nothing on it was real.
- **Making up status badges** — connection states, confidence levels, and severity colors were hand-rolled in the UI based on whatever the dashboard *thought* the data meant.

The risk: any time we updated a formula in one place, the other place would silently disagree. This is exactly the class of bug nobody notices until a customer points it out.

---

## What we actually did, in plain English

### 1. We audited every single scorecard

We went through the dashboard page by page — Main, Gold, LLM Mentions, C-suite, Reports/Export — and listed every score, badge, percentage, and narrative on screen. For each one, we traced where the number came from and noted whether the dashboard was doing math the gateway should be doing.

Output: a 231-line written plan with a phased to-do list. (We followed it end-to-end without modifying it.)

### 2. We fixed the obvious bugs first

A handful of small but real bugs surfaced during the audit:

- A site-ID variable was being referenced without being defined in one of the gateway builders.
- The "coverage" data block was returning empty (`null`) when there was no data, which made the UI look broken instead of just showing "no signals yet".
- A few imports were missing; a few hard-coded fallback numbers (like a 65 visitor-behavior score that everyone always saw) were quietly lying.

All fixed. The gateway now returns a clean "empty but valid" shape instead of nothing.

### 3. We replaced placeholder values with real calculations

The gateway had a few "we'll come back to this" stubs that had never been completed:

- A composite score that always returned `0`.
- A "data connected" flag that was always `true`.
- A "confidence" level that was always `"Medium"` regardless of how much data there was.
- A list of recommended fixes for confusion signals that always returned the same generic sentence.
- A hard-coded location and language pinned to one country.
- A "prompt refresh" admin function that pretended to work but actually did nothing.

Every one of those is now computed from real data.

### 4. We moved the dashboard's brains into the gateway

This was the largest piece of work. We created two new shared modules in the gateway:

- **`scoring.js`** — a single library with every scoring helper: clamping numbers between 0 and 100, averaging, log-scaling, the LLM bucket weights (Reach, Citation, Competitive, Answer Evidence, Internal Readiness), the formulas that blend them into a composite, the rules that turn a number into a band ("Strong / Building / Limited / Weak") and a severity color ("good / watch / warn / critical"), the friction-and-engagement blend that drives the Experience Health pulse card, and the formatter that turns trends into "+12%" / "-4%" strings.
- **`answer-evidence.js`** — the logic that builds the plain-English suggestions you see next to AI search examples ("Add your brand to this answer", "Improve citation strength", etc.).

Then we deleted the duplicate copies of all of that code from the dashboard. The dashboard now imports nothing from these files — it just reads the values the gateway sends.

### 5. We built a real C-suite dashboard

The `/dashboard/csuite` page used to be a polished-looking mockup powered by hard-coded numbers. We built two new gateway endpoints that compute the real metrics:

- **`GET /v1/dashboard/csuite`** — Authority Score, Sentiment Score, AI Search Visibility, Competitor Rank, and Monthly Growth. Each comes with its target value, current band, and trend.
- **`GET /v1/dashboard/csuite/monthly-insights`** — the month-by-month timeline shown beneath the headline cards.

The dashboard component was rewritten to fetch from these endpoints and render whatever they return. The targets (90% authority, 80% sentiment, etc.) are configurable via environment variables, so different deployments can set their own.

### 6. We moved the AI Report into the gateway

The "AI-Powered Executive Report" card used to call OpenAI directly from the browser-side route. That meant:

- The OpenAI key was effectively in the dashboard app.
- Every report generation was a fresh, uncached call (slow + expensive).
- If OpenAI was down or the key was missing, the dashboard just broke.

We built a new gateway service that:

1. Pulls together the same data the dashboard's Report page uses.
2. Summarizes it into a structured prompt.
3. Calls OpenAI on the **server**.
4. Caches the resulting narrative for 6 hours, keyed by site + date range + model version.
5. Falls back to a cleanly written deterministic narrative if OpenAI is unavailable, so the card *never* shows a broken state.

The dashboard's AI Report card now just POSTs to the new endpoint and renders what comes back. The OpenAI key is a gateway secret only.

### 7. We added a "display layer" to every payload

The biggest win for the UI: the gateway now ships a small `display` object alongside the raw data on every dashboard payload. It contains pre-formatted, ready-to-render values — the rounded composite, the trend already turned into "+12%", the total confusion count already summed, the right severity color for the band, and the right wording for the badge.

Before, the dashboard had ~15 places where it took a number and decided how to format it. Now there are zero. The gateway decides; the dashboard prints.

### 8. We rewrote the dashboard pages to consume the new shapes

We then went back through every dashboard page that had been doing math and stripped it out:

- **Main dashboard** — removed the client-side LLM evidence calculator, the score-clamping helpers, the friction-and-engagement blender. Now reads `executiveSummary.aiVisibility`, `executiveSummary.pulseBlends`, and `executiveSummary.signalChips` straight from the gateway.
- **Gold dashboard** — removed the four big `useMemo` blocks that built plain-English explanations for the Technical / Conversion / Content / Growth axes. Now reads `optimisationAxes.*.plainLanguage` from the gateway.
- **LLM Mentions detail** — removed ~10 helper functions (domain matching, citation scoring, evidence blending, internal-readiness math). Now reads `aiVisibility.breakdown.*` and `summary.searchExamples[].suggestions` straight from the gateway.
- **AI Report card** — removed the OpenAI call. Now POSTs to `/api/dashboard/ai-report`, which proxies to the new gateway service.
- **C-suite page** — removed the mock data; added real fetching, a site selector, and proper loading states.
- **Reports page** — removed the trend-percentage formatter and the confusion-signal totaller. Now reads `display.confusion.total` and `telemetry.trendPctLabel` from the gateway.

### 9. We bumped the model version (so caches reset cleanly)

Because the data shape changed, we bumped the gateway's internal `model_version` to `gpto.dashboard.insights.v2`. Old cache entries are now treated as stale and refreshed automatically — nobody sees an old, mismatched payload.

### 10. We wrote tests and docs

- **34 new automated tests** covering the new scoring library, the new C-suite and AI Report modules, and the cache-prewarm targets. All 82 tests pass.
- **README** updated with the new endpoints and the new environment variables (OpenAI key + model + temperature, C-suite targets).
- **`docs/field-map.md`** — a brand-new contract document that lists every card on every dashboard page and the exact gateway field that powers it. If a developer ever wonders "where does this number come from?", this is the answer.

---

## What this means in practice

For the people using the dashboard:

- **Pages load faster.** Less browser-side math, fewer recalculations, more pre-formatted strings ready to paint.
- **Scores match everywhere.** The composite on the main dashboard, the breakdown on the LLM page, and the number in the PDF can no longer disagree — they all come from the same calculation.
- **The C-suite page is real.** What you see is actual data for the selected site, not a placeholder.
- **The AI Report is robust.** It caches, it falls back gracefully, and the OpenAI key is no longer exposed via the dashboard.

For the team:

- **One place to change a formula.** Update the gateway, every surface updates with it.
- **No drift between dashboard and PDF export.** They both read the same payload now.
- **Easy onboarding.** The new field-map doc tells anyone — engineer, designer, support — exactly where each visible number comes from.

---

## What's NOT changed

This was an internal refactor — the user-facing experience is intentionally identical:

- Every page still looks the same.
- Every score still means the same thing.
- No data was deleted; no settings changed; no logins reset.
- The OpenAI report's tone, length, and structure are the same.

If anyone notices a *visible* change other than "things feel a little snappier", that's a bug we want to hear about.

---

## Files that changed (one-liner each)

| Side | File | What it now does |
|---|---|---|
| Gateway | `src/lib/scoring.js` *(new)* | Single home for every scoring + display formula |
| Gateway | `src/lib/answer-evidence.js` *(new)* | Plain-English suggestions for AI search examples |
| Gateway | `src/builders/csuite.js` *(new)* | Real C-suite metrics + monthly insights |
| Gateway | `src/services/ai-report.js` *(new)* | Server-side OpenAI report with caching + fallback |
| Gateway | `src/builders/gold.js` | Server-side plain-English explanations + visitor-behavior fix |
| Gateway | `src/builders/llm-mentions.js` | Full composite + breakdown + suggestions |
| Gateway | `src/builders/executive-summary.js` | Pulse blends + signal chips + AI visibility block |
| Gateway | `src/builders/dashboard-overview.js` | New `display` layer for ready-to-render values |
| Gateway | `src/builders/{authority,confusion,coverage,experience,index-module,journey,schema,telemetry}.js` | Bands, severities, real connection/confidence values, no more stubs |
| Gateway | `src/services/dashboard.js` | Wires the new C-suite + AI report into caching, prewarm, and exports |
| Gateway | `src/types.js` | Bumped `model_version` to `v2` |
| Gateway | `src/routes.js` | New `/v1/dashboard/csuite`, `/v1/dashboard/csuite/monthly-insights`, `/v1/dashboard/ai-report` routes |
| Dashboard | `app/dashboard/page.tsx` | Removed score helpers; reads pulse blends + signal chips from gateway |
| Dashboard | `components/GoldDashboard.tsx` | Removed plain-language `useMemo`s; reads from gateway |
| Dashboard | `components/LlmMentionsDetailView.tsx` | Removed ~10 client-side helpers; reads breakdown from gateway |
| Dashboard | `components/CsuiteDashboard.tsx` | Removed mock data; fetches real C-suite payload |
| Dashboard | `components/MonthlyInsights.tsx` | Reads real monthly timeline from gateway |
| Dashboard | `components/AIReportCard.tsx` | Removed OpenAI call; POSTs to gateway |
| Dashboard | `app/dashboard/csuite/page.tsx` | Real site selector + fetch wiring |
| Dashboard | `app/api/dashboard/{csuite,csuite/monthly-insights,ai-report}/route.ts` | Thin proxies to the gateway |
| Dashboard | `app/dashboard/reports/[siteId]/page.tsx` | Reads pre-formatted trend strings + confusion totals from gateway |
| Gateway | `tests/scoring.test.js` *(new)* | 30 unit tests for the scoring library |
| Gateway | `tests/ai-report-service.test.js` *(new)* | Contract tests for the new C-suite + AI report modules |
| Gateway | `tests/builders.test.js`, `tests/dashboard-service.test.js` | Updated to cover the new modules and the model-version bump |
| Gateway | `README.md`, `docs/field-map.md` *(new)* | New env vars, new endpoints, full Dashboard ↔ Gateway field map |

---

*Generated 2026-05-08. Captures the Gateway ↔ Dashboard parity audit and the work that turned the GPTO Dashboard into a pure fetch-and-display layer over the Insights Gateway.*
