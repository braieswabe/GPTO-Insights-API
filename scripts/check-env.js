import { loadEnv } from '../src/env.js';
import { closeDb } from '../src/db.js';
import { checkRequiredTables, REQUIRED_TABLES } from '../src/data/schema.js';

loadEnv();

const required = ['DATABASE_URL', 'INTERNAL_API_TOKEN'];
const optional = [
  'DATABASE_URL_UNPOOLED',
  'ALLOWED_ORIGINS',
  'PORT',
  'DASHBOARD_REFRESH_COOLDOWN_SECONDS',
  'DATAFORSEO_AUTH_HEADER',
  'DATAFORSEO_LOGIN',
  'DATAFORSEO_PASSWORD',
];

let missing = 0;

console.log('--- Required ---');
for (const key of required) {
  const value = process.env[key];
  if (value) {
    console.log(`  ✓ ${key} = ${value.slice(0, 20)}...`);
  } else {
    console.log(`  ✗ ${key} is MISSING`);
    missing++;
  }
}

console.log('\n--- Optional ---');
for (const key of optional) {
  const value = process.env[key];
  console.log(`  ${value ? '✓' : '○'} ${key} = ${value || '(not set)'}`);
}

if (missing > 0) {
  console.log(`\n${missing} required variable(s) missing.`);
  process.exit(1);
}

console.log('\n--- Database Tables ---');
try {
  const result = await checkRequiredTables();
  for (const table of REQUIRED_TABLES) {
    console.log(`  ${result.missing.includes(table) ? '✗' : '✓'} ${table}`);
  }
  if (!result.ok) {
    console.log(`\nMissing required table(s): ${result.missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll required environment variables and database tables are set.');
  }
} finally {
  await closeDb();
}
