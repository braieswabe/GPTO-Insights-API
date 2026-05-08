/** Fresh telemetry + active portal config → connected. */
export const DEFAULT_CONNECTED_MS = 60 * 60 * 1000;
/** Beyond this age with no newer events → disconnected. */
export const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

function readThresholdMs(envKey, fallback) {
  const raw = typeof process !== 'undefined' && process.env?.[envKey];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getConnectionThresholds() {
  return {
    connectedMs: readThresholdMs('DASHBOARD_TELEMETRY_CONNECTED_MS', DEFAULT_CONNECTED_MS),
    staleMs: readThresholdMs('DASHBOARD_TELEMETRY_STALE_MS', DEFAULT_STALE_MS),
  };
}

/**
 * Derive live data connection from last telemetry receipt and portal config.
 * @param {Date | null} lastTelemetryAt
 * @param {boolean} hasActiveConfig
 * @param {Date} now
 * @param {{ connectedMs: number, staleMs: number }} [thresholds]
 * @returns {'connected'|'disconnected'|'stale'|'unknown'}
 */
export function deriveDataConnection(lastTelemetryAt, hasActiveConfig, now, thresholds = getConnectionThresholds()) {
  const { connectedMs, staleMs } = thresholds;
  if (staleMs < connectedMs) {
    return 'unknown';
  }

  if (!lastTelemetryAt) {
    if (hasActiveConfig) return 'stale';
    return 'disconnected';
  }

  const age = now.getTime() - lastTelemetryAt.getTime();
  if (age > staleMs) return 'disconnected';
  if (age <= connectedMs && hasActiveConfig) return 'connected';
  return 'stale';
}
