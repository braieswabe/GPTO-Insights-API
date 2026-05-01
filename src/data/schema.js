import { db } from '../db.js';

export const REQUIRED_TABLES = [
  'sites',
  'dashboard_api_cache',
  'dashboard_refresh_jobs',
  'dashboard_rollups_daily',
  'authority_signals',
  'confusion_signals',
  'coverage_signals',
  'telemetry_events',
  'llm_mentions_snapshots',
  'llm_mentions_tracked_prompts',
  'llm_mentions_prompt_observations',
  'llm_mentions_rollups_daily',
];

export async function readExistingTables(tableNames = REQUIRED_TABLES) {
  const sql = db();
  const rows = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY(${tableNames}::text[])
  `;
  return new Set(rows.map((row) => row.table_name));
}

export async function checkRequiredTables(tableNames = REQUIRED_TABLES) {
  const existing = await readExistingTables(tableNames);
  const missing = tableNames.filter((table) => !existing.has(table));
  return {
    ok: missing.length === 0,
    missing,
    existing: Array.from(existing).sort(),
    required: [...tableNames],
  };
}
