CREATE TABLE IF NOT EXISTS "site_score_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  "day" timestamp NOT NULL,
  "range_key" varchar(40) NOT NULL DEFAULT '7d',
  "window_start" timestamp NOT NULL,
  "window_end" timestamp NOT NULL,
  "model_version" varchar(80) NOT NULL DEFAULT 'gpto.visibility.v1',
  "scores" jsonb NOT NULL,
  "source_scores" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "issue_distribution" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "site_score_snapshots_unique_idx"
ON "site_score_snapshots" ("site_id", "range_key", "window_start", "window_end", "model_version");

CREATE INDEX IF NOT EXISTS "site_score_snapshots_site_day_idx"
ON "site_score_snapshots" ("site_id", "day" DESC);

CREATE INDEX IF NOT EXISTS "site_score_snapshots_model_idx"
ON "site_score_snapshots" ("model_version", "created_at" DESC);
