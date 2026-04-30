import { loadEnv } from '../src/env.js';

loadEnv();

const required = ['DATABASE_URL', 'INTERNAL_API_TOKEN'];
const optional = ['DATABASE_URL_UNPOOLED', 'ALLOWED_ORIGINS', 'PORT', 'DASHBOARD_REFRESH_COOLDOWN_SECONDS'];

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
} else {
  console.log('\nAll required environment variables are set.');
}
