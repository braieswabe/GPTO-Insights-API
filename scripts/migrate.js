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
  const migrationPath = resolve(process.cwd(), 'migrations', '0001_init.sql');
  const migration = readFileSync(migrationPath, 'utf8');

  console.log('Running migration: 0001_init.sql');
  await sql.unsafe(migration);
  console.log('Migration complete.');
  await sql.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
