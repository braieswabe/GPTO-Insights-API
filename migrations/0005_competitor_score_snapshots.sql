ALTER TABLE competitors
ADD COLUMN IF NOT EXISTS status varchar(40) NOT NULL DEFAULT 'active',
ADD COLUMN IF NOT EXISTS color_key varchar(40),
ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS last_assessed_at timestamp,
ADD COLUMN IF NOT EXISTS last_error text,
ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS competitors_site_domain_unique_idx
ON competitors (site_id, domain);

CREATE INDEX IF NOT EXISTS competitors_site_status_idx
ON competitors (site_id, status, created_at);

CREATE TABLE IF NOT EXISTS competitor_score_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  site_id uuid NOT NULL REFERENCES sites(id),
  competitor_id uuid NOT NULL REFERENCES competitors(id),
  competitor_domain varchar(255) NOT NULL,
  day timestamp NOT NULL,
  range_key varchar(40) NOT NULL DEFAULT '30d',
  window_start timestamp NOT NULL,
  window_end timestamp NOT NULL,
  model_version varchar(80) NOT NULL DEFAULT 'gpto.competitor_visibility.v1',
  scores jsonb NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  issue_distribution jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  freshness jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS competitor_score_snapshots_unique_idx
ON competitor_score_snapshots (site_id, competitor_id, range_key, window_start, window_end, model_version);

CREATE INDEX IF NOT EXISTS competitor_score_snapshots_site_range_idx
ON competitor_score_snapshots (site_id, range_key, day DESC);

CREATE INDEX IF NOT EXISTS competitor_score_snapshots_competitor_day_idx
ON competitor_score_snapshots (competitor_id, day DESC);
