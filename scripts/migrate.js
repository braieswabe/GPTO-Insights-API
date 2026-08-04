import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { loadEnv } from '../src/env.js';

loadEnv();

const connectionString =
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL;

if (!connectionString) {
  console.error('No database connection string found.');
  process.exit(1);
}

const sql = postgres(connectionString, { ssl: 'require', max: 1 });

async function run() {
  const migrations = [
    '0001_init.sql',
    '0002_telemetry_daily_rollups.sql',
    '0003_sites_last_telemetry_at.sql',
    '0004_site_score_snapshots.sql',
    '0005_competitor_score_snapshots.sql',
    '0006_dataforseo_automation.sql',
    '0007_native_ai_mentions_automation.sql',
    '0008_dashboard_hourly_refresh.sql',
    '0009_automation_reliability.sql',
  ];
  for (const name of migrations) {
    const migrationPath = resolve(process.cwd(), 'migrations', name);
    const migration = readFileSync(migrationPath, 'utf8');
    console.log(`Running migration: ${name}`);
    await sql.unsafe(migration);
  }
  console.log('Migrations complete.');
  await sql.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
