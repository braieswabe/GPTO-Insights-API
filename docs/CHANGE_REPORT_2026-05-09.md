# What we shipped today — Saturday, May 9, 2026

> **In one paragraph:** Three of the dashboard's cards (Top Pages, Focus Lanes, and On-site Search Behavior) had been showing "no data" — even when there was real activity to display. We tracked it down to a small but consequential bug in the data engine that was silently throwing away every page-list it produced. Fixed it, refilled the missing data, and as a follow-up we cleaned up redundant tiles on the dashboard so the same number doesn't get shown three times in a row. The page is calmer, faster to scan, and finally accurate. No customer-visible setting changed; nobody got logged out.

---

## The two parts of the system, again

| What it is | What it does | Where it lives |
|---|---|---|
| **GPTO Dashboard** *(the website)* | The screens, charts, badges, and PDFs you see. | `/Users/braiebook/GPTO` |
| **GPTO Insights Gateway** *(the data engine)* | A behind-the-scenes service that crunches raw telemetry into the numbers the dashboard reads. | `/Users/braiebook/gpto-insights-gateway` |

Today's work touched both — but the *cause* of the broken cards was entirely in the data engine.

---

## 1. The bug we found and fixed

### What the customer was seeing

Three cards on the Main Dashboard kept showing "no data yet":

- **Top Pages** — the bar chart of most-visited pages
- **Focus Lanes** — the three-column "what's working / what needs fixing / what isn't effective" panel
- **On-site Search Behavior** — what visitors searched for on the site

This was odd because other parts of the dashboard *did* show numbers. So the data was clearly flowing in — something was just blocking it from reaching these specific cards.

### What the diagnostic showed

We ran a quick read-only count against the database. In the last 7 days:

| What we counted | Rows |
|---|---|
| Telemetry events received | **13,316** |
| Daily summary rows produced | **28** |
| Visitor journey records | **401** |
| On-site search records | **0** |

So the system was happily receiving events and producing summaries — but somehow the "top pages" lists inside those summaries were always *empty*. Every single one. Even when 639 page views were recorded for a single site on a single day, the list of which pages those views went to was blank.

### What was actually going wrong

The data engine has a nightly job that turns raw events into a daily summary. That job tries to write a small JSON list of "top pages" alongside the page-view count.

Buried in that job was one line that handed a **plain JavaScript array** straight to a Postgres column that expects **JSON**. Postgres saw a thing it didn't understand, refused to store it, and silently set the column to `NULL`. No error was logged. No alarm went off. Every other place in the codebase that wrote JSON to Postgres did it the right way — only this one didn't.

The fix was a tiny one-line change. Wrap the array in `tx.json(...)`, the same way every other place in the engine does. After deploying the fix, we backfilled the last 7 days of summaries; the missing top-pages lists immediately re-appeared:

| Site | Page views | "Top pages" entries (was 0) |
|---|---|---|
| careerdriverhq.com | 2,599 | **19** |
| xtremetransportation.com | 1,235 | **25** |
| careerdriver.com | 220 | **1** |

### A bonus bug we fixed at the same time

While in there, we noticed a second, smaller issue: **today's daily summary used to get stuck**. Once it ran for the first time on a given day, it refused to re-run — even though new events kept arriving for that same day. So the dashboard would show "what we knew at 1pm" for the rest of the day. Past days are immutable and shouldn't re-run, but *today* should always re-run as long as it's still today. We added a one-line check for that.

### What about On-site Search?

That table really is empty. Visitors haven't done any on-site searches yet (or the tracker for it isn't wired up on these sites). So instead of showing a confusing "no data yet" with no explanation, the card now says:

> *"Awaiting first events — Site is connected. This section will populate within an hour of the next events."*

If a site isn't connected at all, it'll say so — in amber — and recommend verifying the tracking script.

---

## 2. The cleanup work that came with it

While digging into the dashboard to fix the empty-card issue, it became clear that the Main Dashboard was showing the **same numbers in three different places**. We took the opportunity to remove the duplicates.

### What was duplicated

The Main Dashboard had a strip of "Pulse cards" near the top (AI Visibility, Trust Lift, Coverage Risk, Experience Health) — those are the headline cards. Then, further down, there was a section called "Individual Dashboards" that re-showed the same scores in tile form. And next to those tiles was a strip of "signal chips" that *also* re-showed the same scores.

Same number. Three times. Stacked on top of each other.

### What we removed

- The duplicate **AI Visibility** tile under Individual Dashboards (the Pulse card and a dedicated AI Visibility section already cover it)
- The duplicate **Coverage** tile (the Coverage Risk Pulse card already covers it)
- The duplicate **Authority** tile (the Trust Lift Pulse card already covers it)
- The duplicate **Telemetry** tile (its mini top-pages list was a worse version of the Top Pages card right above it)
- The **Business Brief signal-chips strip** (same content as the Pulse cards directly underneath)

### What we kept

- All the Pulse cards (the canonical "headline" view of each signal)
- The dedicated **Top Pages**, **Focus Lanes**, **On-site Search**, and **Page Experience** cards (each shows unique detail)
- The dedicated **AI Answer Visibility** section (which has live snapshot evidence the Pulse card can't fit)
- Individual Dashboard tiles for **Confusion** and **Schema** (each carries unique evidence not surfaced anywhere else)

The result: every number on the page now has exactly one canonical place. No more "wait, the other tile said something different." The page is shorter, less noisy, and easier to read. No information was lost.

---

## 3. A bigger architectural cleanup, while we were there

There was one card the dashboard had been quietly building *itself* in the browser, even after the big parity audit a few weeks back: **Focus Lanes** (the three-column panel). It was assembling its rows from five different parts of the response, on the user's machine, every time the page loaded.

Two things were wrong with that:

1. It violated the rule we set in the parity audit: *the dashboard fetches and displays, the engine computes*.
2. It had two latent bugs:
   - The "Performing Well" lane only worked when a single site was selected — on "All sites" it was always empty.
   - The "Needs Attention" lane silently dropped certain AI signals that should have been included.

We moved the whole composition into the data engine. The dashboard now just reads three pre-built lanes and renders them. The all-sites bug is gone, the silent-filter bug is gone, and there's a single place to update the rules if we ever want to change them.

---

## 4. The PDF / Reports page got better too

We noticed that the Reports page and the exported PDF were missing three sections — **Journey**, **On-site Search**, and **Page Experience** — even when those sections had real data on the live dashboard. That was because the data engine's "build the export bundle" function was forgetting to include them.

Fixed. They're now in the bundle, in both the top-level data and the formatted "ready-to-render" display layer the PDF builder uses.

---

## 5. How the cache stays honest

Whenever we change the *shape* of what the data engine returns, we have to invalidate any old cached responses — otherwise the dashboard might serve stale data with the old shape. We bumped the model version from `v2` to `v2.1` so every cache row from before today is treated as expired and refreshed on next access.

We also tightened the cache-policy code so it actively checks for the new fields. If a cached row is missing the new server-built Focus Lanes, or the new Journey/On-site Search fields in the export bundle, it's treated as stale and recomputed.

---

## 6. Tests and docs

- **9 new automated tests** for the new Focus Lanes builder — covering empty payloads, the all-sites path, the AI-cited augmentation, the "drop info/ok signals" rule, and the various sub-source blends. All pass.
- **2 new cache-contract tests** that lock in "old cache rows missing the new fields must be recomputed."
- **Total test count: 113. Passing: 113. Failing: 0.**
- The Dashboard ↔ Gateway field map document was updated to reflect the v2.1 contract — so anyone wondering "where does this number come from?" has an up-to-date answer.

---

## What changed visually

If you scroll the Main Dashboard right after this deploys, you should notice:

- **Top Pages** is no longer empty. It shows the most-visited pages with bar charts.
- **Focus Lanes** now has rows in all three columns (or, on a brand-new site, a friendly amber "Site not yet connected" note instead of a confusing blank).
- **On-site Search Behavior** says exactly why it's empty (waiting for first search events) instead of looking broken.
- The "Individual Dashboards" section is shorter — only Confusion and Schema tiles remain there. Everything else moved to (or was already in) its own dedicated card.
- The Business Brief no longer has a strip of pill-shaped chips at the top right; the Pulse cards underneath already conveyed the same information.

If you don't notice any of those, the cache hasn't expired yet — give it an hour or trigger a refresh.

---

## What to watch next

A short watchlist as the data continues to flow in:

- [ ] **Tomorrow's daily summary** should keep its top-pages list populated. (If it goes empty again, that means the fix didn't deploy or there's a second bug we missed.)
- [ ] **Today's UTC summary should stay fresh** — i.e. as more events come in over the course of the day, the Top Pages numbers should keep climbing instead of freezing at the first run's snapshot.
- [ ] **On-site Search Behavior** should fill in the moment any site fires a search event. Until then the friendly "awaiting" message stays.
- [ ] **The PDF report** should now have Journey, On-site Search, and Page Experience sections present (even if those sections show "no data yet" for now).
- [ ] **Focus Lanes** should remain populated regardless of whether you're viewing one site or all sites — the all-sites bug is the highest-confidence fix to validate.

---

## What did NOT change

This was a fix-and-cleanup pass — no new customer-facing features:

- No screens were redesigned.
- No metric formulas were changed.
- No data was deleted (the rollup backfill only *added* the missing top-pages lists; it didn't touch counts).
- No users were logged out, no sites were modified, no settings were reset.
- The PDF's tone, structure, and styling are unchanged.

If anyone notices anything *visually* different beyond "the empty cards finally have data" and "the page feels less repetitive," that's a bug we want to hear about.

---

*Generated 2026-05-09. Captures the empty-cards diagnosis, the rollup writer fix, the server-side Focus Lanes migration, the export-data completeness fixes, the v2.1 cache invalidation, and the conservative redundancy cleanup on the Main Dashboard.*
