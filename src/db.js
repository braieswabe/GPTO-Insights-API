import postgres from 'postgres';
import { loadEnv } from './env.js';

loadEnv();

let sqlClient;

export function db() {
  if (!sqlClient) {
    const connectionString =
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.DATABASE_URL_UNPOOLED ||
      process.env.POSTGRES_URL_NON_POOLING;
    if (!connectionString) {
      throw new Error('DATABASE_URL or DATABASE_URL_UNPOOLED is required');
    }
    sqlClient = postgres(connectionString, {
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: 'require',
      prepare: false,
    });
  }
  return sqlClient;
}

export async function closeDb() {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = undefined;
  }
}
