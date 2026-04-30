import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(file = '.env') {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}
