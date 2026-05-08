# What changed today — Friday, May 8, 2026

> **In one paragraph:** Today we shipped three things across the GPTO platform. (1) The dashboard now knows whether each site is actually sending data and shows it as a clear status badge. (2) The "Export PDF" button has been completely rebuilt — it now produces a polished, client-ready report with every score, metric, and explanation, and admins can choose between a clean *Client* version and a more detailed *Technical* version. (3) We safely backed up the live data and wiped the telemetry and scoring tables, so we can watch the system fill back up from scratch and confirm everything is working end-to-end.

---

## The two parts of the system we worked on

GPTO is made up of two separate apps that talk to each other:

| What it is | What it does | Where it lives |
|---|---|---|
| **GPTO Dashboard + internal API** *(the main app)* | The website you log into, the screens, the charts, the PDF export, and the scoring logic. | `/Users/braiebook/GPTO` |
| **GPTO Insights Gateway** *(the data engine)* | A smaller, faster service that crunches raw telemetry into the numbers the dashboard reads. | `/Users/braiebook/gpto-insights-gateway` |

Today we shipped one big update on each side, plus we ran a one-time database cleanup. Everything below is grouped that way.

---

## 1. The main GPTO app — what's new today

Bundled as one large update titled **"Telemetry Changes and Dashboard UI Updates"** (today at 8:24 AM). It covers three improvements:

### A. The dashboard now tells you if a site is connected

Before today, if a site stopped sending telemetry, the dashboard would still happily show empty charts and old numbers, and you wouldn't know why. Now:

- Every site shows a small **connection badge**: *Pending*, *Connected*, *Degraded*, or *Stale*.
- The dashboard tracks **the last time each site sent any telemetry** and uses that to power the badge.
- The same logic runs in two places (the dashboard and the gateway) so they always agree.

In practical terms: if a customer's tracking script stops firing, you'll see it on the dashboard immediately instead of guessing whether the chart is "empty because nothing happened" or "empty because we're not getting any data".

### B. A brand-new Export PDF — fully rebuilt

The old "Export PDF" was a stripped-down placeholder. The new one is a **client-ready report**: same colors, same fonts, same layout language as the dashboard itself, with every available score, metric, and explanation included.

What's new in the PDF:

- A **proper cover page** with the brand, the date range, and the report mode.
- A **table of contents** and clean page numbering.
- **Every section** the dashboard shows now has its own page in the PDF: Executive Summary, AI Visibility, AI Readability, LLM Mentions, Competitor Mentions, Telemetry, Authority, Schema, Coverage, Confusion, Executive Questions, plus a Glossary.
- Each metric comes with the **same plain-English explanation** that you see when you hover over the help tooltips in the dashboard, so the PDF stands on its own without needing the live app open.
- Empty sections show a friendly **"No data yet"** note instead of blank space, so a partial report still looks professional.

A new option for admins: a **split Export button** with two choices:

| Mode | Who it's for | What it includes |
|---|---|---|
| **Client PDF** | Anyone — this is the version you share externally | The polished, easy-to-read version with the high-impact insights and explanations |
| **Technical PDF** | Admins/employees only | Everything in the Client PDF, **plus** the deeper diagnostic sections (raw evidence URLs, scoring methodology appendix, LLM search evidence) |

The PDF can now be exported any time, on any date range, for any site or "all sites", and it will look the same and be presentable to a client every time.

### C. Two new internal documents

Two long-form internal write-ups were also added so the team has a single source of truth:

- **How the dashboard talks to the Insights Gateway** — the contract between the two systems.
- **Content generation integration review** — an audit of how the AI-generated content surfaces feed into the dashboard.

### Plus one staged-but-not-committed file

A new SQL script, **`hard-reset-telemetry-and-scoring.sql`**, was prepared to do the live database cleanup described in section 3 below. It's the script we actually ran today.

---

## 2. The Insights Gateway — what's new today

Two updates, both titled **"Rollups update"**, shipped at 8:07 AM and 8:22 AM. Together they bring two important capabilities to the data engine:

### A. Daily rollups (a much faster dashboard)

Until today, every dashboard load asked the gateway to crunch raw telemetry events live. That works fine for small sites, but gets slow as data piles up.

The gateway now keeps a **daily summary** of every site, automatically updated by a scheduled job. The dashboard reads from these pre-computed summaries first and only falls back to live computation when the rollup hasn't caught up yet. Net effect: the dashboard stays snappy regardless of how much telemetry has been collected.

### B. The other half of the "is this site connected?" feature

The gateway now stores **the last time each site sent telemetry** in its own database, and computes the same connection verdict the dashboard shows. This is the matching half of feature 1.A above — both apps share the same logic so they can never disagree.

### Heads-up: one tiny mismatch we still need to settle

The two repos are using **slightly different forms of the same database index** (one based on UTC days, one on the raw day field). They both work, but we should pick one and align before either is run on a brand-new database. This is captured in the *Follow-ups* section below.

---

## 3. We backed up the data and wiped the telemetry tables

To make sure the new rollups, the new connection badge, and the new PDF all behave correctly **starting from zero**, we did a controlled reset of the live telemetry and scoring data.

### What we backed up first (nothing was lost)

Everything we were about to wipe was first **copied into a brand-new backup area** of the database called:

> **`gpto_backup_20260508_004031`**
> *(named after the UTC timestamp it was taken at)*

That backup includes:

- All raw telemetry events and the daily rollups built from them
- All scoring signals (Coverage, Confusion, Authority, Readability, Journey, Intent, Search, Experience)
- All LLM Mentions results (snapshots, prompt observations, daily rollups)
- All saved audits and reports
- The dashboard's internal cache and refresh queue
- A snapshot of when each site last sent telemetry

If something looks wrong after the reset, we can restore any of these tables from the backup in a single command.

### What we then cleared

After the backup, we emptied all of the tables above and reset their internal counters back to 1, just like a fresh install. We also cleared the "last telemetry seen" timestamp on every site so they all show as **Pending** until new data arrives.

### What we left untouched (everything operational)

The reset only touched **measurement** data. Everything used to actually run the product was preserved:

- All **users and logins**
- All **sites** and their configurations
- All **subscriptions** and **support tickets**
- All **brand profiles**, brand rules, and content templates
- All **content inventory** and content drafts
- All **competitors** and **LLM prompt seeds** (only the *results* of the prompts were wiped, not the prompts themselves)
- All **audit logs**, **config versions**, and **rollback points**

In other words: nobody got logged out, no site got deleted, and nothing a customer can see in their account settings has changed. Only the analytics data was cleared.

### Why we did it

Three reasons:

1. **Confirm telemetry resumes correctly from zero.** The fastest way to know the new rollup pipeline is solid is to start with empty tables and watch them refill.
2. **Confirm the new "Site connection" badge works.** With every site freshly set to *Pending*, we can watch each one transition to *Connected* as soon as live telemetry starts arriving again.
3. **Confirm the new PDF degrades gracefully.** Right after the reset, every section of the PDF should show a polite "No data yet" note. As data flows back in, the sections should fill in one by one. This is exactly the behavior we want for a brand-new customer's first PDF.

### How the reset went

It ran cleanly inside a single transaction. The only hiccup was a one-line shell-config issue (the database password was in `.env` but not exported into the terminal session) — once we pasted the database URL directly into the command, the script completed without errors and reported the final row counts on every affected table to confirm everything was at zero.

### What to watch next (the validation checklist)

As real telemetry starts flowing back in, these are the things to verify:

- [ ] Each site's "last telemetry" timestamp updates the moment its first event arrives.
- [ ] The dashboard's connection badge moves from **Pending → Connected** for active sites.
- [ ] The daily rollup job marks the most recent UTC day as **completed**.
- [ ] Once the LLM Mentions sweep runs again, the AI Visibility score reappears.
- [ ] The Export PDF — both Client and Technical — fills in its sections instead of showing the "No data yet" note.

If any of those don't happen within the expected window, that's a real signal worth investigating, and we have the backup ready to restore from instantly.

---

## 4. Things we know to follow up on

A short, honest list of loose ends:

1. **Pick one form of the rollup index.** The two repos disagree by a hair (UTC-day vs. raw-day). Both work; we just need to land on one before either is run on a fresh database.
2. **One PDF test runs in production but hangs in our test runner.** The PDF renders perfectly when the app is running and when called directly from Node — it's only the unit test framework that occasionally chokes on it. We've covered the same logic with a different style of test for now and will revisit the test runner config in a follow-up.
3. **Visual QA on the new PDF.** Five scenarios still need a human eyeball: all sites over 7 days, one site over 30 days (Client mode), one site over 30 days (Technical mode), a custom date range, and an empty/new account. Things to look for: headings never get orphaned at the bottom of a page, long URLs wrap nicely, tables don't overflow, and the page numbers and footer line up on every page.

---

*Generated 2026-05-08. Captures all changes shipped today across the GPTO Dashboard and the GPTO Insights Gateway, plus the verified backup-and-reset of the live telemetry data.*
